import type { FastifyInstance } from 'fastify';
import { queryOne, query } from '../db/pool.js';

/**
 * Idempotency-Key support for mutating endpoints. The offline sync queue on
 * the client attaches a key to every queued POST; replays (double-taps,
 * reconnect retries, background-sync re-fires) return the original response
 * instead of duplicating records. Keys are scoped per user and pruned by the
 * retention job after 48h.
 */
export function registerIdempotency(app: FastifyInstance): void {
  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'POST' || !req.user) return;
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 200) return;

    const existing = await queryOne<{ status_code: number | null; response: unknown }>(
      `SELECT status_code, response FROM idempotency_keys WHERE key = $1 AND user_id = $2`,
      [key, req.user.id],
    );
    if (existing?.status_code) {
      reply.header('X-Idempotent-Replay', 'true');
      return reply.status(existing.status_code).send(existing.response);
    }
    if (!existing) {
      await query(
        `INSERT INTO idempotency_keys (key, user_id, method, path) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [key, req.user.id, req.method, req.url.slice(0, 300)],
      );
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (req.method !== 'POST' || !req.user) return payload;
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 200) return payload;
    if (reply.getHeader('X-Idempotent-Replay')) return payload;
    if (reply.statusCode >= 500) return payload; // do not memoize server faults
    let body: unknown = null;
    if (typeof payload === 'string' && payload.length < 100_000) {
      try {
        body = JSON.parse(payload);
      } catch {
        body = null;
      }
    }
    await query(
      `UPDATE idempotency_keys SET status_code = $3, response = $4 WHERE key = $1 AND user_id = $2`,
      [key, req.user.id, reply.statusCode, body === null ? null : JSON.stringify(body)],
    ).catch(() => undefined);
    return payload;
  });
}
