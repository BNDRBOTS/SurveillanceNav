import { describe, it, expect, beforeAll } from 'vitest';
import { getApp, createUser, auth, type TestUser } from './helpers.js';
import { query } from '../src/db/pool.js';
import { openapiDocument } from '../src/openapi.js';

let user: TestUser;

beforeAll(async () => {
  user = await createUser('editor');
});

describe('security hardening', () => {
  it('sets the full security header suite on every response', async () => {
    const app = await getApp();
    const res = await app.inject({ url: '/api/v1/health/live' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['content-security-policy']).toContain(`default-src 'self'`);
    expect(res.headers['content-security-policy']).toContain(`frame-ancestors 'none'`);
    expect(res.headers['permissions-policy']).toContain('geolocation=(self)');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('never leaks stack traces; unknown routes return the envelope', async () => {
    const app = await getApp();
    const res = await app.inject({ url: '/api/v1/definitely-not-a-route' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    expect(res.body).not.toContain('at ');
  });

  it('rejects JSON bombs (depth) and oversized arrays with 400', async () => {
    const app = await getApp();
    let nested: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 20; i += 1) nested = { child: nested };
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: auth(user),
      payload: { name: 'x', technologyType: 'lpr', lng: 0, lat: 0, properties: nested },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('nesting');
  });

  it('rejects bodies over the 1MB JSON limit with 413', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { ...auth(user), 'content-type': 'application/json' },
      payload: `{"name":"${'a'.repeat(1_100_000)}"}`,
    });
    expect(res.statusCode).toBe(413);
  });

  it('SQL-injection-shaped input is treated as data, not SQL', async () => {
    const app = await getApp();
    const res = await app.inject({
      url: `/api/v1/assets?q=${encodeURIComponent(`'; DROP TABLE users; --`)}`,
    });
    expect(res.statusCode).toBe(200);
    const stillThere = await query(`SELECT count(*)::int AS n FROM users`);
    expect(stillThere.rows[0]!.n).toBeGreaterThan(0);
  });

  it('zero-width characters and whitespace are stripped from inputs', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: auth(user),
      payload: { name: '​  Padded name ‍ ', technologyType: 'cctv', lng: 1, lat: 1 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Padded name');
  });

  it('rate limiting returns 429 with Retry-After and never silently drops', async () => {
    process.env.RATE_LIMIT_TEST = '1';
    const app = await getApp();
    try {
      let limited = false;
      for (let i = 0; i < 15; i += 1) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: `rl-${i}@test.local`, password: 'whatever123' },
          remoteAddress: '203.0.113.99',
        });
        expect(res.headers['x-ratelimit-limit']).toBeTruthy();
        if (res.statusCode === 429) {
          limited = true;
          expect(res.headers['retry-after']).toBeTruthy();
          expect(res.json().error.retryAfterSec).toBeGreaterThan(0);
          break;
        }
      }
      expect(limited).toBe(true);
    } finally {
      delete process.env.RATE_LIMIT_TEST;
    }
  });

  it('audit logs are append-only at the database level', async () => {
    await query(
      `INSERT INTO audit_logs (actor_id, action, resource) VALUES (NULL, 'test.entry', 'system')`,
    );
    await expect(query(`UPDATE audit_logs SET action = 'tampered' WHERE action = 'test.entry'`)).rejects.toThrow(/append-only/);
    await expect(query(`DELETE FROM audit_logs WHERE action = 'test.entry'`)).rejects.toThrow(/append-only/);
  });

  it('idempotency: replayed POST with same key returns original response, no duplicate rows', async () => {
    const app = await getApp();
    const key = `idem-${Date.now()}`;
    const payload = {
      name: 'Idempotent asset',
      technologyType: 'lpr' as const,
      lng: -99.5,
      lat: 39.5,
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { ...auth(user), 'idempotency-key': key },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { ...auth(user), 'idempotency-key': key },
      payload,
    });
    expect(second.headers['x-idempotent-replay']).toBe('true');
    expect(second.json().id).toBe(first.json().id);
    const count = await query(`SELECT count(*)::int AS n FROM surveillance_assets WHERE name = 'Idempotent asset'`);
    expect(count.rows[0]!.n).toBe(1);
  });

  it('storage path traversal is blocked', async () => {
    const { assertSafeKey } = await import('../src/storage/index.js');
    expect(() => assertSafeKey('../../etc/passwd')).toThrow();
    expect(() => assertSafeKey('/absolute/path')).toThrow();
    expect(() => assertSafeKey('evidence/ok/file.pdf')).not.toThrow();
  });
});

describe('API contract', () => {
  it('every registered /api/v1 route is documented in the OpenAPI spec', async () => {
    const app = await getApp();
    const documented = new Set(
      Object.entries(openapiDocument.paths).flatMap(([p, methods]) =>
        Object.keys(methods as object).map((m) => `${m.toUpperCase()} ${p}`),
      ),
    );
    const routes = app
      .printRoutes({ commonPrefix: false })
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('/api/v1/') && /\((GET|POST|PATCH|PUT|DELETE)/.test(l));
    // fastify printRoutes output: "/api/v1/auth/login (POST)"
    for (const line of routes) {
      const m = line.match(/^(\S+)\s+\((\w+)/);
      if (!m) continue;
      const [, rawPath, method] = m;
      if (rawPath!.includes('openapi.json') || method === 'HEAD' || method === 'OPTIONS') continue;
      const normalized = rawPath!.replace('/api/v1', '').replace(/:(\w+)/g, '{$1}');
      expect(documented.has(`${method} ${normalized}`), `${method} ${normalized} missing from OpenAPI`).toBe(true);
    }
  });

  it('health endpoints exist at both /health/* and /api/v1/health/*', async () => {
    const app = await getApp();
    expect((await app.inject({ url: '/health/live' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/health/ready' })).statusCode).toBe(200);
    const ready = (await app.inject({ url: '/api/v1/health/ready' })).json();
    expect(ready.checks.database.ok).toBe(true);
    expect(ready.checks.storage.ok).toBe(true);
  });
});
