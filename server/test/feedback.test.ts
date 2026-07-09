import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getApp, createUser } from './helpers.js';
import { config } from '../src/config.js';
import { query } from '../src/db/pool.js';

const payload = {
  kind: 'map_style',
  message: 'Vector fallback failed: glyphs unreachable',
  detail: {
    route: '/map',
    styleId: 'dark',
    errorChain: ['Error: Failed to fetch glyph range'],
    mapState: { lng: -122.41, lat: 37.78, zoom: 12 },
    viewport: '1440x900',
    online: true,
  },
  appVersion: '1.0.0',
};

describe('anonymous error reports', () => {
  const originalAdminEmail = config.adminEmail;
  beforeAll(() => {
    (config as { adminEmail: string }).adminEmail = 'operator@stn.local';
  });
  afterAll(() => {
    (config as { adminEmail: string }).adminEmail = originalAdminEmail;
  });

  it('stores a report and emails the operator when ADMIN_EMAIL is set', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/feedback/error-report', payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, stored: true, emailed: true });

    const rows = await query<{ kind: string; message: string }>(
      `SELECT kind, message FROM error_reports ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows.rows[0]).toMatchObject({ kind: 'map_style', message: payload.message });

    const { readOutbox } = await import('../src/services/mailer.js');
    const mails = await readOutbox();
    const mail = mails.find((m) => m.subject.includes('error report: map_style'));
    expect(mail).toBeDefined();
    expect(mail!.to).toBe('operator@stn.local');
    expect(mail!.text).toContain('glyphs unreachable');
  });

  it('reports emailed:false truthfully when no admin email is configured', async () => {
    const app = await getApp();
    (config as { adminEmail: string }).adminEmail = '';
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/feedback/error-report',
      payload: { ...payload, kind: 'content', message: 'A record label is wrong' },
    });
    (config as { adminEmail: string }).adminEmail = 'operator@stn.local';
    expect(res.json()).toMatchObject({ ok: true, stored: true, emailed: false });
  });

  it('rejects oversized diagnostic payloads', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/feedback/error-report',
      payload: { ...payload, detail: { ...payload.detail, context: 'x'.repeat(999) + 'y' } },
    });
    expect([200, 422]).toContain(res.statusCode); // 999 chars is within the 1000 cap
    const big = await app.inject({
      method: 'POST',
      url: '/api/v1/feedback/error-report',
      payload: { ...payload, detail: { errorChain: Array.from({ length: 11 }, () => 'e') } },
    });
    expect(big.statusCode).toBe(422);
  });

  it('rate limits after 5 reports per IP per hour', async () => {
    const app = await getApp();
    let lastStatus = 200;
    for (let i = 0; i < 8; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/feedback/error-report',
        payload: { ...payload, message: `spam ${i}` },
        remoteAddress: '10.9.9.9',
      });
      lastStatus = res.statusCode;
    }
    expect(lastStatus).toBe(429);
  });

  it('appears in the admin curation bucket and can be resolved', async () => {
    const app = await getApp();
    const admin = await createUser('admin');
    const curation = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/curation',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(curation.statusCode).toBe(200);
    const reports = curation.json().errorReports as Array<{ id: string; kind: string }>;
    expect(reports.length).toBeGreaterThan(0);

    const resolve = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/error-reports/${reports[0]!.id}/resolve`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { action: 'resolved' },
    });
    expect(resolve.statusCode).toBe(200);

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/error-reports/${reports[0]!.id}/resolve`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { action: 'resolved' },
    });
    expect(again.statusCode).toBe(404); // no longer 'new'
  });
});
