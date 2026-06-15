import { buildApp } from './app.js';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { seedReference } from './db/seed.js';
import { closePool, pool } from './db/pool.js';
import { cache } from './cache/index.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import { startQueueWorkers, stopQueueWorkers } from './jobs/queue.js';

async function main(): Promise<void> {
  // Apply migrations on boot (idempotent; disable with AUTO_MIGRATE=false).
  if ((process.env.AUTO_MIGRATE ?? 'true') === 'true') {
    const client = await pool.connect();
    try {
      await runMigrations(client as never, (m) => process.stdout.write(`[migrate] ${m}\n`));
    } finally {
      client.release();
    }
  }

  // Load real reference data (jurisdictions, FOIA templates, source registry,
  // policy timeline) so a fresh deployment is never blank. Idempotent and
  // non-destructive: only runs when no jurisdictions exist yet, inside a
  // transaction, and best-effort — a failure here must never block boot.
  if ((process.env.SEED_REFERENCE ?? 'true') === 'true') {
    const seedClient = await pool.connect();
    try {
      const { rows } = await seedClient.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM jurisdictions`,
      );
      if ((rows[0]?.n ?? 0) === 0) {
        process.stdout.write('[seed] empty database — loading reference data\n');
        await seedClient.query('BEGIN');
        try {
          await seedReference(seedClient, (m) => process.stdout.write(`[seed] ${m}\n`));
          await seedClient.query('COMMIT');
        } catch (err) {
          await seedClient.query('ROLLBACK');
          throw err;
        }
      }
    } catch (err) {
      process.stderr.write(`[seed] reference data load skipped: ${(err as Error).message}\n`);
    } finally {
      seedClient.release();
    }
  }

  const app = await buildApp();
  await startScheduler();
  startQueueWorkers();

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`STN server ready on ${config.publicUrl} (env=${config.nodeEnv}, storage=${config.storageBackend})`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`${signal} received — graceful shutdown`);
    stopScheduler();
    stopQueueWorkers();
    await app.close().catch(() => undefined);
    await cache.close().catch(() => undefined);
    await closePool().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal boot error:', err);
  process.exit(1);
});
