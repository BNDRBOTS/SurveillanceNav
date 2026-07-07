import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getApp } from './helpers.js';

const webBuilt = fs.existsSync(path.resolve(process.cwd(), '../web/dist/index.html'));

describe('SPA fallback routing', () => {
  it.skipIf(!webBuilt)('serves the app shell for client routes', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/map' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<!doctype html>');
  });

  it.skipIf(!webBuilt)('serves the app shell when the query string contains dots (shared map links)', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/map?lng=-122.4194&lat=37.7749&z=12.5' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<!doctype html>');
  });

  it('keeps the JSON envelope for unknown API routes', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/definitely-not-a-route' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('does not fall back for asset-like paths with dots', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/assets/nope.js' });
    expect(res.statusCode).toBe(404);
  });
});
