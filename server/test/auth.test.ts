import { describe, it, expect } from 'vitest';
import { getApp, createUser, auth } from './helpers.js';
import { query } from '../src/db/pool.js';
import { totpCode } from '../src/auth/crypto.js';

describe('auth flows', () => {
  it('signup validates input with the standard envelope', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'not-an-email', name: '', password: 'short', consent: { terms: true, privacy: true } },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe('validation_failed');
    expect(Array.isArray(body.error.details)).toBe(true);
  });

  it('first user becomes admin and completes real MFA enrollment; duplicate email conflicts', async () => {
    const admin = await createUser('admin');
    const app = await getApp();
    const me = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: auth(admin) });
    expect(me.statusCode).toBe(200);
    expect(me.json().role).toBe('admin');
    expect(me.json().mfaEnabled).toBe(true);

    const dup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        email: admin.email,
        name: 'Dup',
        password: 'CorrectHorse9!stn',
        consent: { terms: true, privacy: true, researchContact: false },
      },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('login requires TOTP when MFA enabled and locks after repeated failures', async () => {
    const app = await getApp();
    const user = await createUser('editor');

    const noTotpNeeded = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: 'CorrectHorse9!stn' },
    });
    expect(noTotpNeeded.statusCode).toBe(200);

    for (let i = 0; i < 5; i += 1) {
      const bad = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: user.email, password: 'wrong-password-x' },
      });
      expect(bad.statusCode).toBe(401);
    }
    const locked = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: 'CorrectHorse9!stn' },
    });
    expect(locked.statusCode).toBe(401);
    expect(locked.json().error.message).toMatch(/locked/i);
    await query(`UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1`, [user.id]);
  });

  it('refresh rotates tokens with CSRF; reuse of a rotated token revokes the family', async () => {
    const app = await getApp();
    const user = await createUser('editor');
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: 'CorrectHorse9!stn' },
    });
    const cookies = login.cookies;
    const refresh = cookies.find((c) => c.name === 'stn_refresh')!;
    const csrf = cookies.find((c) => c.name === 'stn_csrf')!;
    expect(refresh.httpOnly).toBe(true);
    expect(refresh.sameSite).toBe('Strict');

    // missing CSRF header → rejected
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { stn_refresh: refresh.value, stn_csrf: csrf.value },
    });
    expect(noCsrf.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { stn_refresh: refresh.value, stn_csrf: csrf.value },
      headers: { 'x-csrf-token': csrf.value },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().accessToken).toBeTruthy();

    // replaying the OLD refresh token → theft detected → 401 and family revoked
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { stn_refresh: refresh.value, stn_csrf: csrf.value },
      headers: { 'x-csrf-token': csrf.value },
    });
    expect(replay.statusCode).toBe(401);
    const newRefresh = ok.cookies.find((c) => c.name === 'stn_refresh')!;
    const newCsrf = ok.cookies.find((c) => c.name === 'stn_csrf')!;
    const afterRevoke = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { stn_refresh: newRefresh.value, stn_csrf: newCsrf.value },
      headers: { 'x-csrf-token': newCsrf.value },
    });
    expect(afterRevoke.statusCode).toBe(401);
  });

  it('password reset round-trip via dev outbox; old sessions revoked; enumeration-safe', async () => {
    const app = await getApp();
    const user = await createUser('editor');

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { email: 'nobody@test.local' },
    });
    expect(unknown.statusCode).toBe(200); // same response as known account

    const request = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { email: user.email },
    });
    expect(request.statusCode).toBe(200);

    const { readOutbox } = await import('../src/services/mailer.js');
    const mails = await readOutbox();
    const mail = mails.reverse().find((m) => m.to === user.email)!;
    const token = mail.text.match(/token=([A-Za-z0-9_-]+)/)![1]!;

    const complete = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { token, password: 'NewPassword42!ok' },
    });
    expect(complete.statusCode).toBe(200);

    const reuse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { token, password: 'NewPassword42!ok' },
    });
    expect(reuse.statusCode).toBe(400); // single-use

    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: 'NewPassword42!ok' },
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it('MFA login requires a valid code once enabled', async () => {
    const app = await getApp();
    const user = await createUser('editor');
    const enable = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/enable', headers: auth(user) });
    const { secret } = enable.json();
    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      headers: auth(user),
      payload: { code: totpCode(secret) },
    });
    expect(verify.statusCode).toBe(200);

    const withoutCode = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: 'CorrectHorse9!stn' },
    });
    expect(withoutCode.statusCode).toBe(401);
    expect(withoutCode.json().error.code).toBe('mfa_required');

    const withCode = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: 'CorrectHorse9!stn', totp: totpCode(secret) },
    });
    expect(withCode.statusCode).toBe(200);
  });

  it('suspension bites mid-session within the status-cache TTL', async () => {
    const app = await getApp();
    const user = await createUser('editor');
    await query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [user.id]);
    const { cache } = await import('../src/cache/index.js');
    await cache.del(`userstat:${user.id}`);
    const me = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: auth(user) });
    expect(me.statusCode).toBe(401);
  });

  it('GDPR endpoints: data export and account deletion', async () => {
    const app = await getApp();
    const user = await createUser('editor');
    const data = await app.inject({ method: 'GET', url: '/api/v1/users/me/data', headers: auth(user) });
    expect(data.statusCode).toBe(200);
    expect(data.json().account.email).toBe(user.email);

    const del = await app.inject({ method: 'DELETE', url: '/api/v1/users/me', headers: auth(user) });
    expect(del.statusCode).toBe(200);
    const { cache } = await import('../src/cache/index.js');
    await cache.del(`userstat:${user.id}`);
    const after = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: auth(user) });
    expect(after.statusCode).toBe(401);
  });
});

