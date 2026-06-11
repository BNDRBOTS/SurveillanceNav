import { describe, it, expect, beforeAll } from 'vitest';
import { getApp, createUser, auth, makeJurisdiction, makeSource, pumpJobs, type TestUser } from './helpers.js';
import { query } from '../src/db/pool.js';

let editor: TestUser;
let admin: TestUser;
let viewer: TestUser;
let cityId: string;
let sourceId: string;

beforeAll(async () => {
  admin = await createUser('admin');
  editor = await createUser('editor');
  viewer = await createUser('viewer');
  cityId = await makeJurisdiction('Testville', 'city', 'California');
  sourceId = await makeSource('Test Verified Gov Source', 'government', 'verified');
});

async function createAsset(overrides: Record<string, unknown> = {}) {
  const app = await getApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: auth(editor),
    payload: {
      name: 'Test ALPR unit',
      jurisdictionId: cityId,
      sourceId,
      technologyType: 'lpr',
      vendor: 'Flock Safety',
      status: 'active',
      deploymentDate: '2024-03-01',
      lng: -100.001,
      lat: 40.001,
      properties: { pole: 'A-12' },
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe('assets', () => {
  it('creates with provenance-derived confidence and explanation factors', async () => {
    const asset = await createAsset();
    expect(asset.confidenceScore).toBeGreaterThan(60);
    expect(asset.confidenceFactors.length).toBeGreaterThan(2);
    expect(asset.jurisdictionName).toBe('Testville');
    expect(asset.sourceVerification).toBe('verified');
  });

  it('viewer cannot create; unauthenticated cannot create', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: auth(viewer),
      payload: { name: 'X', technologyType: 'cctv', lng: 0, lat: 0 },
    });
    expect(res.statusCode).toBe(403);
    const anon = await app.inject({ method: 'POST', url: '/api/v1/assets', payload: {} });
    expect(anon.statusCode).toBe(401);
  });

  it('filters: bbox, technology, vendor, status, confidence, search', async () => {
    const app = await getApp();
    await createAsset({ name: 'Filtered CCTV', technologyType: 'cctv', vendor: 'Verkada', lng: -100.002, lat: 40.002 });
    const res = await app.inject({
      url: '/api/v1/assets?bbox=-100.1,39.9,-99.9,40.1&technologyType=cctv&vendor=Verkada&minConfidence=10',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items.every((a: { technologyType: string }) => a.technologyType === 'cctv')).toBe(true);

    const search = await app.inject({ url: '/api/v1/assets?q=Filtered' });
    expect(search.json().items.some((a: { name: string }) => a.name === 'Filtered CCTV')).toBe(true);
  });

  it('geojson format returns features; low zoom returns server-side clusters', async () => {
    const app = await getApp();
    const raw = await app.inject({ url: '/api/v1/assets?format=geojson&bbox=-101,39,-99,41&zoom=14' });
    expect(raw.json().clustered).toBe(false);
    expect(raw.json().features[0].geometry.type).toBe('Point');

    const clustered = await app.inject({ url: '/api/v1/assets?format=geojson&bbox=-110,30,-90,50&zoom=5' });
    expect(clustered.json().clustered).toBe(true);
    const feature = clustered.json().features[0];
    expect(feature.properties.cluster).toBe(true);
    expect(feature.properties.count).toBeGreaterThan(0);
    expect(feature.properties.techBreakdown).toBeTruthy();
  });

  it('malformed bbox is rejected with a helpful 422, including zero-width char paste', async () => {
    const app = await getApp();
    const res = await app.inject({ url: '/api/v1/assets?bbox=garbage' });
    expect(res.statusCode).toBe(422);
    const zw = await app.inject({ url: `/api/v1/assets?bbox=${encodeURIComponent('​-100.1,39.9,-99.9,40.1')}` });
    expect(zw.statusCode).toBe(200); // zero-width stripped, parses fine
  });

  it('nearby returns distance-sorted results within the radius (PostGIS path)', async () => {
    const app = await getApp();
    const res = await app.inject({ url: '/api/v1/assets/nearby?lng=-100.001&lat=40.001&radiusMeters=2000' });
    expect(res.statusCode).toBe(200);
    const { items, engine } = res.json();
    expect(engine).toBe('postgis');
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].distanceMeters).toBeLessThanOrEqual(items[items.length - 1].distanceMeters);
    expect(items.every((i: { distanceMeters: number }) => i.distanceMeters <= 2000)).toBe(true);
  });

  it('updates produce immutable history diffs; rollback data preserved', async () => {
    const app = await getApp();
    const asset = await createAsset({ name: 'Diff target' });
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/assets/${asset.id}`,
      headers: auth(editor),
      payload: { vendor: 'Motorola Solutions', status: 'retired' },
    });
    expect(patch.statusCode).toBe(200);
    const detail = await app.inject({ url: `/api/v1/assets/${asset.id}` });
    const history = detail.json().history;
    const update = history.find((h: { action: string }) => h.action === 'update');
    expect(update.diff.vendor.from).toBe('Flock Safety');
    expect(update.diff.vendor.to).toBe('Motorola Solutions');

    // append-only: direct UPDATE on history must be blocked by trigger
    await expect(query(`UPDATE asset_history SET action = 'tampered' WHERE id = $1`, [update.id])).rejects.toThrow(
      /append-only/,
    );
  });

  it('dispute lowers confidence, shows a badge count, and admin resolution restores + notifies', async () => {
    const app = await getApp();
    const asset = await createAsset({ name: 'Disputed asset' });
    const before = asset.confidenceScore;

    const dispute = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/dispute`,
      headers: auth(viewer),
      payload: { reason: 'Camera was removed', evidence: 'I walked past 2026-06-01; pole is empty. Photo available.' },
    });
    expect(dispute.statusCode).toBe(201);

    const during = (await app.inject({ url: `/api/v1/assets/${asset.id}` })).json();
    expect(during.confidenceScore).toBeLessThan(before);
    expect(during.openDisputes).toBe(1);

    const resolve = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/disputes/${dispute.json().disputeId}/resolve`,
      headers: auth(admin),
      payload: { status: 'accepted', resolution: 'Verified removal on site visit. Marking unverified.' },
    });
    expect(resolve.statusCode).toBe(200);
    const after = (await app.inject({ url: `/api/v1/assets/${asset.id}` })).json();
    expect(after.status).toBe('unverified');

    const notif = await app.inject({ method: 'GET', url: '/api/v1/users/me/notifications', headers: auth(viewer) });
    expect(notif.json().items.some((n: { kind: string }) => n.kind === 'dispute_resolved')).toBe(true);
  });

  it('verify endpoint bumps confidence via recency', async () => {
    const app = await getApp();
    const asset = await createAsset({ name: 'Verify me' });
    await query(`UPDATE surveillance_assets SET last_verified_at = now() - interval '300 days' WHERE id = $1`, [asset.id]);
    await query(`UPDATE surveillance_assets SET confidence_score = 50 WHERE id = $1`, [asset.id]);
    const res = await app.inject({ method: 'POST', url: `/api/v1/assets/${asset.id}/verify`, headers: auth(editor) });
    expect(res.statusCode).toBe(200);
    expect(res.json().confidenceScore).toBeGreaterThan(50);
  });

  it('evidence upload: clean file accepted, EICAR quarantined with admin review queue', async () => {
    const app = await getApp();
    const asset = await createAsset({ name: 'Evidence holder' });

    const boundary = '----stnboundary';
    const cleanPayload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="note.txt"',
      'Content-Type: text/plain',
      '',
      'Observed the camera at the intersection. No identifying info.',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const ok = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/evidence`,
      headers: { ...auth(editor), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: cleanPayload,
    });
    expect(ok.statusCode).toBe(201);

    const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    const evilPayload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="evil.txt"',
      'Content-Type: text/plain',
      '',
      eicar,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const quarantined = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/evidence`,
      headers: { ...auth(editor), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: evilPayload,
    });
    expect(quarantined.statusCode).toBe(202);
    expect(quarantined.json().quarantined).toBe(true);

    const curation = await app.inject({ method: 'GET', url: '/api/v1/admin/curation', headers: auth(admin) });
    expect(curation.json().quarantinedFiles.some((f: { fileName: string }) => f.fileName === 'evil.txt')).toBe(true);

    // PII-bearing file gets flagged (not quarantined)
    const piiPayload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="pii.txt"',
      'Content-Type: text/plain',
      '',
      'Officer roster: SSN 123-45-6789, call (415) 555-2671',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const pii = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/evidence`,
      headers: { ...auth(editor), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: piiPayload,
    });
    expect(pii.statusCode).toBe(201);
    expect(pii.json().piiFlagged).toBe(true);
  });

  it('comments resolve @mentions and notify; workspace-scoped', async () => {
    const app = await getApp();
    const asset = await createAsset({ name: 'Comment target' });
    await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${editor.workspaceId}/members`,
      headers: auth(editor),
      payload: { email: viewer.email, role: 'editor' },
    });
    const post = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/comments`,
      headers: auth(editor),
      payload: { workspaceId: editor.workspaceId, body: `Can @${viewer.email} verify this one?` },
    });
    expect(post.statusCode).toBe(201);
    expect(post.json().mentions).toBe(1);

    const list = await app.inject({
      url: `/api/v1/assets/${asset.id}/comments?workspaceId=${editor.workspaceId}`,
      headers: auth(viewer),
    });
    expect(list.json().items.length).toBe(1);

    const mentionNotif = await app.inject({ method: 'GET', url: '/api/v1/users/me/notifications', headers: auth(viewer) });
    expect(mentionNotif.json().items.some((n: { kind: string }) => n.kind === 'mention')).toBe(true);
  });

  it('dedupe job queues merge candidates for near-identical assets; admin merge folds records', async () => {
    const app = await getApp();
    const a = await createAsset({ name: 'Dup ALPR north', lng: -100.5, lat: 40.5 });
    const b = await createAsset({ name: 'Dup ALPR north 2', lng: -100.50001, lat: 40.50001 });
    await pumpJobs();

    const curation = await app.inject({ method: 'GET', url: '/api/v1/admin/curation', headers: auth(admin) });
    const candidate = curation
      .json()
      .mergeCandidates.find(
        (m: { assetA: string; assetB: string }) =>
          (m.assetA === a.id && m.assetB === b.id) || (m.assetA === b.id && m.assetB === a.id),
      );
    expect(candidate).toBeTruthy();

    const merge = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/merge-assets',
      headers: auth(admin),
      payload: { keepId: a.id, mergeIds: [b.id] },
    });
    expect(merge.statusCode).toBe(200);
    const gone = await app.inject({ url: `/api/v1/assets/${b.id}` });
    expect(gone.statusCode).toBe(404);
    const kept = await app.inject({ url: `/api/v1/assets/${a.id}` });
    expect(kept.json().history.some((h: { action: string }) => h.action === 'merge')).toBe(true);
  });

  it('jurisdiction comparison returns per-tech stats side by side', async () => {
    const app = await getApp();
    const otherCity = await makeJurisdiction('Othertown', 'city', 'California');
    await createAsset({ name: 'Other cam', jurisdictionId: otherCity, technologyType: 'cctv', lng: -101.3, lat: 41.2 });
    const res = await app.inject({ url: `/api/v1/assets/compare?jurisdictions=${cityId},${otherCity}` });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();
    expect(items.length).toBe(2);
    expect(items[0].totalAssets).toBeGreaterThan(0);
    expect(items[1].technologies.some((t: { technology_type: string }) => t.technology_type === 'cctv')).toBe(true);
  });

  it('soft delete is admin-only and audited', async () => {
    const app = await getApp();
    const asset = await createAsset({ name: 'Delete me' });
    const denied = await app.inject({ method: 'DELETE', url: `/api/v1/assets/${asset.id}`, headers: auth(editor) });
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({ method: 'DELETE', url: `/api/v1/assets/${asset.id}`, headers: auth(admin) });
    expect(ok.statusCode).toBe(200);
    const logs = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/audit-logs?action=asset.deleted`,
      headers: auth(admin),
    });
    expect(logs.json().items.some((l: { resourceId: string }) => l.resourceId === asset.id)).toBe(true);
  });
});
