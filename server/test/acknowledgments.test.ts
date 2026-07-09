import { describe, it, expect } from 'vitest';
import { DISCLAIMER_VERSIONS } from '@stn/shared';
import { getApp, createUser, auth } from './helpers.js';
import { query } from '../src/db/pool.js';

describe('disclaimer acknowledgments', () => {
  it('records and lists versioned acknowledgments', async () => {
    const app = await getApp();
    const user = await createUser('editor'); // helper acks everything
    const res = await app.inject({ method: 'GET', url: '/api/v1/users/me/acknowledgments', headers: auth(user) });
    expect(res.statusCode).toBe(200);
    const { items, current } = res.json();
    expect(current).toEqual(DISCLAIMER_VERSIONS);
    const keys = items.map((i: { key: string }) => i.key);
    expect(keys).toContain('entry');
    expect(keys).toContain('foia-legal');
  });

  it('rejects stale versions and unknown keys', async () => {
    const app = await getApp();
    const user = await createUser('editor');
    const stale = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/acknowledgments',
      headers: auth(user),
      payload: { key: 'entry', version: 999 },
    });
    expect(stale.statusCode).toBe(400);
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/acknowledgments',
      headers: auth(user),
      payload: { key: 'made-up', version: 1 },
    });
    expect(unknown.statusCode).toBe(422);
  });

  it('POST /foia refuses with ack_required until foia-legal is acknowledged', async () => {
    const app = await getApp();
    const user = await createUser('editor');
    // simulate a pre-acknowledgment account
    await query(`DELETE FROM acknowledgments WHERE user_id = $1 AND key = 'foia-legal'`, [user.id]);

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/foia',
      headers: auth(user),
      payload: { workspaceId: user.workspaceId, subject: 'Test request', body: 'Please provide records.' },
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.code).toBe('ack_required');

    const ack = await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/acknowledgments',
      headers: auth(user),
      payload: { key: 'foia-legal', version: DISCLAIMER_VERSIONS['foia-legal'] },
    });
    expect(ack.statusCode).toBe(200);

    const allowed = await app.inject({
      method: 'POST',
      url: '/api/v1/foia',
      headers: auth(user),
      payload: { workspaceId: user.workspaceId, subject: 'Test request', body: 'Please provide records.' },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it('acknowledgment history is append-only across versions', async () => {
    const app = await getApp();
    const user = await createUser('editor');
    // same version twice → one row (idempotent), history preserved
    await app.inject({
      method: 'POST',
      url: '/api/v1/users/me/acknowledgments',
      headers: auth(user),
      payload: { key: 'entry', version: DISCLAIMER_VERSIONS.entry },
    });
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM acknowledgments WHERE user_id = $1 AND key = 'entry'`,
      [user.id],
    );
    expect(rows[0]!.n).toBe(1);
  });
});
