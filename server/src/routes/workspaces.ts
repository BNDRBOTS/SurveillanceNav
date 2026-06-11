import type { FastifyInstance } from 'fastify';
import {
  createWorkspaceSchema,
  updateWorkspaceSchema,
  addMemberSchema,
  uuid as uuidSchema,
} from '@stn/shared';
import { parseOrThrow } from '../lib/validation.js';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { requireAuth, workspaceRole } from '../plugins/auth.js';
import { badRequest, notFound, conflict, forbidden } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { sendMail } from '../services/mailer.js';
import { randomToken, sha256Hex } from '../auth/crypto.js';
import { config } from '../config.js';

export function registerWorkspaceRoutes(app: FastifyInstance): void {
  app.get('/workspaces', async (req) => {
    requireAuth(req);
    const { rows } = await query(
      `SELECT w.id, w.name, w.owner_id AS "ownerId", w.settings, w.created_at AS "createdAt",
              w.updated_at AS "updatedAt", m.role,
              (SELECT count(*)::int FROM workspace_members mm WHERE mm.workspace_id = w.id) AS "memberCount"
       FROM workspaces w
       JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $1
       WHERE w.deleted_at IS NULL
       ORDER BY w.created_at`,
      [req.user!.id],
    );
    return { items: rows };
  });

  app.post('/workspaces', async (req, reply) => {
    requireAuth(req);
    const body = parseOrThrow(createWorkspaceSchema, req.body);
    const ws = await withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO workspaces (name, owner_id, settings) VALUES ($1, $2, $3) RETURNING *`,
        [body.name, req.user!.id, JSON.stringify(body.settings)],
      );
      const created = rows[0] as { id: string };
      await tx.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [
        created.id,
        req.user!.id,
      ]);
      return rows[0];
    });
    await audit({ actorId: req.user!.id, action: 'workspace.created', resource: 'workspace', resourceId: (ws as { id: string }).id, ip: req.ip });
    return reply.status(201).send(ws);
  });

  app.get('/workspaces/:id', async (req) => {
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    await workspaceRole(req, id, 'viewer');
    const ws = await queryOne(
      `SELECT id, name, owner_id AS "ownerId", settings, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM workspaces WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (!ws) throw notFound('Workspace');
    const members = await query(
      `SELECT m.workspace_id AS "workspaceId", m.user_id AS "userId", u.email, u.name, m.role, m.created_at AS "createdAt"
       FROM workspace_members m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = $1 ORDER BY m.created_at`,
      [id],
    );
    const invites = await query(
      `SELECT id, email, role, expires_at AS "expiresAt", created_at AS "createdAt"
       FROM workspace_invites WHERE workspace_id = $1 AND accepted_at IS NULL AND expires_at > now()`,
      [id],
    );
    return { ...ws, members: members.rows, pendingInvites: invites.rows };
  });

  app.patch('/workspaces/:id', async (req) => {
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    await workspaceRole(req, id, 'admin');
    const body = parseOrThrow(updateWorkspaceSchema, req.body);
    const ws = await queryOne(
      `UPDATE workspaces SET
         name = COALESCE($2, name),
         settings = CASE WHEN $3::jsonb IS NULL THEN settings ELSE settings || $3::jsonb END
       WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id, body.name ?? null, body.settings ? JSON.stringify(body.settings) : null],
    );
    if (!ws) throw notFound('Workspace');
    await audit({ actorId: req.user!.id, action: 'workspace.updated', resource: 'workspace', resourceId: id, ip: req.ip });
    return ws;
  });

  app.delete('/workspaces/:id', async (req) => {
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    await workspaceRole(req, id, 'admin');
    const ws = await queryOne<{ owner_id: string }>(`SELECT owner_id FROM workspaces WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!ws) throw notFound('Workspace');
    if (ws.owner_id !== req.user!.id && req.user!.role !== 'admin') {
      throw forbidden('Only the workspace owner can delete it');
    }
    await query(`UPDATE workspaces SET deleted_at = now() WHERE id = $1`, [id]);
    await audit({ actorId: req.user!.id, action: 'workspace.deleted', resource: 'workspace', resourceId: id, ip: req.ip });
    return { ok: true };
  });

  /** Invite by email: existing users join instantly; others get a tokenized invite. */
  app.post('/workspaces/:id/members', async (req, reply) => {
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    await workspaceRole(req, id, 'admin');
    const body = parseOrThrow(addMemberSchema, req.body);

    const existingUser = await queryOne<{ id: string; name: string }>(
      `SELECT id, name FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL AND status = 'active'`,
      [body.email],
    );
    const ws = await queryOne<{ name: string }>(`SELECT name FROM workspaces WHERE id = $1`, [id]);
    if (!ws) throw notFound('Workspace');

    if (existingUser) {
      const already = await queryOne(
        `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
        [id, existingUser.id],
      );
      if (already) throw conflict(`${body.email} is already a member of this workspace`);
      await query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)`, [
        id,
        existingUser.id,
        body.role,
      ]);
      await query(
        `INSERT INTO notifications (user_id, kind, title, body, link)
         VALUES ($1, 'workspace_added', $2, $3, $4)`,
        [existingUser.id, `Added to ${ws.name}`, `You were added as ${body.role}.`, `/workspaces/${id}`],
      );
      await audit({ actorId: req.user!.id, action: 'workspace.member_added', resource: 'workspace', resourceId: id, metadata: { member: existingUser.id, role: body.role }, ip: req.ip });
      return reply.status(201).send({ ok: true, joined: true });
    }

    const token = randomToken(32);
    await query(
      `INSERT INTO workspace_invites (workspace_id, email, role, token_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '14 days')`,
      [id, body.email, body.role, sha256Hex(token), req.user!.id],
    );
    await sendMail({
      to: body.email,
      subject: `You're invited to "${ws.name}" on Lens of Light`,
      text: `You've been invited to collaborate on surveillance transparency research.\n\nCreate your account, then accept here:\n${config.publicUrl}/invite?token=${token}\n\nThis invitation expires in 14 days.`,
    });
    await audit({ actorId: req.user!.id, action: 'workspace.invite_sent', resource: 'workspace', resourceId: id, metadata: { email: body.email, role: body.role }, ip: req.ip });
    return reply.status(201).send({ ok: true, invited: true });
  });

  app.post('/workspaces/accept-invite', async (req) => {
    requireAuth(req);
    const raw = (req.body as { token?: string } | null)?.token;
    if (typeof raw !== 'string' || raw.length < 16) throw badRequest('Invalid invite token');
    const invite = await queryOne<{ id: string; workspace_id: string; email: string; role: string }>(
      `SELECT id, workspace_id, email, role FROM workspace_invites
       WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()`,
      [sha256Hex(raw)],
    );
    if (!invite) throw badRequest('This invite is invalid or has expired. Ask for a new one.');
    const me = await queryOne<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [req.user!.id]);
    if (!me || me.email.toLowerCase() !== invite.email.toLowerCase()) {
      throw forbidden(`This invite was sent to ${invite.email}. Sign in with that email to accept.`);
    }
    await withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [invite.workspace_id, req.user!.id, invite.role],
      );
      await tx.query(`UPDATE workspace_invites SET accepted_at = now() WHERE id = $1`, [invite.id]);
    });
    await audit({ actorId: req.user!.id, action: 'workspace.invite_accepted', resource: 'workspace', resourceId: invite.workspace_id, ip: req.ip });
    return { ok: true, workspaceId: invite.workspace_id };
  });

  app.delete('/workspaces/:id/members/:userId', async (req) => {
    const { id, userId } = req.params as { id: string; userId: string };
    parseOrThrow(uuidSchema, id);
    parseOrThrow(uuidSchema, userId);

    // Members may remove themselves (leave); admins may remove anyone.
    if (userId !== req.user?.id) {
      await workspaceRole(req, id, 'admin');
    } else {
      await workspaceRole(req, id, 'viewer');
    }
    const ws = await queryOne<{ owner_id: string }>(`SELECT owner_id FROM workspaces WHERE id = $1`, [id]);
    if (!ws) throw notFound('Workspace');
    if (ws.owner_id === userId) throw badRequest('The owner cannot be removed. Transfer ownership or delete the workspace.');
    const res = await query(`DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [id, userId]);
    if (res.rowCount === 0) throw notFound('Member');
    await audit({ actorId: req.user!.id, action: userId === req.user!.id ? 'workspace.left' : 'workspace.member_removed', resource: 'workspace', resourceId: id, metadata: { member: userId }, ip: req.ip });
    return { ok: true };
  });
}
