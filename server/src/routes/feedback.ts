import type { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db/pool.js';
import { requireAuth, requireRole } from '../plugins/auth.js';
import { badRequest } from '../lib/errors.js';
import { paginate } from '../lib/validation.js';

const CATEGORIES = ['bug', 'suggestion', 'correction', 'other'] as const;
const STATUSES   = ['open', 'reviewed', 'resolved', 'wont_fix'] as const;

function parseBody(b: unknown): { category: string; subject: string; body: string; pageUrl?: string } {
  if (!b || typeof b !== 'object') throw badRequest('Invalid body');
  const { category, subject, body, pageUrl } = b as Record<string, unknown>;
  if (!CATEGORIES.includes(category as typeof CATEGORIES[number])) throw badRequest('Invalid category');
  if (typeof subject !== 'string' || subject.length < 1 || subject.length > 120) throw badRequest('subject must be 1–120 chars');
  if (typeof body !== 'string' || body.length < 1 || body.length > 4000) throw badRequest('body must be 1–4000 chars');
  return {
    category: category as string,
    subject: subject.trim(),
    body: body.trim(),
    pageUrl: typeof pageUrl === 'string' ? pageUrl.slice(0, 500) : undefined,
  };
}

export function registerFeedbackRoutes(app: FastifyInstance): void {
  /* ── POST /feedback  (any authenticated user) ─────────────────── */
  app.post('/feedback', async (req, reply) => {
    requireAuth(req);
    const { category, subject, body, pageUrl } = parseBody(req.body);
    const ua = req.headers['user-agent']?.slice(0, 300) ?? null;

    const row = await queryOne<{ id: string }>(
      `INSERT INTO feedback (user_id, category, subject, body, page_url, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.user!.id, category, subject, body, pageUrl ?? null, ua],
    );
    reply.code(201).send({ id: row!.id });
  });

  /* ── GET /admin/feedback  (admin only) ─────────────────────────── */
  app.get('/admin/feedback', async (req) => {
    requireRole(req, 'admin');
    const qp = req.query as { status?: string; page?: string };
    const page = Math.max(1, Number(qp.page ?? 1) || 1);
    const pageSize = 50;
    const params: unknown[] = [];
    let where = '1=1';
    if (qp.status && STATUSES.includes(qp.status as typeof STATUSES[number])) {
      params.push(qp.status);
      where += ` AND f.status = $${params.length}`;
    }
    const { rows } = await query(
      `SELECT f.id, f.category, f.subject, f.body, f.page_url AS "pageUrl",
              f.status, f.admin_note AS "adminNote",
              f.created_at AS "createdAt", f.updated_at AS "updatedAt",
              u.email AS "userEmail", u.name AS "userName"
       FROM feedback f LEFT JOIN users u ON u.id = f.user_id
       WHERE ${where} ORDER BY f.created_at DESC
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params,
    );
    const total = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM feedback f WHERE ${where}`, params);
    return paginate(rows, total?.n ?? 0, { page, pageSize });
  });

  /* ── PATCH /admin/feedback/:id  (admin only) ───────────────────── */
  app.patch('/admin/feedback/:id', async (req) => {
    requireRole(req, 'admin');
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, unknown>;
    const updates: string[] = [];
    const params: unknown[] = [id];

    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status as typeof STATUSES[number])) throw badRequest('Invalid status');
      params.push(b.status);
      updates.push(`status = $${params.length}`);
    }
    if (b.adminNote !== undefined) {
      if (typeof b.adminNote !== 'string' || b.adminNote.length > 2000) throw badRequest('adminNote too long');
      params.push(b.adminNote.trim());
      updates.push(`admin_note = $${params.length}`);
    }
    if (!updates.length) throw badRequest('Nothing to update');
    updates.push('updated_at = now()');

    const row = await queryOne(
      `UPDATE feedback SET ${updates.join(', ')} WHERE id = $1 RETURNING id, status, admin_note AS "adminNote"`,
      params,
    );
    if (!row) throw badRequest('Not found');
    return row;
  });
}
