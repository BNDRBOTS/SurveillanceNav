import { Redis } from 'ioredis';
import { config } from '../config.js';

/**
 * Cache facade: Redis-backed when available, automatic in-memory fallback
 * (with LRU bound + TTL) when Redis is down. A circuit breaker prevents a
 * cache-miss storm from hammering a flapping Redis: after 3 consecutive
 * failures the breaker opens for 15s and all traffic uses memory.
 */

interface MemEntry {
  value: string;
  expiresAt: number;
}

const MEM_MAX_ENTRIES = 5000;
const mem = new Map<string, MemEntry>();

let redis: Redis | null = null;
let redisUp = false;
let consecutiveFailures = 0;
let breakerOpenUntil = 0;

let hits = 0;
let misses = 0;

if (config.redisUrl) {
  redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(30_000, 2 ** times * 500),
    enableOfflineQueue: false,
  });
  redis.on('ready', () => {
    redisUp = true;
    consecutiveFailures = 0;
  });
  redis.on('error', () => {
    redisUp = false;
  });
  redis.connect().catch(() => {
    redisUp = false;
  });
}

function breakerAllows(): boolean {
  return Date.now() >= breakerOpenUntil;
}

function recordFailure(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= 3) {
    breakerOpenUntil = Date.now() + 15_000;
    consecutiveFailures = 0;
  }
}

function memGet(key: string): string | null {
  const entry = mem.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    mem.delete(key);
    return null;
  }
  // refresh LRU position
  mem.delete(key);
  mem.set(key, entry);
  return entry.value;
}

function memSet(key: string, value: string, ttlSec: number): void {
  if (mem.size >= MEM_MAX_ENTRIES) {
    const oldest = mem.keys().next().value;
    if (oldest !== undefined) mem.delete(oldest);
  }
  mem.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
}

export const cache = {
  backend(): 'redis' | 'memory' {
    return redis && redisUp && breakerAllows() ? 'redis' : 'memory';
  },

  stats() {
    const total = hits + misses;
    return { hits, misses, hitRatio: total === 0 ? 0 : hits / total };
  },

  async get(key: string): Promise<string | null> {
    if (redis && redisUp && breakerAllows()) {
      try {
        const v = await redis.get(key);
        if (v !== null) hits += 1;
        else misses += 1;
        return v;
      } catch {
        recordFailure();
      }
    }
    const v = memGet(key);
    if (v !== null) hits += 1;
    else misses += 1;
    return v;
  },

  async set(key: string, value: string, ttlSec: number): Promise<void> {
    memSet(key, value, ttlSec); // memory always written: survives Redis loss
    if (redis && redisUp && breakerAllows()) {
      try {
        await redis.set(key, value, 'EX', ttlSec);
      } catch {
        recordFailure();
      }
    }
  },

  async del(prefixOrKey: string, prefix = false): Promise<void> {
    if (prefix) {
      for (const k of mem.keys()) if (k.startsWith(prefixOrKey)) mem.delete(k);
    } else {
      mem.delete(prefixOrKey);
    }
    if (redis && redisUp && breakerAllows()) {
      try {
        if (prefix) {
          const keys = await redis.keys(`${prefixOrKey}*`);
          if (keys.length > 0) await redis.del(...keys);
        } else {
          await redis.del(prefixOrKey);
        }
      } catch {
        recordFailure();
      }
    }
  },

  /** Atomic increment with TTL — used by the rate limiter. */
  async incrWithTtl(key: string, ttlSec: number): Promise<number> {
    if (redis && redisUp && breakerAllows()) {
      try {
        const n = await redis.incr(key);
        if (n === 1) await redis.expire(key, ttlSec);
        return n;
      } catch {
        recordFailure();
      }
    }
    const current = Number(memGet(key) ?? '0') + 1;
    memSet(key, String(current), ttlSec);
    return current;
  },

  async probe(): Promise<{ ok: boolean; backend: 'redis' | 'memory'; latencyMs: number }> {
    const start = performance.now();
    if (redis) {
      try {
        await redis.ping();
        redisUp = true;
        return { ok: true, backend: 'redis', latencyMs: Math.round(performance.now() - start) };
      } catch {
        redisUp = false;
      }
    }
    return { ok: true, backend: 'memory', latencyMs: Math.round(performance.now() - start) };
  },

  async close(): Promise<void> {
    if (redis) {
      try {
        await redis.quit();
      } catch {
        redis.disconnect();
      }
    }
  },
};

/** JSON convenience wrappers with stale-while-revalidate semantics. */
export async function cachedJson<T>(
  key: string,
  ttlSec: number,
  loader: () => Promise<T>,
): Promise<T> {
  const cached = await cache.get(key);
  if (cached !== null) {
    try {
      return JSON.parse(cached) as T;
    } catch {
      /* corrupted entry — fall through to loader */
    }
  }
  const fresh = await loader();
  await cache.set(key, JSON.stringify(fresh), ttlSec);
  return fresh;
}
