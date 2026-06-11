import pg from 'pg';
import fs from 'node:fs';

const TEST_DB_URL = 'postgres://stn:stn_dev_password@localhost:5432/stn_test';

/**
 * Reset the dedicated test database to a pristine migrated state.
 * Only application objects are dropped — the PostGIS extension (installed
 * once by an administrator) is left untouched.
 */
export default async function setup(): Promise<void> {
  process.env.DATABASE_URL = TEST_DB_URL;
  const client = new pg.Client({ connectionString: TEST_DB_URL });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename NOT IN ('spatial_ref_sys')`,
    );
    for (const row of rows as Array<{ tablename: string }>) {
      await client.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
    }
    for (const fn of ['set_updated_at', 'forbid_mutation', 'sync_jurisdiction_geom']) {
      await client.query(`DROP FUNCTION IF EXISTS ${fn}() CASCADE`);
    }
    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations(client as never, () => undefined);
  } finally {
    await client.end();
  }
  fs.rmSync('/tmp/stn-test-storage', { recursive: true, force: true });
  fs.rmSync('/tmp/stn-test-mail', { recursive: true, force: true });
}
