/**
 * Offline layer (IndexedDB):
 *  - outbox: queued POST mutations with idempotency keys, replayed on
 *    reconnect (conflict-safe — the server deduplicates by key)
 *  - datasets: cached map/asset payloads with SHA-256 integrity checksums,
 *    verified on restore; corrupted entries are discarded, never rendered
 */

const DB_NAME = 'stn-offline';
const DB_VERSION = 1;

interface OutboxEntry {
  id: string;
  path: string;
  body: unknown;
  idempotencyKey: string;
  queuedAt: number;
  attempts: number;
}

interface DatasetEntry {
  key: string;
  json: string;
  checksum: string;
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('datasets')) db.createObjectStore('datasets', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(storeName: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const req = fn(transaction.objectStore(storeName));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------- outbox ------------------------------- */

export async function enqueueOutbox(entry: { path: string; body: unknown; idempotencyKey: string }): Promise<void> {
  const full: OutboxEntry = {
    id: crypto.randomUUID(),
    ...entry,
    queuedAt: Date.now(),
    attempts: 0,
  };
  await tx('outbox', 'readwrite', (s) => s.put(full));
  window.dispatchEvent(new CustomEvent('stn:outbox-changed'));
}

export async function outboxCount(): Promise<number> {
  try {
    return await tx<number>('outbox', 'readonly', (s) => s.count());
  } catch {
    return 0;
  }
}

export async function listOutbox(): Promise<OutboxEntry[]> {
  try {
    return await tx<OutboxEntry[]>('outbox', 'readonly', (s) => s.getAll() as IDBRequest<OutboxEntry[]>);
  } catch {
    return [];
  }
}

/**
 * Replay queued mutations. Each entry retries up to 5 times; permanent
 * client errors (4xx other than 408/429) drop the entry with a notification
 * event rather than blocking the queue.
 */
export async function flushOutbox(
  send: (path: string, body: unknown, idempotencyKey: string) => Promise<void>,
): Promise<{ sent: number; failed: number; dropped: number }> {
  const entries = await listOutbox();
  let sent = 0;
  let failed = 0;
  let dropped = 0;
  for (const entry of entries.sort((a, b) => a.queuedAt - b.queuedAt)) {
    try {
      await send(entry.path, entry.body, entry.idempotencyKey);
      await tx('outbox', 'readwrite', (s) => s.delete(entry.id));
      sent += 1;
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0;
      const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (permanent || entry.attempts >= 4) {
        await tx('outbox', 'readwrite', (s) => s.delete(entry.id));
        dropped += 1;
        window.dispatchEvent(
          new CustomEvent('stn:outbox-dropped', { detail: { path: entry.path, reason: (err as Error).message } }),
        );
      } else {
        entry.attempts += 1;
        await tx('outbox', 'readwrite', (s) => s.put(entry));
        failed += 1;
      }
    }
  }
  window.dispatchEvent(new CustomEvent('stn:outbox-changed'));
  return { sent, failed, dropped };
}

/* ------------------------------ datasets ------------------------------ */

export async function cacheDataset(key: string, data: unknown): Promise<void> {
  try {
    const json = JSON.stringify(data);
    const entry: DatasetEntry = { key, json, checksum: await sha256(json), savedAt: Date.now() };
    await tx('datasets', 'readwrite', (s) => s.put(entry));
  } catch {
    /* quota exceeded or private mode — cache is best-effort */
  }
}

export async function restoreDataset<T>(key: string, maxAgeMs = 7 * 86_400_000): Promise<{ data: T; savedAt: number } | null> {
  try {
    const entry = await tx<DatasetEntry | undefined>('datasets', 'readonly', (s) => s.get(key) as IDBRequest<DatasetEntry | undefined>);
    if (!entry) return null;
    if (Date.now() - entry.savedAt > maxAgeMs) return null;
    if ((await sha256(entry.json)) !== entry.checksum) {
      // integrity failure: discard silently and report
      await tx('datasets', 'readwrite', (s) => s.delete(key));
      window.dispatchEvent(new CustomEvent('stn:cache-corrupt', { detail: { key } }));
      return null;
    }
    return { data: JSON.parse(entry.json) as T, savedAt: entry.savedAt };
  } catch {
    return null;
  }
}

export async function clearDatasets(): Promise<void> {
  try {
    await tx('datasets', 'readwrite', (s) => s.clear());
  } catch {
    /* ignore */
  }
}
