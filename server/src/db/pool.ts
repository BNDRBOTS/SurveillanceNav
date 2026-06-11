import pg from 'pg';
import { config } from '../config.js';

/**
 * PostgreSQL pool with:
 *  - typed query helper
 *  - transaction helper with automatic rollback
 *  - health probe + degraded-mode flag the routes consult for fallbacks
 *  - bounded exponential-backoff retry for transient connection errors
 */

const { Pool } = pg;

// Return BIGINT/NUMERIC as numbers where safe for this schema (counts, amounts).
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'stn-server',
});

let dbHealthy = true;
let lastError: string | null = null;

pool.on('error', (err) => {
  dbHealthy = false;
  lastError = err.message;
});

export function isDbHealthy(): boolean {
  return dbHealthy;
}
export function dbLastError(): string | null {
  return lastError;
}

const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '08006', // connection_failure
  '08001', // unable to connect
]);

function isTransient(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code !== undefined && TRANSIENT_CODES.has(code);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/** Query with bounded retry on transient failures (3 attempts: 0ms, 250ms, 1s). */
export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  let attempt = 0;
   
  while (true) {
    try {
      const res = await pool.query(text, params as never[]);
      dbHealthy = true;
      return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
    } catch (err) {
      if (isTransient(err) && attempt < 2) {
        attempt += 1;
        dbHealthy = false;
        lastError = (err as Error).message;
        await sleep(attempt === 1 ? 250 : 1000);
        continue;
      }
      if (isTransient(err)) {
        dbHealthy = false;
        lastError = (err as Error).message;
      }
      throw err;
    }
  }
}

export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const res = await query<T>(text, params);
  return res.rows[0] ?? null;
}

/** Run `fn` inside a transaction; rolls back on any throw. */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already broken — release handles it */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function probeDb(): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
  const start = performance.now();
  try {
    await pool.query('SELECT 1');
    dbHealthy = true;
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    dbHealthy = false;
    lastError = (err as Error).message;
    return { ok: false, latencyMs: Math.round(performance.now() - start), detail: lastError ?? undefined };
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
