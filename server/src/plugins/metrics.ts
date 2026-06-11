import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { config } from '../config.js';

/**
 * Request observability:
 *  - in-memory rolling 60-minute window (per-minute buckets) powering
 *    /admin/metrics with request counts, error rate and p95 latency
 *  - durable hour-bucket aggregates flushed to request_metrics every 30s
 *    (batched; a DB outage only loses the in-flight batch, never requests)
 */

interface MinuteBucket {
  minute: number;
  count: number;
  errors: number;
  samples: number[]; // bounded latency samples for p95
}

const WINDOW_MIN = 60;
const buckets = new Map<number, MinuteBucket>();

interface PendingAgg {
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}
const pendingDb = new Map<string, PendingAgg>();

let flushTimer: ReturnType<typeof setInterval> | null = null;

function record(route: string, statusCode: number, ms: number): void {
  const minute = Math.floor(Date.now() / 60_000);
  let b = buckets.get(minute);
  if (!b) {
    b = { minute, count: 0, errors: 0, samples: [] };
    buckets.set(minute, b);
    for (const key of buckets.keys()) {
      if (key < minute - WINDOW_MIN) buckets.delete(key);
    }
  }
  b.count += 1;
  if (statusCode >= 500) b.errors += 1;
  if (b.samples.length < 500) b.samples.push(ms);

  const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
  const key = `${hour}|${route}`;
  const agg = pendingDb.get(key) ?? { count: 0, errors: 0, totalMs: 0, maxMs: 0 };
  agg.count += 1;
  if (statusCode >= 500) agg.errors += 1;
  agg.totalMs += Math.round(ms);
  agg.maxMs = Math.max(agg.maxMs, Math.round(ms));
  pendingDb.set(key, agg);
}

async function flushToDb(): Promise<void> {
  if (pendingDb.size === 0) return;
  const entries = [...pendingDb.entries()];
  pendingDb.clear();
  try {
    for (const [key, agg] of entries) {
      const [bucket, route] = key.split('|') as [string, string];
      await query(
        `INSERT INTO request_metrics (bucket, route, count, errors, total_ms, max_ms)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (bucket, route) DO UPDATE SET
           count = request_metrics.count + EXCLUDED.count,
           errors = request_metrics.errors + EXCLUDED.errors,
           total_ms = request_metrics.total_ms + EXCLUDED.total_ms,
           max_ms = GREATEST(request_metrics.max_ms, EXCLUDED.max_ms)`,
        [bucket, route, agg.count, agg.errors, agg.totalMs, agg.maxMs],
      );
    }
  } catch {
    // DB unavailable — restore the batch so it flushes on recovery (bounded)
    if (pendingDb.size < 2_000) {
      for (const [k, v] of entries) pendingDb.set(k, v);
    }
  }
}

export function metricsSnapshot() {
  const now = Math.floor(Date.now() / 60_000);
  let count = 0;
  let errors = 0;
  const samples: number[] = [];
  for (const [minute, b] of buckets) {
    if (minute >= now - WINDOW_MIN) {
      count += b.count;
      errors += b.errors;
      samples.push(...b.samples);
    }
  }
  samples.sort((a, b) => a - b);
  const p95 = samples.length === 0 ? 0 : samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))]!;
  return {
    requestsLastHour: count,
    errorRateLastHour: count === 0 ? 0 : errors / count,
    p95LatencyMs: Math.round(p95),
  };
}

export function registerMetrics(app: FastifyInstance): void {
  app.addHook('onResponse', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const route = `${req.method} ${(req.routeOptions?.url ?? req.url.split('?')[0] ?? '').slice(0, 120)}`;
    record(route, reply.statusCode, reply.elapsedTime);
  });

  if (!config.isTest) {
    flushTimer = setInterval(() => void flushToDb(), 30_000);
    flushTimer.unref();
  }

  app.addHook('onClose', async () => {
    if (flushTimer) clearInterval(flushTimer);
    await flushToDb();
  });
}
