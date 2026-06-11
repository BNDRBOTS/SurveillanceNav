import type { FastifyInstance } from 'fastify';
import { updateMeSchema, type UserPublic } from '@stn/shared';
import { parseOrThrow } from '../lib/validation.js';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { requireAuth, invalidateUserStatusCache } from '../plugins/auth.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../auth/crypto.js';
import { audit } from '../services/audit.js';

interface DbUserRow {
  id: string;
  email: string;
  name: string;
  role: UserPublic['role'];
  status: UserPublic['status'];
  mfa_enabled: boolean;
  consent_flags: Record<string, boolean>;
  created_at: string;
  last_login_at: string | null;
  password_hash: string;
}

const toPublic = (u: DbUserRow): UserPublic => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  status: u.status,
  mfaEnabled: u.mfa_enabled,
  consentFlags: u.consent_flags ?? {},
  createdAt: u.created_at,
  lastLoginAt: u.last_login_at,
});

export function registerUserRoutes(app: FastifyInstance): void {
  app.get('/users/me', async (req) => {
    requireAuth(req);
    const user = await queryOne<DbUserRow>(`SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL`, [req.user!.id]);
    if (!user) throw unauthorized();
    return toPublic(user);
  });

  app.patch('/users/me', async (req) => {
    requireAuth(req);
    const body = parseOrThrow(updateMeSchema, req.body);
    const user = await queryOne<DbUserRow>(`SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL`, [req.user!.id]);
    if (!user) throw unauthorized();

    if (body.newPassword) {
      if (!(await verifyPassword(body.currentPassword ?? '', user.password_hash))) {
        throw badRequest('Current password is incorrect');
      }
      await query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [user.id, await hashPassword(body.newPassword)]);
      await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [user.id]);
      await audit({ actorId: user.id, action: 'user.password_changed', resource: 'user', resourceId: user.id, ip: req.ip });
    }
    if (body.name) {
      await query(`UPDATE users SET name = $2 WHERE id = $1`, [user.id, body.name]);
    }
    if (body.consent) {
      await query(
        `UPDATE users SET consent_flags = consent_flags || $2::jsonb WHERE id = $1`,
        [user.id, JSON.stringify({ researchContact: body.consent.researchContact })],
      );
    }
    const fresh = await queryOne<DbUserRow>(`SELECT * FROM users WHERE id = $1`, [user.id]);
    return toPublic(fresh!);
  });

  /**
   * GDPR/CCPA deletion: soft-delete immediately (account unusable, sessions
   * revoked, email freed), then the retention job hard-anonymizes content
   * after DELETED_USER_PURGE_DAYS. Community contributions are preserved
   * but de-attributed, per the published privacy policy.
   */
  app.delete('/users/me', async (req) => {
    requireAuth(req);
    const userId = req.user!.id;
    await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE users SET status = 'deleted', deleted_at = now(),
           email = 'deleted+' || id || '@redacted.invalid',
           name = 'Deleted user', mfa_secret = NULL, mfa_enabled = false
         WHERE id = $1`,
        [userId],
      );
      await tx.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
      await tx.query(`DELETE FROM workspace_members WHERE user_id = $1`, [userId]);
    });
    await invalidateUserStatusCache(userId);
    await audit({ actorId: userId, action: 'user.deleted_self', resource: 'user', resourceId: userId, ip: req.ip });
    return { ok: true, message: 'Your account is deleted. Contributions are de-attributed within 30 days.' };
  });

  /** Export everything we hold about the requester (GDPR data portability). */
  app.get('/users/me/data', async (req) => {
    requireAuth(req);
    const userId = req.user!.id;
    const [user, memberships, assets, foia, disputes, comments, auditTrail] = await Promise.all([
      queryOne(`SELECT id, email, name, role, status, consent_flags, created_at, last_login_at FROM users WHERE id = $1`, [userId]),
      query(`SELECT w.name, m.role, m.created_at FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1`, [userId]),
      query(`SELECT id, name, technology_type, created_at FROM surveillance_assets WHERE created_by = $1 AND deleted_at IS NULL`, [userId]),
      query(`SELECT id, subject, status, created_at FROM foia_requests WHERE created_by = $1 AND deleted_at IS NULL`, [userId]),
      query(`SELECT id, asset_id, status, created_at FROM disputes WHERE user_id = $1`, [userId]),
      query(`SELECT id, asset_id, body, created_at FROM comments WHERE user_id = $1 AND deleted_at IS NULL`, [userId]),
      query(`SELECT action, resource, created_at FROM audit_logs WHERE actor_id = $1 ORDER BY created_at DESC LIMIT 1000`, [userId]),
    ]);
    await audit({ actorId: userId, action: 'user.data_export', resource: 'user', resourceId: userId, ip: req.ip });
    return {
      exportedAt: new Date().toISOString(),
      account: user,
      workspaces: memberships.rows,
      contributedAssets: assets.rows,
      foiaRequests: foia.rows,
      disputes: disputes.rows,
      comments: comments.rows,
      recentActivity: auditTrail.rows,
    };
  });

  /** Notifications (bell). */
  app.get('/users/me/notifications', async (req) => {
    requireAuth(req);
    const { rows } = await query(
      `SELECT id, kind, title, body, link, read_at AS "readAt", created_at AS "createdAt"
       FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user!.id],
    );
    const unread = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
      [req.user!.id],
    );
    return { items: rows, unread: unread?.n ?? 0 };
  });

  app.post('/users/me/notifications/read', async (req) => {
    requireAuth(req);
    const body = (req.body ?? {}) as { ids?: string[] };
    if (Array.isArray(body.ids) && body.ids.length > 0 && body.ids.length <= 200) {
      await query(
        `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL`,
        [req.user!.id, body.ids],
      );
    } else {
      await query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [req.user!.id]);
    }
    return { ok: true };
  });
}
