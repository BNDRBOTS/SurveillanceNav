import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../config.js';

/**
 * Versioned, transactional migration runner.
 *  - Files: migrations/NNNN_name.up.sql / NNNN_name.down.sql
 *  - Each migration runs in its own transaction; failure rolls back and aborts.
 *  - PostGIS migrations (marked by "postgis" in the name) are skipped (and
 *    recorded as skipped) when the extension is unavailable, so the platform
 *    still deploys on plain PostgreSQL with degraded spatial performance.
 *  - `down <n>` reverts the last n applied migrations.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

function migrationsDir(): string {
  for (const cand of [
    path.resolve(here, '..', '..', 'migrations'),
    path.resolve(process.cwd(), 'migrations'),
    path.resolve(process.cwd(), 'server', 'migrations'),
  ]) {
    if (fs.existsSync(cand)) return cand;
  }
  throw new Error('migrations directory not found');
}

interface MigrationFile {
  id: string;
  name: string;
  upPath: string;
  downPath: string | null;
}

function listMigrations(): MigrationFile[] {
  const dir = migrationsDir();
  const ups = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.up.sql'))
    .sort();
  return ups.map((f) => {
    const base = f.replace(/\.up\.sql$/, '');
    const downPath = path.join(dir, `${base}.down.sql`);
    return {
      id: base.split('_')[0] ?? base,
      name: base,
      upPath: path.join(dir, f),
      downPath: fs.existsSync(downPath) ? downPath : null,
    };
  });
}

export async function runMigrations(
  client?: pg.Client,
  log: (msg: string) => void = (m) => process.stdout.write(`${m}\n`),
): Promise<{ applied: string[]; skipped: string[] }> {
  const own = !client;
  const c = client ?? new pg.Client({ connectionString: config.databaseUrl });
  if (own) await c.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      status text NOT NULL DEFAULT 'applied',
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    const { rows: availExt } = await c.query(
      `SELECT 1 FROM pg_available_extensions WHERE name = 'postgis'`,
    );
    const postgisAvailable = availExt.length > 0;

    const done = new Set(
      (await c.query(`SELECT name FROM schema_migrations`)).rows.map((r: { name: string }) => r.name),
    );

    for (const m of listMigrations()) {
      if (done.has(m.name)) continue;
      if (m.name.includes('postgis') && !postgisAvailable) {
        await c.query(`INSERT INTO schema_migrations (name, status) VALUES ($1, 'skipped')`, [m.name]);
        skipped.push(m.name);
        log(`↷ skipped ${m.name} (postgis unavailable — lat/lng fallback active)`);
        continue;
      }
      const sql = fs.readFileSync(m.upPath, 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [m.name]);
        await c.query('COMMIT');
        applied.push(m.name);
        log(`✓ applied ${m.name}`);
      } catch (err) {
        await c.query('ROLLBACK');
        throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    if (own) await c.end();
  }
  return { applied, skipped };
}

export async function rollbackMigrations(steps = 1): Promise<string[]> {
  const c = new pg.Client({ connectionString: config.databaseUrl });
  await c.connect();
  const reverted: string[] = [];
  try {
    const { rows } = await c.query(
      `SELECT name FROM schema_migrations WHERE status='applied' ORDER BY name DESC LIMIT $1`,
      [steps],
    );
    const files = listMigrations();
    for (const row of rows as Array<{ name: string }>) {
      const file = files.find((f) => f.name === row.name);
      if (!file?.downPath) throw new Error(`No down migration for ${row.name}`);
      const sql = fs.readFileSync(file.downPath, 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query(`DELETE FROM schema_migrations WHERE name = $1`, [row.name]);
        await c.query('COMMIT');
        reverted.push(row.name);
        process.stdout.write(`✗ reverted ${row.name}\n`);
      } catch (err) {
        await c.query('ROLLBACK');
        throw new Error(`Rollback of ${row.name} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await c.end();
  }
  return reverted;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]).includes('migrate');
if (invokedDirectly) {
  const cmd = process.argv[2] ?? 'up';
  if (cmd === 'down') {
    rollbackMigrations(Number(process.argv[3] ?? 1))
      .then(() => process.exit(0))
      .catch((e) => {
        console.error(e.message);
        process.exit(1);
      });
  } else {
    runMigrations()
      .then(() => process.exit(0))
      .catch((e) => {
        console.error(e.message);
        process.exit(1);
      });
  }
}
