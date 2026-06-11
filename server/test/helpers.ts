import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { totpCode } from '../src/auth/crypto.js';
import { query } from '../src/db/pool.js';

export interface TestUser {
  id: string;
  email: string;
  token: string;
  workspaceId: string;
}

let appSingleton: FastifyInstance | null = null;

export async function getApp(): Promise<FastifyInstance> {
  if (!appSingleton) {
    appSingleton = await buildApp();
    await appSingleton.ready();
  }
  return appSingleton;
}

let counter = 0;

/**
 * Creates a user through the real signup flow. The very first user in the
 * test database becomes admin and completes real TOTP enrollment, exactly
 * as production enforces.
 */
export async function createUser(role: 'admin' | 'editor' | 'viewer' = 'editor'): Promise<TestUser> {
  const app = await getApp();
  counter += 1;
  const email = `user${counter}-${Date.now()}@test.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: {
      email,
      name: `Test User ${counter}`,
      password: 'CorrectHorse9!stn',
      consent: { terms: true, privacy: true, researchContact: false },
    },
  });
  if (signup.statusCode !== 201) throw new Error(`signup failed: ${signup.body}`);
  let body = signup.json() as { accessToken: string; user: { id: string; role: string }; mfaSetupRequired?: boolean };

  if (body.mfaSetupRequired) {
    const enable = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/enable',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    const { secret } = enable.json() as { secret: string };
    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      headers: { authorization: `Bearer ${body.accessToken}` },
      payload: { code: totpCode(secret) },
    });
    if (verify.statusCode !== 200) throw new Error(`mfa verify failed: ${verify.body}`);
    body = verify.json() as typeof body;
  }

  // Adjust role directly when the requested role differs from the default.
  if (body.user.role !== role) {
    await query(`UPDATE users SET role = $2 WHERE id = $1`, [body.user.id, role]);
    const { cache } = await import('../src/cache/index.js');
    await cache.del(`userstat:${body.user.id}`);
    if (role === 'admin') {
      // Admins authenticate with MFA; enroll for realism on subsequent logins.
      const relog = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: 'CorrectHorse9!stn' },
      });
      const relogBody = relog.json() as typeof body;
      if (relogBody.mfaSetupRequired) {
        const enable = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/mfa/enable',
          headers: { authorization: `Bearer ${relogBody.accessToken}` },
        });
        const { secret } = enable.json() as { secret: string };
        const verify = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/mfa/verify',
          headers: { authorization: `Bearer ${relogBody.accessToken}` },
          payload: { code: totpCode(secret) },
        });
        body = verify.json() as typeof body;
      } else {
        body = relogBody;
      }
    }
  }

  const ws = await query<{ id: string }>(
    `SELECT workspace_id AS id FROM workspace_members WHERE user_id = $1 LIMIT 1`,
    [body.user.id],
  );
  return {
    id: body.user.id,
    email,
    token: body.accessToken,
    workspaceId: ws.rows[0]!.id,
  };
}

export function auth(user: TestUser): Record<string, string> {
  return { authorization: `Bearer ${user.token}` };
}

export async function makeJurisdiction(name: string, type = 'city', parentName?: string): Promise<string> {
  let parentId: string | null = null;
  if (parentName) {
    const p = await query<{ id: string }>(`SELECT id FROM jurisdictions WHERE name = $1 LIMIT 1`, [parentName]);
    parentId = p.rows[0]?.id ?? null;
    if (!parentId) {
      const created = await query<{ id: string }>(
        `INSERT INTO jurisdictions (name, type) VALUES ($1, 'state') RETURNING id`,
        [parentName],
      );
      parentId = created.rows[0]!.id;
    }
  }
  const { rows } = await query<{ id: string }>(
    `INSERT INTO jurisdictions (name, type, parent_id) VALUES ($1, $2, $3)
     ON CONFLICT (lower(name), type) DO UPDATE SET parent_id = EXCLUDED.parent_id RETURNING id`,
    [name, type, parentId],
  );
  return rows[0]!.id;
}

export async function makeSource(name: string, type = 'ngo', verification = 'verified'): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO sources (name, type, verification_status, last_verified_at)
     VALUES ($1, $2, $3, CASE WHEN $3 = 'verified' THEN now() ELSE NULL END)
     ON CONFLICT (lower(name)) DO UPDATE SET verification_status = EXCLUDED.verification_status
     RETURNING id`,
    [name, type, verification],
  );
  return rows[0]!.id;
}

/** Drain the DB job queue synchronously (jobs are disabled in test env). */
export async function pumpJobs(max = 20): Promise<number> {
  const { claimAndRunOne } = await import('../src/jobs/queue.js');
  const { startScheduler } = await import('../src/jobs/scheduler.js');
  await startScheduler(); // registers handlers only (JOBS_ENABLED=false)
  let ran = 0;
  for (let i = 0; i < max; i += 1) {
    if (!(await claimAndRunOne())) break;
    ran += 1;
  }
  return ran;
}
