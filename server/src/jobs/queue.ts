import { hostname } from 'node:os';
import { query, queryOne } from '../db/pool.js';
import { config } from '../config.js';

/**
 * Durable DB-backed job queue (chosen over BullMQ so jobs survive Redis
 * loss and admins can retry/inspect them — see docs/ARCHITECTURE notes).
 *  - claim via FOR UPDATE SKIP LOCKED (safe across multiple workers)
 *  - exponential backoff retries (30s · 2^attempt, max 1h) up to max_attempts
 *  - stale "running" jobs (worker died) are re-queued by the scheduler tick
 *  - failures alert admins via notifications; jobs are never silently lost
 */

export type JobHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown> | void>;

const handlers = new Map<string, JobHandler>();
const workerId = `${hostname()}:${process.pid}`;

export function registerJobHandler(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

export async function enqueueJob(
  type: string,
  payload: Record<string, unknown> = {},
  opts: { runAt?: Date; priority?: number; maxAttempts?: number } = {},
): Promise<string | null> {
  try {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO jobs (type, payload, run_at, priority, max_attempts)
       VALUES ($1, $2, COALESCE($3, now()), $4, $5) RETURNING id`,
      [type, JSON.stringify(payload), opts.runAt ?? null, opts.priority ?? 5, opts.maxAttempts ?? 5],
    );
    return row?.id ?? null;
  } catch {
    return null; // DB down: callers treat enqueue as best-effort
  }
}

async function alertAdmins(title: string, body: string, link = '/admin/monitoring'): Promise<void> {
  await query(
    `INSERT INTO notifications (user_id, kind, title, body, link)
     SELECT id, 'job_alert', $1, $2, $3 FROM users WHERE role = 'admin' AND status = 'active'`,
    [title, body.slice(0, 500), link],
  ).catch(() => undefined);
}

export async function claimAndRunOne(): Promise<boolean> {
  const job = await queryOne<{
    id: string;
    type: string;
    payload: Record<string, unknown>;
    attempts: number;
    max_attempts: number;
  }>(
    `UPDATE jobs SET status = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1
     WHERE id = (
       SELECT id FROM jobs
       WHERE status = 'queued' AND run_at <= now()
       ORDER BY priority, run_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, type, payload, attempts, max_attempts`,
    [workerId],
  );
  if (!job) return false;

  const handler = handlers.get(job.type);
  if (!handler) {
    await query(`UPDATE jobs SET status = 'failed', last_error = $2, completed_at = now() WHERE id = $1`, [
      job.id,
      `No handler registered for type "${job.type}"`,
    ]);
    await alertAdmins('Job failed', `Job ${job.type} has no registered handler.`);
    return true;
  }

  try {
    const result = await handler(job.payload ?? {});
    await query(
      `UPDATE jobs SET status = 'completed', completed_at = now(), result = $2, last_error = NULL WHERE id = $1`,
      [job.id, result ? JSON.stringify(result) : null],
    );
  } catch (err) {
    const message = (err as Error).message.slice(0, 2000);
    if (job.attempts >= job.max_attempts) {
      await query(`UPDATE jobs SET status = 'failed', last_error = $2, completed_at = now() WHERE id = $1`, [
        job.id,
        message,
      ]);
      await alertAdmins('Job failed permanently', `${job.type} failed after ${job.attempts} attempts: ${message}`);
    } else {
      const backoffSec = Math.min(3600, 30 * 2 ** job.attempts);
      await query(
        `UPDATE jobs SET status = 'queued', run_at = now() + ($2 || ' seconds')::interval, last_error = $3 WHERE id = $1`,
        [job.id, String(backoffSec), message],
      );
    }
  }
  return true;
}

/** Requeue jobs stuck in `running` for >10 min (crashed worker). */
export async function requeueStaleJobs(): Promise<number> {
  const res = await query(
    `UPDATE jobs SET status = 'queued', locked_by = NULL, locked_at = NULL,
       last_error = COALESCE(last_error,'') || ' [requeued: stale lock]'
     WHERE status = 'running' AND locked_at < now() - interval '10 minutes'`,
  );
  return res.rowCount;
}

export async function retryJob(jobId: string): Promise<boolean> {
  const res = await query(
    `UPDATE jobs SET status = 'queued', run_at = now(), attempts = 0, last_error = NULL
     WHERE id = $1 AND status IN ('failed','cancelled')`,
    [jobId],
  );
  return res.rowCount > 0;
}

let pumpTimer: ReturnType<typeof setInterval> | null = null;
let pumping = false;

export function startQueueWorkers(): void {
  if (!config.jobs.enabled) return;
  pumpTimer = setInterval(async () => {
    if (pumping) return;
    pumping = true;
    try {
      for (let i = 0; i < config.jobs.concurrency; i += 1) {
        const ran = await claimAndRunOne();
        if (!ran) break;
      }
    } catch {
      /* DB unavailable — next tick retries */
    } finally {
      pumping = false;
    }
  }, config.jobs.tickMs);
  pumpTimer.unref();
}

export function stopQueueWorkers(): void {
  if (pumpTimer) clearInterval(pumpTimer);
}
