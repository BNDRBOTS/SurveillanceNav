import type { FastifyInstance } from 'fastify';
import {
  parseProcurementSchema,
  updateProcurementSchema,
  listProcurementsQuery,
  uuid as uuidSchema,
  LIMITS,
} from '@stn/shared';
import { parseOrThrow, paginate } from '../lib/validation.js';
import { query, queryOne } from '../db/pool.js';
import { requireRole, requireAuth } from '../plugins/auth.js';
import { badRequest, notFound, payloadTooLarge } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { storage } from '../storage/index.js';
import { enqueueJob } from '../jobs/queue.js';
import { detectPii } from '../services/scanner.js';
import { scanUpload } from '../services/scanner.js';

const PROC_SELECT = `
  p.id, p.jurisdiction_id AS "jurisdictionId", j.name AS "jurisdictionName",
  p.vendor, p.title, p.amount::float8 AS amount, p.currency,
  to_char(p.start_date,'YYYY-MM-DD') AS "startDate", to_char(p.end_date,'YYYY-MM-DD') AS "endDate",
  p.technology_terms AS "technologyTerms", p.confidence_score AS "confidenceScore",
  p.raw_file_key AS "rawFileKey", p.normalized, p.review_status AS "reviewStatus",
  p.created_at AS "createdAt", p.updated_at AS "updatedAt"
`;

