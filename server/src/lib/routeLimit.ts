import { cache } from '../cache/index.js';
import { tooManyRequests } from './errors.js';

/**
 * Per-route rate limiting on top of the global plugin: individual endpoints
 * (anonymous error reports, comment posting) need tighter budgets than the
 * app-wide bucket. Uses the same cache primitive, so it degrades to
 * in-memory counting when Redis is down — never open, never crashing.
 */
export async function assertRouteLimit(key: string, max: number, windowSec: number): Promise<void> {
  const count = await cache.incrWithTtl(`rl:${key}`, windowSec);
  if (count > max) throw tooManyRequests(windowSec);
}
