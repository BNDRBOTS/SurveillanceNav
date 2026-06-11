import type { FastifyInstance } from 'fastify';
import {
  createPolicySchema,
  updatePolicySchema,
  listPoliciesQuery,
  uuid as uuidSchema,
} from '@stn/shared';
import { parseOrThrow, paginate } from '../lib/validation.js';
import { query, queryOne } from '../db/pool.js';
import { requireRole } from '../plugins/auth.js';
import { notFound } from '../lib/errors.js';
import { audit } from '../services/audit.js';

const POLICY_SELECT = `
  p.id, p.jurisdiction_id AS "jurisdictionId", j.name AS "jurisdictionName",
  p.title, to_char(p.effective_date,'YYYY-MM-DD') AS "effectiveDate",
  p.source_url AS "sourceUrl", p.content, p.created_at AS "createdAt", p.updated_at AS "updatedAt"
`;

export function registerPolicyRoutes(app: FastifyInstance): void {
  app.get('/policies', async (req) => {
    const q = parseOrThrow(listPoliciesQuery, req.query);
    const clauses = ['p.deleted_at IS NULL'];
    const params: unknown[] = [];
    let i = 1;
    if (q.jurisdictionId) {
      clauses.push(`p.jurisdiction_id = $${i}`);
      params.push(q.jurisdictionId);
      i += 1;
    }
    if (q.q) {
      clauses.push(`p.fts @@ plainto_tsquery('english', $${i})`);
      params.push(q.q);
      i += 1;
    }
    const offset = (q.page - 1) * q.pageSize;
    const { rows } = await query(
      `SELECT ${POLICY_SELECT} FROM policies p
       JOIN jurisdictions j ON j.id = p.jurisdiction_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY p.effective_date DESC LIMIT ${q.pageSize} OFFSET ${offset}`,
      params,
    );
    const total = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM policies p WHERE ${clauses.join(' AND ')}`,
      params,
    );
    return paginate(rows, total?.n ?? 0, q);
  });

  /** Policy timeline for one or more jurisdictions (comparison view). */
  app.get('/policies/timeline', async (req) => {
    const raw = String((req.query as { jurisdictions?: string }).jurisdictions ?? '');
    const ids = raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 4);
    for (const id of ids) parseOrThrow(uuidSchema, id);
    if (ids.length === 0) return { items: [] };
    const { rows } = await query(
      `SELECT ${POLICY_SELECT} FROM policies p
       JOIN jurisdictions j ON j.id = p.jurisdiction_id
       WHERE p.deleted_at IS NULL AND p.jurisdiction_id = ANY($1::uuid[])
       ORDER BY p.effective_date`,
      [ids],
    );
    return { items: rows };
  });

  app.post('/policies', async (req, reply) => {
    requireRole(req, 'editor');
    const body = parseOrThrow(createPolicySchema, req.body);
    const j = await queryOne(`SELECT id FROM jurisdictions WHERE id = $1`, [body.jurisdictionId]);
    if (!j) throw notFound('Jurisdiction');
    const row = await queryOne<{ id: string }>(
      `INSERT INTO policies (jurisdiction_id, title, effective_date, source_url, content, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [body.jurisdictionId, body.title, body.effectiveDate, body.sourceUrl ?? null, body.content, req.user!.id],
    );
    await audit({ actorId: req.user!.id, action: 'policy.created', resource: 'policy', resourceId: row!.id, ip: req.ip });
    const full = await queryOne(
      `SELECT ${POLICY_SELECT} FROM policies p JOIN jurisdictions j ON j.id = p.jurisdiction_id WHERE p.id = $1`,
      [row!.id],
    );
    return reply.status(201).send(full);
  });

  app.patch('/policies/:id', async (req) => {
    requireRole(req, 'editor');
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const body = parseOrThrow(updatePolicySchema, req.body);
    const updated = await queryOne(
      `UPDATE policies SET
         title = COALESCE($2, title),
         effective_date = COALESCE($3::date, effective_date),
         source_url = CASE WHEN $4 = 'set' THEN $5 ELSE source_url END,
         content = COALESCE($6, content),
         jurisdiction_id = COALESCE($7::uuid, jurisdiction_id)
       WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [
        id,
        body.title ?? null,
        body.effectiveDate ?? null,
        body.sourceUrl !== undefined ? 'set' : 'keep',
        body.sourceUrl ?? null,
        body.content ?? null,
        body.jurisdictionId ?? null,
      ],
    );
    if (!updated) throw notFound('Policy');
    await audit({ actorId: req.user!.id, action: 'policy.updated', resource: 'policy', resourceId: id, ip: req.ip });
    return await queryOne(
      `SELECT ${POLICY_SELECT} FROM policies p JOIN jurisdictions j ON j.id = p.jurisdiction_id WHERE p.id = $1`,
      [id],
    );
  });

  app.delete('/policies/:id', async (req) => {
    requireRole(req, 'admin');
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const res = await query(`UPDATE policies SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (res.rowCount === 0) throw notFound('Policy');
    await audit({ actorId: req.user!.id, action: 'policy.deleted', resource: 'policy', resourceId: id, ip: req.ip });
    return { ok: true };
  });
}