export function registerProcurementRoutes(app: FastifyInstance): void {
  /**
   * POST /procurement/parse — accepts either JSON {text} (paste) or
   * multipart PDF/text upload. Creates a procurement shell and an async
   * parse job; returns 202 + job id for polling.
   */
  app.post('/procurement/parse', async (req, reply) => {
    requireRole(req, 'editor');

    let text: string | undefined;
    let title = 'Untitled procurement document';
    let jurisdictionId: string | null = null;
    let rawFileKey: string | null = null;

    if (req.isMultipart()) {
      const file = await req.file();
      if (!file) throw badRequest('Attach a document (multipart field "file")');
      const buf = await file.toBuffer().catch(() => {
        throw payloadTooLarge(`Files are limited to ${Math.round(LIMITS.uploadMaxBytes / 1024 / 1024)}MB`);
      });
      if (!['application/pdf', 'text/plain', 'text/csv'].includes(file.mimetype)) {
        throw badRequest('Procurement parsing accepts PDF or plain-text files.');
      }
      const scan = await scanUpload(buf, file.mimetype);
      if (scan.malware === 'quarantined') {
        return reply.status(202).send({
          ok: false,
          quarantined: true,
          message: 'This file failed the safety scan and was quarantined. Parsing was not started.',
          reasons: scan.malwareReasons,
        });
      }
      title = (file.filename || title).slice(0, 200);
      rawFileKey = `procurement/${Date.now()}-${title.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      await storage.put(rawFileKey, buf, file.mimetype);
      const fields = file.fields as Record<string, { value?: string } | undefined>;
      const jId = fields?.jurisdictionId?.value;
      if (jId) {
        parseOrThrow(uuidSchema, jId);
        jurisdictionId = jId;
      }
    } else {
      const body = parseOrThrow(parseProcurementSchema, req.body);
      if (!body.text || body.text.trim().length < 20) {
        throw badRequest('Paste at least a paragraph of contract/RFP text, or upload a PDF.');
      }
      text = body.text;
      title = body.title || `Pasted document ${new Date().toISOString().slice(0, 10)}`;
      jurisdictionId = body.jurisdictionId ?? null;
    }

    const proc = await queryOne<{ id: string }>(
      `INSERT INTO procurements (jurisdiction_id, title, raw_file_key, created_by, review_status)
       VALUES ($1, $2, $3, $4, 'needs_review') RETURNING id`,
      [jurisdictionId, title, rawFileKey, req.user!.id],
    );
    // Pasted contract text legitimately contains contact info — never block,
    // but surface detected kinds into the human-review pass.
    const pastePii = text ? detectPii(text) : [];
    const jobId = await enqueueJob('parse_procurement', {
      procurementId: proc!.id,
      ...(text ? { text } : {}),
      ...(pastePii.length ? { piiKinds: pastePii } : {}),
    });
    await audit({ actorId: req.user!.id, action: 'procurement.parse_started', resource: 'procurement', resourceId: proc!.id, ip: req.ip });
    return reply.status(202).send({
      ok: true,
      procurementId: proc!.id,
      jobId,
      message: 'Parsing started. Poll the job, then review extracted fields before approval.',
    });
  });

  app.get('/procurement/jobs/:jobId', async (req) => {
    requireAuth(req);
    const jobId = parseOrThrow(uuidSchema, (req.params as { jobId: string }).jobId);
    const job = await queryOne<{
      id: string;
      status: string;
      attempts: number;
      last_error: string | null;
      result: Record<string, unknown> | null;
      payload: Record<string, unknown>;
    }>(`SELECT id, status, attempts, last_error, result, payload FROM jobs WHERE id = $1`, [jobId]);
    if (!job) throw notFound('Job');
    return {
      id: job.id,
      status: job.status,
      attempts: job.attempts,
      error: job.last_error,
      result: job.result,
      procurementId: (job.payload as { procurementId?: string }).procurementId ?? null,
    };
  });

  app.get('/procurements', async (req) => {
    const q = parseOrThrow(listProcurementsQuery, req.query);
    const clauses = ['p.deleted_at IS NULL'];
    const params: unknown[] = [];
    let i = 1;
    if (q.jurisdictionId) {
      clauses.push(`p.jurisdiction_id = $${i}`);
      params.push(q.jurisdictionId);
      i += 1;
    }
    if (q.vendor) {
      clauses.push(`p.vendor ILIKE $${i}`);
      params.push(`%${q.vendor}%`);
      i += 1;
    }
    if (q.reviewStatus) {
      clauses.push(`p.review_status = $${i}`);
      params.push(q.reviewStatus);
      i += 1;
    }
    if (q.q) {
      clauses.push(`p.fts @@ plainto_tsquery('english', $${i})`);
      params.push(q.q);
      i += 1;
    }
    const offset = (q.page - 1) * q.pageSize;
    const { rows } = await query(
      `SELECT ${PROC_SELECT} FROM procurements p
       LEFT JOIN jurisdictions j ON j.id = p.jurisdiction_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY p.created_at DESC LIMIT ${q.pageSize} OFFSET ${offset}`,
      params,
    );
    const total = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM procurements p WHERE ${clauses.join(' AND ')}`,
      params,
    );
    return paginate(rows, total?.n ?? 0, q);
  });

  app.get('/procurements/:id', async (req) => {
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const proc = await queryOne(
      `SELECT ${PROC_SELECT}, p.raw_text_excerpt AS "rawTextExcerpt"
       FROM procurements p LEFT JOIN jurisdictions j ON j.id = p.jurisdiction_id
       WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [id],
    );
    if (!proc) throw notFound('Procurement');
    return proc;
  });

  app.patch('/procurements/:id', async (req) => {
    requireRole(req, 'editor');
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const body = parseOrThrow(updateProcurementSchema, req.body);
    const existing = await queryOne(`SELECT id FROM procurements WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!existing) throw notFound('Procurement');

    // Approval is an admin act (publishes data into analytics/exports).
    if (body.reviewStatus === 'approved') requireRole(req, 'admin');

    const updated = await queryOne(
      `UPDATE procurements SET
         vendor = CASE WHEN $2 = 'set' THEN $3 ELSE vendor END,
         title = COALESCE($4, title),
         amount = CASE WHEN $5 = 'set' THEN $6::numeric ELSE amount END,
         start_date = CASE WHEN $7 = 'set' THEN $8::date ELSE start_date END,
         end_date = CASE WHEN $9 = 'set' THEN $10::date ELSE end_date END,
         technology_terms = COALESCE($11, technology_terms),
         jurisdiction_id = CASE WHEN $12 = 'set' THEN $13::uuid ELSE jurisdiction_id END,
         review_status = COALESCE($14, review_status)
       WHERE id = $1 RETURNING id`,
      [
        id,
        body.vendor !== undefined ? 'set' : 'keep',
        body.vendor ?? null,
        body.title ?? null,
        body.amount !== undefined ? 'set' : 'keep',
        body.amount ?? null,
        body.startDate !== undefined ? 'set' : 'keep',
        body.startDate ?? null,
        body.endDate !== undefined ? 'set' : 'keep',
        body.endDate ?? null,
        body.technologyTerms ?? null,
        body.jurisdictionId !== undefined ? 'set' : 'keep',
        body.jurisdictionId ?? null,
        body.reviewStatus ?? null,
      ],
    );
    if (!updated) throw notFound('Procurement');
    await audit({ actorId: req.user!.id, action: 'procurement.updated', resource: 'procurement', resourceId: id, metadata: { reviewStatus: body.reviewStatus }, ip: req.ip });
    return await queryOne(
      `SELECT ${PROC_SELECT} FROM procurements p LEFT JOIN jurisdictions j ON j.id = p.jurisdiction_id WHERE p.id = $1`,
      [id],
    );
  });
}
