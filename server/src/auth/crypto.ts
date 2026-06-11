import {
  scrypt,
  randomBytes,
  timingSafeEqual,
  createHmac,
  createHash,
} from 'node:crypto';

/**
 * Zero-dependency, auditable implementations of the platform's crypto
 * primitives, all built on node:crypto:
 *   - scrypt password hashing (N=2^15, r=8, p=1, 32-byte key, per-hash salt)
 *   - HS256 JWT sign/verify with constant-time signature comparison
 *   - RFC 6238 TOTP (SHA-1, 6 digits, 30s step, ±1 window)
 *   - HMAC-signed short-TTL download URLs
 */

const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 32;
// 128·N·r bytes are required; Node's default maxmem (32MiB) is exactly the
// requirement and the check is strict-greater, so give explicit headroom.
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, nStr, rStr, pStr, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt' || !nStr || !rStr || !pStr || !saltB64 || !hashB64) return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await new Promise<Buffer>((resolve, reject) =>
      scrypt(
        password,
        salt,
        expected.length,
        { N: Number(nStr), r: Number(rStr), p: Number(pStr), maxmem: 128 * Number(nStr) * Number(rStr) * 2 },
        (err, key) => (err ? reject(err) : resolve(key)),
      ),
    );
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------- JWT */

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString('base64url');

export interface JwtPayload {
  sub: string;
  role: string;
  typ: 'access' | 'mfa_setup';
  iat: number;
  exp: number;
  jti?: string;
}

export function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp'>,
  secret: string,
  ttlSec: number,
): string {
  const now = Math.floor(Date.now() / 1000);
  const full: JwtPayload = { ...payload, iat: now, exp: now + ttlSec };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(full));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const headerObj = JSON.parse(Buffer.from(header, 'base64url').toString()) as { alg?: string };
    if (headerObj.alg !== 'HS256') return null; // alg confusion guard
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as JwtPayload;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- TOTP (RFC 6238) */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str: string): Buffer {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
  const code =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    ((hmac[offset + 1] ?? 0) << 16) |
    ((hmac[offset + 2] ?? 0) << 8) |
    (hmac[offset + 3] ?? 0);
  return String(code % 1_000_000).padStart(6, '0');
}

export function totpCode(secretBase32: string, atMs = Date.now()): string {
  return hotp(base32Decode(secretBase32), Math.floor(atMs / 1000 / 30));
}

export function verifyTotp(secretBase32: string, code: string, atMs = Date.now()): boolean {
  const cleaned = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  const counter = Math.floor(atMs / 1000 / 30);
  const secret = base32Decode(secretBase32);
  for (const drift of [-1, 0, 1]) {
    const expected = hotp(secret, counter + drift);
    if (
      expected.length === cleaned.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(cleaned))
    ) {
      return true;
    }
  }
  return false;
}

export function totpUri(secretBase32: string, email: string, issuer = 'Lens of Light STN'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/* ----------------------------------------------------------------- tokens & signing */

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Sign a download path with expiry: returns query suffix `exp=...&sig=...`. */
export function signDownload(fileKey: string, secret: string, ttlSec: number): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = createHmac('sha256', secret).update(`${fileKey}:${exp}`).digest('base64url');
  return `exp=${exp}&sig=${sig}`;
}

export function verifyDownload(fileKey: string, exp: string, sig: string, secret: string): boolean {
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Math.floor(Date.now() / 1000)) return false;
  const expected = createHmac('sha256', secret).update(`${fileKey}:${expNum}`).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(sig, 'base64url');
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
