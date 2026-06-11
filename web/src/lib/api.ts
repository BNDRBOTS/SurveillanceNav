import { API_PREFIX } from '@stn/shared';
import { enqueueOutbox } from './offline';

/**
 * API client:
 *  - bearer token from the auth store (memory only — never localStorage)
 *  - single-flight refresh on 401, then one retry of the original request
 *  - bounded exponential-backoff retry for GETs on network/5xx failures
 *  - friendly ApiError carrying the server envelope (code/message/details)
 *  - mutation queueing when offline: POSTs flagged `queueable` are stored in
 *    the IndexedDB outbox with an Idempotency-Key and replayed on reconnect
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    public retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class OfflineQueuedError extends Error {
  constructor(public idempotencyKey: string) {
    super('You appear to be offline — this submission was queued and will sync automatically.');
    this.name = 'OfflineQueuedError';
  }
}

let accessToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}
export function getAccessToken(): string | null {
  return accessToken;
}
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : null;
}

let refreshInFlight: Promise<boolean> | null = null;

/** Single-flight session refresh. Returns true when a new token was issued. */
export async function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const csrf = readCookie('stn_csrf');
        if (!csrf) return false;
        const res = await fetch(`${API_PREFIX}/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'x-csrf-token': csrf },
        });
        if (!res.ok) return false;
        const body = (await res.json()) as { accessToken: string };
        accessToken = body.accessToken;
        window.dispatchEvent(new CustomEvent('stn:session-refreshed', { detail: body }));
        return true;
      } catch {
        return false;
      } finally {
        setTimeout(() => {
          refreshInFlight = null;
        }, 50);
      }
    })();
  }
  return refreshInFlight;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  formData?: FormData;
  signal?: AbortSignal;
  /** Queue this POST offline instead of failing (default false). */
  queueable?: boolean;
  /** Explicit idempotency key (auto-generated for queued requests). */
  idempotencyKey?: string;
  retries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rawFetch(path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  let body: BodyInit | undefined;
  if (opts.formData) {
    body = opts.formData;
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  return fetch(`${API_PREFIX}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body,
    signal: opts.signal,
    credentials: 'include',
  });
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const maxRetries = opts.retries ?? (method === 'GET' ? 2 : 0);
  let attempt = 0;
  let triedRefresh = false;

  // Offline fast-path for queueable mutations.
  if (method === 'POST' && opts.queueable && !navigator.onLine) {
    const key = opts.idempotencyKey ?? crypto.randomUUID();
    await enqueueOutbox({ path, body: opts.body, idempotencyKey: key });
    throw new OfflineQueuedError(key);
  }

   
  while (true) {
    let res: Response;
    try {
      res = await rawFetch(path, opts);
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      if (method === 'POST' && opts.queueable) {
        const key = opts.idempotencyKey ?? crypto.randomUUID();
        await enqueueOutbox({ path, body: opts.body, idempotencyKey: key });
        throw new OfflineQueuedError(key);
      }
      if (attempt < maxRetries) {
        attempt += 1;
        await sleep(300 * 2 ** attempt);
        continue;
      }
      throw new ApiError(0, 'network', 'Network unreachable — check your connection and retry.');
    }

    if (res.status === 401 && !triedRefresh && !path.startsWith('/auth/')) {
      triedRefresh = true;
      if (await refreshSession()) continue;
      onUnauthorized?.();
    }

    if (res.status === 503 && method === 'GET' && attempt < maxRetries) {
      attempt += 1;
      await sleep(500 * 2 ** attempt);
      continue;
    }

    if (!res.ok) {
      let envelope: { error?: { code?: string; message?: string; details?: unknown; retryAfterSec?: number } } = {};
      try {
        envelope = await res.json();
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(
        res.status,
        envelope.error?.code ?? `http_${res.status}`,
        envelope.error?.message ?? `Request failed (${res.status})`,
        envelope.error?.details,
        envelope.error?.retryAfterSec,
      );
    }

    if (res.status === 204) return undefined as T;
    const data = (await res.json()) as T & { __stale?: boolean };
    if (res.headers.get('X-Data-Stale') === 'true' || res.headers.get('X-From-SW-Cache') === 'true') {
      window.dispatchEvent(new CustomEvent('stn:data-stale'));
    }
    return data;
  }
}

export const get = <T>(path: string, signal?: AbortSignal) => api<T>(path, { signal });
export const post = <T>(path: string, body?: unknown, opts: Partial<RequestOptions> = {}) =>
  api<T>(path, { method: 'POST', body, ...opts });
export const patch = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body });
export const put = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

export async function uploadFile<T>(path: string, file: File, extraFields: Record<string, string> = {}): Promise<T> {
  const formData = new FormData();
  for (const [k, v] of Object.entries(extraFields)) formData.append(k, v);
  formData.append('file', file);
  return api<T>(path, { method: 'POST', formData });
}
