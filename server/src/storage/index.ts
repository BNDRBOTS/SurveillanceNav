import fs from 'node:fs';
import path from 'node:path';
import { createHmac, createHash } from 'node:crypto';
import { config } from '../config.js';

/**
 * Object storage abstraction.
 *  - local: filesystem under STORAGE_LOCAL_DIR (default dev backend)
 *  - s3: any S3-compatible store (MinIO, AWS S3) via hand-rolled SigV4 —
 *    no SDK dependency, supports put/get/delete/exists.
 * Keys are namespaced ("evidence/", "foia/", "exports/", "backups/",
 * "quarantine/", "archive/") and validated against traversal.
 */

export interface StorageBackend {
  name: string;
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  probe(): Promise<{ ok: boolean; detail?: string }>;
}

const SAFE_KEY = /^[a-zA-Z0-9_\-./]{1,400}$/;

export function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes('..') || key.startsWith('/')) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}

class LocalStorage implements StorageBackend {
  name = 'local';
  constructor(private root: string) {
    fs.mkdirSync(root, { recursive: true });
  }
  private resolve(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root))) throw new Error('Path traversal blocked');
    return full;
  }
  async put(key: string, data: Buffer): Promise<void> {
    const full = this.resolve(key);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    // write-then-rename for atomicity (no partial reads on crash)
    const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, full);
  }
  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.promises.readFile(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
  async delete(key: string): Promise<void> {
    try {
      await fs.promises.unlink(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  async exists(key: string): Promise<boolean> {
    try {
      await fs.promises.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }
  async probe(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const probeKey = '.probe';
      await this.put(probeKey, Buffer.from('ok'));
      await this.delete(probeKey);
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}

/* ------------------------- S3 (SigV4, no SDK) ------------------------- */

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}
function sha256hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

class S3Storage implements StorageBackend {
  name = 's3';
  constructor(
    private opts: {
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
    },
  ) {}

  private url(key: string): URL {
    assertSafeKey(key);
    const base = this.opts.endpoint || `https://s3.${this.opts.region}.amazonaws.com`;
    return this.opts.forcePathStyle
      ? new URL(`${base.replace(/\/$/, '')}/${this.opts.bucket}/${key}`)
      : new URL(`https://${this.opts.bucket}.${base.replace(/^https?:\/\//, '')}/${key}`);
  }

  private async request(
    method: 'GET' | 'PUT' | 'DELETE' | 'HEAD',
    key: string,
    body?: Buffer,
    contentType?: string,
  ): Promise<Response> {
    const url = this.url(key);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256hex(body ?? Buffer.alloc(0));

    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
    };
    if (contentType) headers['content-type'] = contentType;

    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h]}\n`).join('');
    const signedHeaders = signedHeaderNames.join(';');
    const canonicalRequest = [
      method,
      url.pathname,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${this.opts.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
    const kDate = hmac(`AWS4${this.opts.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, this.opts.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.opts.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const { host: _host, ...sendHeaders } = headers;

    return fetch(url, {
      method,
      headers: sendHeaders,
      body: body ? new Uint8Array(body) : undefined,
    });
  }

  async put(key: string, data: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    const res = await this.request('PUT', key, data, contentType);
    if (!res.ok) throw new Error(`S3 put failed: ${res.status} ${await res.text()}`);
  }
  async get(key: string): Promise<Buffer | null> {
    const res = await this.request('GET', key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 get failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  async delete(key: string): Promise<void> {
    const res = await this.request('DELETE', key);
    if (!res.ok && res.status !== 404) throw new Error(`S3 delete failed: ${res.status}`);
  }
  async exists(key: string): Promise<boolean> {
    const res = await this.request('HEAD', key);
    return res.ok;
  }
  async probe(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const key = `.probe-${Date.now()}`;
      await this.put(key, Buffer.from('ok'), 'text/plain');
      await this.delete(key);
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}

export const storage: StorageBackend =
  config.storageBackend === 's3'
    ? new S3Storage(config.s3)
    : new LocalStorage(config.storageLocalDir);

export function evidenceKey(assetId: string, fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return `evidence/${assetId}/${Date.now()}-${safe}`;
}
export function foiaDocKey(requestId: string, fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return `foia/${requestId}/${Date.now()}-${safe}`;
}
export function exportKey(id: string, format: string): string {
  return `exports/${id}.${format}`;
}
export function quarantineKey(originalKey: string): string {
  return `quarantine/${originalKey.replace(/\//g, '__')}`;
}
