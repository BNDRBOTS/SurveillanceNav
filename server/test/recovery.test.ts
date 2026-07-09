import { describe, it, expect } from 'vitest';
import { getApp } from './helpers.js';
import { query } from '../src/db/pool.js';
import { readOutbox } from '../src/services/mailer.js';

let counter = 900;
async function signupWithCodes() {
  const app = await getApp();
  counter += 1;
  const email = `rec${counter}-${Date.now()}@test.local`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: {
      email,
      name: `Recovery Tester ${counter}`,
      password: 'CorrectHorse9!stn',
      consent: { terms: true, privacy: true, researchContact: false },
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { accessToken: string; recoveryCodes: string[]; user: { id: string } };
  return { app, email, ...body };
}

describe('recovery codes', () => {
  it('signup issues 10 one-time codes in the documented format', async () => {
    const { recoveryCodes } = await signupWithCodes();
    expect(recoveryCodes).toHaveLength(10);
    for (const code of recoveryCodes) expect(code).toMatch(/^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
    expect(new Set(recoveryCodes).size).toBe(10);
  });

  it('reports remaining count and regenerates only with the correct password', async () => {
    const { app, accessToken } = await signupWithCodes();
    const auth = { authorization: `Bearer ${accessToken}` };

    const status = await app.inject({ method: 'GET', url: '/api/v1/auth/recovery-codes', headers: auth });
    expect(status.json()).toMatchObject({ remaining: 10 });

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery-codes',
      headers: auth,
      payload: { currentPassword: 'not-my-password-1!' },
    });
    expect(wrong.statusCode).toBe(401);

    const regen = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery-codes',
      headers: auth,
      payload: { currentPassword: 'CorrectHorse9!stn' },
    });
    expect(regen.statusCode).toBe(200);
    expect(regen.json().recoveryCodes).toHaveLength(10);
  });

  it('resets the password via email + recovery code, consuming the code', async () => {
    const { app, email, recoveryCodes } = await signupWithCodes();
    const code = recoveryCodes[0]!;

    const reset = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { email, recoveryCode: code.toLowerCase().replace(/-/g, ' '), password: 'BrandNew42!pass' },
    });
    expect(reset.statusCode).toBe(200);

    const reuse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { email, recoveryCode: code, password: 'Another42!pass' },
    });
    expect(reuse.statusCode).toBe(400); // consumed

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'BrandNew42!pass' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('rejects a valid-looking code paired with the wrong email, generically', async () => {
    const { app, recoveryCodes } = await signupWithCodes();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { email: 'someone-else@test.local', recoveryCode: recoveryCodes[1]!, password: 'BrandNew42!pass' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('didn’t match');
  });
});

describe('unknown-address identification (email mode default)', () => {
  it('sends a "no account" notice to unregistered addresses, once per 24h, with a neutral screen response', async () => {
    const app = await getApp();
    const ghost = `ghost-${Date.now()}@test.local`;

    const first = await app.inject({ method: 'POST', url: '/api/v1/auth/reset-password', payload: { email: ghost } });
    expect(first.statusCode).toBe(200);
    expect(first.json().registered).toBeUndefined(); // neutral in email mode

    const mails = await readOutbox();
    const notices = mails.filter((m) => m.to === ghost && m.subject.includes('No Lens of Light account'));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain('no account exists under it');

    // throttled: second request within 24h sends no second mail
    const second = await app.inject({ method: 'POST', url: '/api/v1/auth/reset-password', payload: { email: ghost } });
    expect(second.statusCode).toBe(200);
    const mailsAfter = await readOutbox();
    expect(mailsAfter.filter((m) => m.to === ghost).length).toBe(1);

    // and the response body is byte-identical to a registered address's
    const { email } = await signupWithCodes();
    const known = await app.inject({ method: 'POST', url: '/api/v1/auth/reset-password', payload: { email } });
    expect(known.body).toBe(second.body);
  });

  it('on-screen mode states registration status directly when the admin enables it', async () => {
    const app = await getApp();
    await query(
      `INSERT INTO app_settings (key, value) VALUES ('auth.resetDisclosure', '{"mode":"on-screen"}')
       ON CONFLICT (key) DO UPDATE SET value = '{"mode":"on-screen"}'`,
    );
    const { cache } = await import('../src/cache/index.js');
    await cache.del('settings:resetDisclosure');

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { email: `nobody-${Date.now()}@test.local` },
    });
    expect(unknown.json()).toMatchObject({ ok: true, registered: false });
    expect(unknown.json().message).toContain('No account exists');

    const { email } = await signupWithCodes();
    const known = await app.inject({ method: 'POST', url: '/api/v1/auth/reset-password', payload: { email } });
    expect(known.json()).toMatchObject({ ok: true, registered: true });

    await query(`DELETE FROM app_settings WHERE key = 'auth.resetDisclosure'`);
    await cache.del('settings:resetDisclosure');
  });
});

describe('recovery code at login (MFA substitute)', () => {
  it('a recovery code substitutes for TOTP and notifies the account', async () => {
    const { app, email, accessToken, recoveryCodes } = await signupWithCodes();
    const auth = { authorization: `Bearer ${accessToken}` };

    // enroll MFA for real
    const enable = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/enable', headers: auth });
    const secret = enable.json().secret as string;
    const { totpCode } = await import('../src/auth/crypto.js');
    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      headers: auth,
      payload: { code: totpCode(secret) },
    });
    expect(verify.statusCode).toBe(200);

    // TOTP-less login now requires a second factor
    const bare = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'CorrectHorse9!stn' },
    });
    expect(bare.statusCode).toBe(401);
    expect(bare.json().error.code).toBe('mfa_required');

    // recovery code succeeds instead of TOTP
    const viaCode = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'CorrectHorse9!stn', recoveryCode: recoveryCodes[2]! },
    });
    expect(viaCode.statusCode).toBe(200);

    const mails = await readOutbox();
    const alert = mails.reverse().find((m) => m.to === email && m.subject.includes('recovery code was used'));
    expect(alert).toBeDefined();

    // same code again fails
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'CorrectHorse9!stn', recoveryCode: recoveryCodes[2]! },
    });
    expect(replay.statusCode).toBe(401);
  });
});
