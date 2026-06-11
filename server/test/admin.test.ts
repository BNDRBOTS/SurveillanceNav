import { describe, it, expect, beforeAll } from 'vitest';
import { getApp, createUser, auth, type TestUser } from './helpers.js';
import { query } from '../src/db/pool.js';

let admin: TestUser;
let editor: TestUser;

beforeAll(async () => {
  admin = await createUser('admin');
  editor = await createUser('editor');
});

describe('admin console', () => {
  it('blocks non-admins from every /admin route', async () => {
    const app = await getApp();
    for (const url of ['/api/v1/admin/users', '/api/v1/admin/metrics', '/api/v1/admin/audit-logs', '/api/v1/admin/curation', '/api/v1/admin/settings']) {
      const res = await app.inject({ url, headers: auth(editor) });
      expect(res.statusCode, url).toBe(403);
      const anon = await app.inject({ url });
      expect(anon.statusCode, url).toBe(401);
    }
  });

  it('metrics expose latency, jobs, cache, storage, schedules and entity counts', async () => {
    const app = await getApp();
    const res = await app.inject({ url: '/api/v1/admin/metrics', headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    const m = res.json();
    expect(m.dbHealthy).toBe(true);
    expect(['redis', 'memory']).toContain(m.cacheBackend);
    expect(m.storage.ok).toBe(true);
    expect(typeof m.requestsLastHour).toBe('number');
    expect(typeof m.counts.assets).toBe('number');
    expect(Array.isArray(m.scheduledJobs)).toBe(true);
  });

  it('user management: role change, suspension revokes sessions, self-demotion blocked', async () => {
    const app = await getApp();
    const target = await createUser('editor');

    const selfDemote = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${admin.id}`,
      headers: auth(admin),
      payload: { role: 'viewer' },
    });
    expect(selfDemote.statusCode).toBe(400);

    const demote = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${target.id}`,
      headers: auth(admin),
      payload: { role: 'viewer' },
    });
    expect(demote.json().role).toBe('viewer');

    const suspend = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${target.id}`,
      headers: auth(admin),
      payload: { status: 'suspended' },
    });
    expect(suspend.json().status).toBe('suspended');
    const { cache } = await import('../src/cache/index.js');
    await cache.del(`userstat:${target.id}`);
    const meAfter = await app.inject({ url: '/api/v1/users/me', headers: auth(target) });
    expect(meAfter.statusCode).toBe(401);
  });

  it('settings: get defaults, update allowed key, reject unknown key; audited', async () => {
    const app = await getApp();
    const before = await app.inject({ url: '/api/v1/admin/settings', headers: auth(admin) });
    expect(before.json().settings.rate_limits.max).toBeGreaterThan(0);

    const bad = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings',
      headers: auth(admin),
      payload: { key: 'evil_key', value: 1 },
    });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings',
      headers: auth(admin),
      payload: { key: 'feature_flags', value: { onlineBasemap: false, publicSignup: true, communitySubmissions: true } },
    });
    expect(ok.statusCode).toBe(200);
    const after = await app.inject({ url: '/api/v1/admin/settings', headers: auth(admin) });
    expect(after.json().settings.feature_flags.onlineBasemap).toBe(false);

    const logs = await app.inject({ url: '/api/v1/admin/audit-logs?action=admin.settings_updated', headers: auth(admin) });
    expect(logs.json().items.length).toBeGreaterThan(0);
  });

  it('scheduled jobs: list, toggle, run-now (integrity check) with recorded status', async () => {
    const app = await getApp();
    const { ensureSchedules } = await import('../src/jobs/scheduler.js');
    await ensureSchedules();

    const run = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/schedules/integrity_check/run',
      headers: auth(admin),
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().result).toHaveProperty('mergeCandidates');

    const toggle = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/schedules/integrity_check/toggle',
      headers: auth(admin),
    });
    expect(typeof toggle.json().enabled).toBe('boolean');
    await app.inject({ method: 'POST', url: '/api/v1/admin/schedules/integrity_check/toggle', headers: auth(admin) });
  });

  it('retention run returns a compliance report and prunes idempotency keys', async () => {
    const app = await getApp();
    await query(
      `INSERT INTO idempotency_keys (key, user_id, method, path, created_at)
       VALUES ('old-key-123', $1, 'POST', '/x', now() - interval '3 days') ON CONFLICT DO NOTHING`,
      [admin.id],
    );
    const res = await app.inject({ method: 'POST', url: '/api/v1/admin/retention/run', headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    expect(res.json().report.idempotencyPruned).toBeGreaterThanOrEqual(1);
  });

  it('failed jobs can be retried; job queue is inspectable', async () => {
    const app = await getApp();
    const { rows } = await query<{ id: string }>(
      `INSERT INTO jobs (type, payload, status, last_error, completed_at)
       VALUES ('parse_procurement', '{}'::jsonb, 'failed', 'boom', now()) RETURNING id`,
    );
    const jobId = rows[0]!.id;
    const list = await app.inject({ url: '/api/v1/admin/jobs?status=failed', headers: auth(admin) });
    expect(list.json().items.some((j: { id: string }) => j.id === jobId)).toBe(true);
    const retry = await app.inject({ method: 'POST', url: `/api/v1/admin/jobs/${jobId}/retry`, headers: auth(admin) });
    expect(retry.statusCode).toBe(200);
  });

  it('rate-limit override is audited and time-boxed', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/rate-limit-override',
      headers: auth(admin),
      payload: { minutes: 5 },
    });
    expect(res.statusCode).toBe(200);
    expect(new Date(res.json().overrideUntil).getTime()).toBeGreaterThan(Date.now());
    // restore
    await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings',
      headers: auth(admin),
      payload: { key: 'rate_limits', value: { windowSec: 60, max: 300, authMax: 10 } },
    });
  });

  it('index maintenance and confidence recalc jobs run end-to-end', async () => {
    const { runScheduledJobNow } = await import('../src/jobs/scheduler.js');
    const idx = (await runScheduledJobNow('index_maintenance')) as { analyzed: number };
    expect(idx.analyzed).toBeGreaterThan(0);
    const conf = (await runScheduledJobNow('confidence_recalc')) as { recalculated: number };
    expect(conf.recalculated).toBeGreaterThanOrEqual(0);
  });

  it('backup job dumps and stores a verifiable archive', async () => {
    const { runScheduledJobNow } = await import('../src/jobs/scheduler.js');
    const result = (await runScheduledJobNow('backup_verify')) as { backupKey: string; sizeBytes: number };
    expect(result.backupKey).toContain('backups/');
    expect(result.sizeBytes).toBeGreaterThan(10_000);
    const { storage } = await import('../src/storage/index.js');
    expect(await storage.exists(result.backupKey)).toBe(true);
  });
});
