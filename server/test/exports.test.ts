import { describe, it, expect, beforeAll } from 'vitest';
import { getApp, createUser, auth, makeJurisdiction, makeSource, pumpJobs, type TestUser } from './helpers.js';

let editor: TestUser;
let admin: TestUser;

beforeAll(async () => {
  admin = await createUser('admin');
  editor = await createUser('editor');
  const cityId = await makeJurisdiction('Exportville', 'city', 'Washington');
  const sourceId = await makeSource('Export Source', 'government', 'verified');
  const app = await getApp();
  for (let i = 0; i < 5; i += 1) {
    await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: auth(editor),
      payload: {
        name: `Export asset ${i}`,
        jurisdictionId: cityId,
        sourceId,
        technologyType: i % 2 === 0 ? 'lpr' : 'cctv',
        vendor: 'Flock Safety',
        status: 'active',
        lng: -120.1 - i * 0.001,
        lat: 47.2 + i * 0.001,
      },
    });
  }
});

describe('exports', () => {
  async function runExport(format: string, resource = 'assets', params: Record<string, unknown> = {}) {
    const app = await getApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/exports',
      headers: auth(editor),
      payload: { format, resource, params },
    });
    expect(created.statusCode).toBe(202);
    const id = created.json().id;
    await pumpJobs();
    const status = await app.inject({ url: `/api/v1/exports/${id}`, headers: auth(editor) });
    expect(status.json().status).toBe('completed');
    return status.json();
  }

  it('CSV export completes with signed download URL; content is valid CSV', async () => {
    const app = await getApp();
    const job = await runExport('csv');
    expect(job.rowCount).toBeGreaterThanOrEqual(5);
    expect(job.downloadUrl).toContain('/api/v1/exports/download/');
    const download = await app.inject({ url: job.downloadUrl });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toContain('text/csv');
    expect(download.body.split('\r\n')[0]).toContain('technology_type');
  });

  it('GeoJSON, KML, JSON, PDF and HTML formats all produce valid output', async () => {
    const app = await getApp();
    const geo = await runExport('geojson');
    const geoBody = await app.inject({ url: geo.downloadUrl });
    expect(JSON.parse(geoBody.body).type).toBe('FeatureCollection');

    const kml = await runExport('kml');
    const kmlBody = await app.inject({ url: kml.downloadUrl });
    expect(kmlBody.body).toContain('<kml');

    const json = await runExport('json');
    expect(JSON.parse((await app.inject({ url: json.downloadUrl })).body).rows.length).toBeGreaterThan(0);

    const pdf = await runExport('pdf', 'report');
    const pdfBody = await app.inject({ url: pdf.downloadUrl });
    expect(pdfBody.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const html = await runExport('html');
    expect((await app.inject({ url: html.downloadUrl })).body).toContain('<table>');
  });

  it('tampered or expired signatures are rejected; other users cannot read your export', async () => {
    const app = await getApp();
    const job = await runExport('csv');
    const tampered = job.downloadUrl.replace(/sig=[^&]+/, 'sig=AAAA');
    expect((await app.inject({ url: tampered })).statusCode).toBe(403);

    const other = await createUser('editor');
    const denied = await app.inject({ url: `/api/v1/exports/${job.id}`, headers: auth(other) });
    expect(denied.statusCode).toBe(403);
    const adminOk = await app.inject({ url: `/api/v1/exports/${job.id}`, headers: auth(admin) });
    expect(adminOk.statusCode).toBe(200);
  });

  it('export cleanup expires old exports and deletes files', async () => {
    const app = await getApp();
    const job = await runExport('csv');
    const { query } = await import('../src/db/pool.js');
    await query(`UPDATE exports SET expires_at = now() - interval '1 hour' WHERE id = $1`, [job.id]);
    const { runScheduledJobNow } = await import('../src/jobs/scheduler.js');
    const result = (await runScheduledJobNow('export_cleanup')) as { expired: number };
    expect(result.expired).toBeGreaterThanOrEqual(1);
    const after = await app.inject({ url: `/api/v1/exports/${job.id}`, headers: auth(editor) });
    expect(after.json().status).toBe('expired');
    expect((await app.inject({ url: job.downloadUrl })).statusCode).toBe(404);
  });

  it('FOIA exports require workspace scope', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/exports',
      headers: auth(editor),
      payload: { format: 'csv', resource: 'foia', params: {} },
    });
    expect(res.statusCode).toBe(400);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/exports',
      headers: auth(editor),
      payload: { format: 'csv', resource: 'foia', workspaceId: editor.workspaceId, params: {} },
    });
    expect(ok.statusCode).toBe(202);
  });
});

describe('procurement parsing', () => {
  it('parses pasted contract text async with review queue, evidence and confidence', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/procurement/parse',
      headers: auth(editor),
      payload: {
        title: 'ALPR contract FY24',
        text: `AGREEMENT between the City of Exportville and Flock Safety.
               Total contract value not to exceed $487,500.00.
               Term: March 1, 2024 through 2027-02-28.
               Scope: 150 automated license plate reader cameras with hosted software.`,
      },
    });
    expect(res.statusCode).toBe(202);
    const { procurementId, jobId } = res.json();
    expect(jobId).toBeTruthy();
    await pumpJobs();

    const jobStatus = await app.inject({ url: `/api/v1/procurement/jobs/${jobId}`, headers: auth(editor) });
    expect(jobStatus.json().status).toBe('completed');

    const proc = (await app.inject({ url: `/api/v1/procurements/${procurementId}` })).json();
    expect(proc.vendor).toBe('Flock Safety');
    expect(proc.amount).toBe(487500);
    expect(proc.technologyTerms).toContain('license plate reader');
    expect(proc.reviewStatus).toBe('needs_review');
    expect(proc.normalized.vendorEvidence).toBeTruthy();

    // editor cannot approve; admin can
    const denied = await app.inject({
      method: 'PATCH',
      url: `/api/v1/procurements/${procurementId}`,
      headers: auth(editor),
      payload: { reviewStatus: 'approved' },
    });
    expect(denied.statusCode).toBe(403);
    const approved = await app.inject({
      method: 'PATCH',
      url: `/api/v1/procurements/${procurementId}`,
      headers: auth(admin),
      payload: { reviewStatus: 'approved' },
    });
    expect(approved.json().reviewStatus).toBe('approved');
  });

  it('rejects garbage paste with guidance instead of a dead job', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/procurement/parse',
      headers: auth(editor),
      payload: { text: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('paragraph');
  });
});
