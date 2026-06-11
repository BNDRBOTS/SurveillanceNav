import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  signupSchema,
  loginSchema,
  mfaVerifySchema,
  resetRequestSchema,
  resetCompleteSchema,
  type UserPublic,
  type GlobalRole,
} from '@stn/shared';
import { parseOrThrow } from '../lib/validation.js';
import { query, queryOne, withTransaction } from '../db/pool.js';
import {
  hashPassword,
  verifyPassword,
  signJwt,
  randomToken,
  sha256Hex,
  generateTotpSecret,
  verifyTotp,
  totpUri,
} from '../auth/crypto.js';
import { config } from '../config.js';
import { badRequest, unauthorized, conflict, forbidden } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { sendMail } from '../services/mailer.js';
import { requireAuth, requireCsrf, invalidateUserStatusCache } from '../plugins/auth.js';

interface DbUser {
  id: string;
  email: string;
  name: string;
  role: GlobalRole;
  status: string;
  password_hash: string;
  mfa_enabled: boolean;
  mfa_secret: string | null;
  consent_flags: Record<string, boolean>;
  failed_login_attempts: number;
  locked_until: string | null;
  created_at: string;
  last_login_at: string | null;
}

function toPublic(u: DbUser): UserPublic {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status as UserPublic['status'],
    mfaEnabled: u.mfa_enabled,
    consentFlags: u.consent_flags ?? {},
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

const REFRESH_COOKIE = 'stn_refresh';
const CSRF_COOKIE = 'stn_csrf';

async function issueSession(
  reply: FastifyReply,
  user: DbUser,
  req: FastifyRequest,
  opts: { mfaSetupRequired?: boolean } = {},
) {
  const typ = opts.mfaSetupRequired ? 'mfa_setup' : 'access';
  const accessToken = signJwt({ sub: user.id, role: user.role, typ }, config.jwtSecret, config.accessTokenTtlSec);

  const refreshRaw = randomToken(48);
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, now() + ($3 || ' seconds')::interval, $4, $5)`,
    [user.id, sha256Hex(refreshRaw), String(config.refreshTokenTtlSec), req.ip, (req.headers['user-agent'] ?? '').slice(0, 300)],
  );

  const csrf = randomToken(24);
  reply.setCookie(REFRESH_COOKIE, refreshRaw, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: config.refreshTokenTtlSec,
  });
  reply.setCookie(CSRF_COOKIE, csrf, {
    httpOnly: false,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: '/',
    maxAge: config.refreshTokenTtlSec,
  });

  return {
    accessToken,
    expiresInSec: config.accessTokenTtlSec,
    user: toPublic(user),
    ...(opts.mfaSetupRequired ? { mfaSetupRequired: true } : {}),
  };
}

const LOCK_THRESHOLD = 5;
const LOCK_MINUTES = 15;

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post('/auth/signup', async (req, reply) => {
    const body = parseOrThrow(signupSchema, req.body);

    const existing = await queryOne(`SELECT id FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL`, [
      body.email,
    ]);
    if (existing) throw conflict('An account with this email already exists. Try signing in instead.');

    const passwordHash = await hashPassword(body.password);
    const user = await withTransaction(async (tx) => {
      // First active user bootstraps as admin (documented in README).
      const { rows: countRows } = await tx.query(`SELECT count(*)::int AS n FROM users WHERE deleted_at IS NULL`);
      const isFirst = (countRows[0] as { n: number }).n === 0;
      const { rows } = await tx.query(
        `INSERT INTO users (email, name, role, password_hash, consent_flags)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [
          body.email,
          body.name,
          isFirst ? 'admin' : 'editor',
          passwordHash,
          JSON.stringify({
            terms: true,
            privacy: true,
            researchContact: body.consent.researchContact,
            consentedAt: new Date().toISOString(),
          }),
        ],
      );
      const created = rows[0] as DbUser;
      await tx.query(
        `INSERT INTO workspaces (name, owner_id) VALUES ($1, $2) RETURNING id`,
        [`${body.name.split(' ')[0] ?? body.name}'s workspace`, created.id],
      );
      const { rows: wsRows } = await tx.query(`SELECT id FROM workspaces WHERE owner_id = $1`, [created.id]);
      await tx.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [
        (wsRows[0] as { id: string }).id,
        created.id,
      ]);
      return created;
    });

    await audit({ actorId: user.id, action: 'auth.signup', resource: 'user', resourceId: user.id, ip: req.ip, userAgent: req.headers['user-agent'] });
    // Admins must enroll MFA before receiving full access.
    const needsMfa = user.role === 'admin' && !user.mfa_enabled;
    return reply.status(201).send(await issueSession(reply, user, req, { mfaSetupRequired: needsMfa }));
  });

  app.post('/auth/login', async (req, reply) => {
    const body = parseOrThrow(loginSchema, req.body);
    const user = await queryOne<DbUser>(
      `SELECT * FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
      [body.email],
    );

    const fail = async (reason: string) => {
      if (user) {
        const attempts = user.failed_login_attempts + 1;
        await query(
          `UPDATE users SET failed_login_attempts = $2,
             locked_until = CASE WHEN $2::int >= $3::int THEN now() + interval '${LOCK_MINUTES} minutes' ELSE locked_until END
           WHERE id = $1`,
          [user.id, attempts, LOCK_THRESHOLD],
        );
      }
      await audit({ actorId: user?.id ?? null, action: 'auth.login_failed', resource: 'user', resourceId: user?.id, metadata: { reason }, ip: req.ip, userAgent: req.headers['user-agent'] });
      throw unauthorized('Incorrect email or password');
    };

    if (!user) {
      // Constant-ish time: hash anyway to avoid user-enumeration timing
      await verifyPassword(body.password, 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
      throw unauthorized('Incorrect email or password');
    }
    if (user.status === 'suspended') throw forbidden('This account is suspended. Contact an administrator.');
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      const mins = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60_000);
      throw unauthorized(`Account temporarily locked after repeated failures. Try again in ${mins} min.`);
    }

    if (!(await verifyPassword(body.password, user.password_hash))) return fail('bad_password');

    if (user.mfa_enabled) {
      if (!body.totp) {
        return reply.status(401).send({
          error: { code: 'mfa_required', message: 'Enter the 6-digit code from your authenticator app.' },
        });
      }
      if (!user.mfa_secret || !verifyTotp(user.mfa_secret, body.totp)) return fail('bad_totp');
    }

    await query(
      `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
      [user.id],
    );
    await audit({ actorId: user.id, action: 'auth.login', resource: 'user', resourceId: user.id, ip: req.ip, userAgent: req.headers['user-agent'] });

    const needsMfa = user.role === 'admin' && !user.mfa_enabled;
    return reply.send(await issueSession(reply, user, req, { mfaSetupRequired: needsMfa }));
  });

  app.post('/auth/refresh', async (req, reply) => {
    requireCsrf(req, reply);
    const raw = req.cookies[REFRESH_COOKIE];
    if (!raw) throw unauthorized('Session expired — sign in again');
    const hash = sha256Hex(raw);

    const token = await queryOne<{
      id: string;
      user_id: string;
      expires_at: string;
      revoked_at: string | null;
    }>(`SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1`, [hash]);

    if (!token) throw unauthorized('Session expired — sign in again');
    if (token.revoked_at) {
      // Reuse of a rotated token ⇒ possible theft: revoke the whole family.
      await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [
        token.user_id,
      ]);
      await audit({ actorId: token.user_id, action: 'auth.refresh_reuse_detected', resource: 'user', resourceId: token.user_id, ip: req.ip });
      throw unauthorized('Session invalidated for safety — sign in again');
    }
    if (new Date(token.expires_at).getTime() < Date.now()) throw unauthorized('Session expired — sign in again');

    const user = await queryOne<DbUser>(`SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL`, [token.user_id]);
    if (!user || user.status !== 'active') throw unauthorized('Account unavailable');

    const session = await issueSession(reply, user, req, {
      mfaSetupRequired: user.role === 'admin' && !user.mfa_enabled,
    });
    // Rotate: revoke the presented token and link it to its replacement.
    const newest = await queryOne<{ id: string }>(
      `SELECT id FROM refresh_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [user.id],
    );
    await query(`UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1`, [
      token.id,
      newest?.id ?? null,
    ]);
    return reply.send(session);
  });

  app.post('/auth/logout', async (req, reply) => {
    const raw = req.cookies[REFRESH_COOKIE];
    if (raw) {
      await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [
        sha256Hex(raw),
      ]);
    }
    if (req.user) {
      await audit({ actorId: req.user.id, action: 'auth.logout', resource: 'user', resourceId: req.user.id, ip: req.ip });
    }
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  app.post('/auth/mfa/enable', async (req) => {
    if (!req.user) throw unauthorized('Sign in to continue');
    const user = await queryOne<DbUser>(`SELECT * FROM users WHERE id = $1`, [req.user.id]);
    if (!user) throw unauthorized();
    if (user.mfa_enabled) throw badRequest('MFA is already enabled on this account');
    const secret = generateTotpSecret();
    await query(`UPDATE users SET mfa_secret = $2 WHERE id = $1`, [user.id, secret]);
    return {
      secret,
      otpauthUrl: totpUri(secret, user.email),
      message: 'Scan the QR/secret in your authenticator app, then verify a code to activate.',
    };
  });

  app.post('/auth/mfa/verify', async (req, reply) => {
    if (!req.user) throw unauthorized('Sign in to continue');
    const body = parseOrThrow(mfaVerifySchema, req.body);
    const user = await queryOne<DbUser>(`SELECT * FROM users WHERE id = $1`, [req.user.id]);
    if (!user?.mfa_secret) throw badRequest('Start MFA enrollment first');
    if (!verifyTotp(user.mfa_secret, body.code)) {
      throw badRequest('That code didn’t match. Codes rotate every 30 seconds — try the current one.');
    }
    await query(`UPDATE users SET mfa_enabled = true WHERE id = $1`, [user.id]);
    await invalidateUserStatusCache(user.id);
    await audit({ actorId: user.id, action: 'auth.mfa_enabled', resource: 'user', resourceId: user.id, ip: req.ip });
    const fresh = await queryOne<DbUser>(`SELECT * FROM users WHERE id = $1`, [user.id]);
    return reply.send(await issueSession(reply, fresh!, req));
  });

  app.post('/auth/reset-password', async (req) => {
    const body = req.body as Record<string, unknown> | null;
    // Two-phase endpoint: {email} requests a reset; {token, password} completes it.
    if (body && typeof body === 'object' && 'token' in body) {
      const { token, password: newPassword } = parseOrThrow(resetCompleteSchema, body);
      const row = await queryOne<{ id: string; user_id: string; expires_at: string; used_at: string | null }>(
        `SELECT * FROM password_resets WHERE token_hash = $1`,
        [sha256Hex(token)],
      );
      if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
        throw badRequest('This reset link is invalid or has expired. Request a new one.');
      }
      const passwordHash = await hashPassword(newPassword);
      await withTransaction(async (tx) => {
        await tx.query(`UPDATE users SET password_hash = $2, failed_login_attempts = 0, locked_until = NULL WHERE id = $1`, [row.user_id, passwordHash]);
        await tx.query(`UPDATE password_resets SET used_at = now() WHERE id = $1`, [row.id]);
        await tx.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [row.user_id]);
      });
      await audit({ actorId: row.user_id, action: 'auth.password_reset', resource: 'user', resourceId: row.user_id, ip: req.ip });
      return { ok: true, message: 'Password updated. Sign in with your new password.' };
    }

    const { email } = parseOrThrow(resetRequestSchema, body);
    const user = await queryOne<DbUser>(`SELECT * FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL`, [email]);
    if (user) {
      const token = randomToken(32);
      await query(
        `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
        [user.id, sha256Hex(token)],
      );
      await sendMail({
        to: user.email,
        subject: 'Reset your Lens of Light password',
        text: `Hi ${user.name},\n\nReset your password within 1 hour:\n${config.publicUrl}/reset-password?token=${token}\n\nIf you didn’t request this, you can ignore this email — your password is unchanged.`,
      });
      await audit({ actorId: user.id, action: 'auth.password_reset_requested', resource: 'user', resourceId: user.id, ip: req.ip });
    }
    // Identical response whether or not the account exists (no enumeration).
    return { ok: true, message: 'If that email has an account, a reset link is on its way.' };
  });

  app.get('/auth/csrf', async (req, reply) => {
    // Bootstraps the CSRF cookie for clients restoring a session.
    if (!req.cookies[CSRF_COOKIE]) {
      reply.setCookie(CSRF_COOKIE, randomToken(24), {
        httpOnly: false,
        secure: config.cookieSecure,
        sameSite: 'strict',
        path: '/',
        maxAge: config.refreshTokenTtlSec,
      });
    }
    return { ok: true };
  });

  // GDPR/CCPA-ready account endpoints live under /users (see users.ts);
  // session-wide revocation for safety tooling:
  app.post('/auth/revoke-all', async (req) => {
    requireAuth(req);
    await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [req.user!.id]);
    await audit({ actorId: req.user!.id, action: 'auth.revoke_all_sessions', resource: 'user', resourceId: req.user!.id, ip: req.ip });
    return { ok: true, message: 'All sessions revoked.' };
  });
}
