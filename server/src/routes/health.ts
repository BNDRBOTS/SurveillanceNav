import type { FastifyInstance } from 'fastify';
import { probeDb } from '../db/pool.js';
import { cache } from '../cache/index.js';
import { storage } from '../storage/index.js';
import { config } from '../config.js';
import type { HealthReport } from '@stn/shared';

const bootedAt = Date.now();

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health/live', async () => ({ status: 'ok', version: config.version }));

  app.get('/health/ready', async (req, reply) => {
    const [db, cacheRes, storageRes] = await Promise.all([probeDb(), cache.probe(), storage.probe()]);
    const checks: HealthReport['checks'] = {
      database: { ok: db.ok, latencyMs: db.latencyMs, ...(db.detail ? { detail: db.detail } : {}) },
      cache: { ok: cacheRes.ok, latencyMs: cacheRes.latencyMs, detail: `backend=${cacheRes.backend}` },
      storage: { ok: storageRes.ok, ...(storageRes.detail ? { detail: storageRes.detail } : {}) },
    };
    const allOk = Object.values(checks).every((c) => c.ok);
    const dbOk = checks.database?.ok ?? false;
    const report: HealthReport = {
      status: allOk ? 'ok' : dbOk ? 'degraded' : 'down',
      checks,
      version: config.version,
      uptimeSec: Math.round((Date.now() - bootedAt) / 1000),
    };
    return reply.status(dbOk ? 200 : 503).send(report);
  });
}
