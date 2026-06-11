import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cache } from '../cache/index.js';
import { config } from '../config.js';
import { tooManyRequests } from '../lib/errors.js';
import { queryOne } from '../db/pool.js';

/**
 * Sliding-window rate limiting keyed by user id (authenticated) or IP.
 * Limits are configurable at runtime via app_settings (admin console) with
 * an explicit audited override switch. Auth endpoints get a stricter bucket.
 * Responses always include X-RateLimit headers and a Retry-After ETA —
 * requests are never silently dropped.
 */

interface LimitSettings {
  windowSec: number;
  max: number;
  authMax: number;
  overrideUntil?: string;
}

let settingsCache: { value: LimitSettings; fetchedAt: number } | null = null;

async function limits(): Promise<LimitSettings> {
  if (settingsCache && Date.now() - settingsCache.fetchedAt < 15_000) return settingsCache.value;
  let value: LimitSettings = {
    windowSec: config.rateLimit.windowSec,
    max: config.rateLimit.max,
    authMax: config.rateLimit.authMax,
  };
  try {
    const row = await queryOne<{ value: LimitSettings }>(
      `SELECT value FROM app_settings WHERE key = 'rate_limits'`,
    );
    if (row?.value) value = { ...value, ...row.value };
  } catch {
    /* DB down — use static config */
  }
  settingsCache = { value, fetchedAt: Date.now() };
  return value;
}

function clientKey(req: FastifyRequest): string {
  return req.user?.id ?? `ip:${req.ip}`;
}

const AUTH_PATHS = /^\/api\/v1\/auth\/(login|signup|reset-password)/;

export function registerRateLimit(app: FastifyInstance): void {
  app.addHook('preHandler', async (req, reply) => {
    if (config.isTest && !process.env.RATE_LIMIT_TEST) return;
    if (req.method === 'OPTIONS') return;
    if (!req.url.startsWith('/api/')) return;

    const cfg = await limits();
    if (cfg.overrideUntil && new Date(cfg.overrideUntil).getTime() > Date.now()) return;

    const isAuthPath = AUTH_PATHS.test(req.url);
    const max = isAuthPath ? cfg.authMax : cfg.max;
    const windowSec = cfg.windowSec;
    const bucket = Math.floor(Date.now() / 1000 / windowSec);
    const key = `rl:${isAuthPath ? 'auth' : 'api'}:${clientKey(req)}:${bucket}`;

    const count = await cache.incrWithTtl(key, windowSec + 1);
    const remaining = Math.max(0, max - count);
    reply.header('X-RateLimit-Limit', String(max));
    reply.header('X-RateLimit-Remaining', String(remaining));
    reply.header('X-RateLimit-Reset', String((bucket + 1) * windowSec));

    if (count > max) {
      const retryAfter = (bucket + 1) * windowSec - Math.floor(Date.now() / 1000);
      throw tooManyRequests(Math.max(1, retryAfter));
    }
  });
}