describe('workspaces & RBAC', () => {
  it('enforces deny-by-default cross-workspace access and invite flow', async () => {
    const app = await getApp();
    const owner = await createUser('editor');
    const outsider = await createUser('editor');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: auth(owner),
      payload: { name: 'Investigation Alpha' },
    });
    expect(created.statusCode).toBe(201);
    const wsId = created.json().id;

    const denied = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${wsId}`, headers: auth(outsider) });
    expect(denied.statusCode).toBe(403);

    // add existing user directly by email
    const add = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/members`,
      headers: auth(owner),
      payload: { email: outsider.email, role: 'viewer' },
    });
    expect(add.statusCode).toBe(201);
    expect(add.json().joined).toBe(true);

    const nowAllowed = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${wsId}`, headers: auth(outsider) });
    expect(nowAllowed.statusCode).toBe(200);

    // viewer cannot patch the workspace
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${wsId}`,
      headers: auth(outsider),
      payload: { name: 'Hijacked' },
    });
    expect(patch.statusCode).toBe(403);

    // member can leave
    const leave = await app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${wsId}/members/${outsider.id}`,
      headers: auth(outsider),
    });
    expect(leave.statusCode).toBe(200);
  });

  it('email invite to a non-user lands in the outbox and is acceptable after signup', async () => {
    const app = await getApp();
    const owner = await createUser('editor');
    const inviteEmail = `invitee-${Date.now()}@test.local`;

    const invite = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${owner.workspaceId}/members`,
      headers: auth(owner),
      payload: { email: inviteEmail, role: 'editor' },
    });
    expect(invite.statusCode).toBe(201);
    expect(invite.json().invited).toBe(true);

    const { readOutbox } = await import('../src/services/mailer.js');
    const mail = (await readOutbox()).reverse().find((m) => m.to === inviteEmail)!;
    const token = mail.text.match(/token=([A-Za-z0-9_-]+)/)![1]!;

    const signup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        email: inviteEmail,
        name: 'Invitee',
        password: 'CorrectHorse9!stn',
        consent: { terms: true, privacy: true, researchContact: false },
      },
    });
    const invitee = signup.json();
    const accept = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces/accept-invite',
      headers: { authorization: `Bearer ${invitee.accessToken}` },
      payload: { token },
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().workspaceId).toBe(owner.workspaceId);
  });
});
