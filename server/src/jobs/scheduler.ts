import { query, queryOne, withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { registerJobHandler, requeueStaleJobs } from './queue.js';
import { jobDefinitions, scheduleDefaults } from './definitions/index.js';

/**
 * Scheduler for recurring maintenance jobs. Schedules live in job_schedules
 * (admins can tune intervals / disable via the console). A Postgres advisory
 * lock elects a single scheduler per cluster, so running multiple server
 * replicas never double-fires jobs. Every run records status, duration and
 * error; failures alert admins through the queue's notification path.
 */

const ADVISORY_LOCK_KEY = 7_741_001;

let tickTimer: ReturnType<typeof setInterval> | null = null;

export async function ensureSchedules(): Promise<void> {
  for (const def of scheduleDefaults) {
    await query(
      `INSERT INTO job_schedules (name, description, interval_sec, next_run_at)
       VALUES ($1, $2, $3, now() + (random() * 60 || ' seconds')::interval)
       ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description`,
      [def.name, def.description, def.intervalSec],
    );
  }
}

async function tick(): Promise<void> {
  await withTransaction(async (tx) => {
    const { rows } = await tx.query(`SELECT pg_try_advisory_xact_lock($1) AS got`, [ADVISORY_LOCK_KEY]);
    if (!(rows[0] as { got: boolean }).got) return;

    await requeueStaleJobs().catch(() => undefined);

    const due = await tx.query(
      `SELECT name, interval_sec FROM job_schedules
       WHERE enabled = true AND next_run_at <= now()
       FOR UPDATE SKIP LOCKED`,
    );
    for (const schedule of due.rows as Array<{ name: string; interval_sec: number }>) {
      await tx.query(
        `UPDATE job_schedules SET next_run_at = now() + ($2 || ' seconds')::interval WHERE name = $1`,
        [schedule.name, String(schedule.interval_sec)],
      );
      await tx.query(
        `INSERT INTO jobs (type, payload, priority, max_attempts) VALUES ($1, '{}'::jsonb, 3, 3)`,
        [schedule.name],
      );
    }
  });
}

/** Wrap each scheduled handler to record outcome on its schedule row. */
function instrument(name: string, handler: (p: Record<string, unknown>) => Promise<Record<string, unknown> | void>) {
  return async (payload: Record<string, unknown>) => {
    const start = performance.now();
    try {
      const result = await handler(payload);
      await query(
        `UPDATE job_schedules SET last_run_at = now(), last_status = 'ok', last_duration_ms = $2, last_error = NULL WHERE name = $1`,
        [name, Math.round(performance.now() - start)],
      ).catch(() => undefined);
      return result ?? undefined;
    } catch (err) {
      await query(
        `UPDATE job_schedules SET last_run_at = now(), last_status = 'failed', last_duration_ms = $2, last_error = $3 WHERE name = $1`,
        [name, Math.round(performance.now() - start), (err as Error).message.slice(0, 1000)],
      ).catch(() => undefined);
      throw err;
    }
  };
}

export async function startScheduler(): Promise<void> {
  for (const [type, handler] of Object.entries(jobDefinitions)) {
    const isScheduled = scheduleDefaults.some((s) => s.name === type);
    registerJobHandler(type, isScheduled ? instrument(type, handler) : handler);
  }
  if (!config.jobs.enabled) return;
  await ensureSchedules();
  tickTimer = setInterval(() => void tick().catch(() => undefined), 30_000);
  tickTimer.unref();
}

export function stopScheduler(): void {
  if (tickTimer) clearInterval(tickTimer);
}

export async function runScheduledJobNow(name: string): Promise<Record<string, unknown> | void> {
  const handler = jobDefinitions[name];
  if (!handler) throw new Error(`Unknown job ${name}`);
  const result = await instrument(name, handler)({});
  await queryOne(`UPDATE job_schedules SET last_run_at = now() WHERE name = $1`, [name]);
  return result;
}
