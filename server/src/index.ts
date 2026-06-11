import { buildApp } from './app.js';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
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
