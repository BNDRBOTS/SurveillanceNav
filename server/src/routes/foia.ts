import type { FastifyInstance } from 'fastify';
import {
  createFoiaSchema,
  updateFoiaSchema,
  listFoiaQuery,
  uuid as uuidSchema,
  statuteForState,
  computeFoiaDueDate,
  LIMITS,
  ALLOWED_UPLOAD_MIME,
} from '@stn/shared';
import { parseOrThrow, paginate } from '../lib/validation.js';
import { query, queryOne } from '../db/pool.js';
import { requireAuth, workspaceRole } from '../plugins/auth.js';
import { badRequest, notFound, payloadTooLarge } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { scanUpload } from '../services/scanner.js';
import { storage, foiaDocKey, quarantineKey } from '../storage/index.js';

const FOIA_SELECT = `
  f.id, f.workspace_id AS "workspaceId", f.jurisdiction_id AS "jurisdictionId",
  j.name AS "jurisdictionName", f.created_by AS "createdBy", f.status, f.outcome,
  f.subject, f.body, f.foia_number AS "foiaNumber", f.sent_at AS "sentAt", f.due_at AS "dueAt",
  (SELECT count(*)::int FROM foia_documents d WHERE d.request_id = f.id) AS "documentCount",
  f.created_at AS "createdAt", f.updated_at AS "updatedAt"
`;

/** Resolve a jurisdiction's governing statute by walking up to its state. */
async function findStatuteFor(jurisdictionId: string | null) {
  if (!jurisdictionId) return null;
  let current = await queryOne<{ id: string; name: string; type: string; parent_id: string | null }>(
    `SELECT id, name, type, parent_id FROM jurisdictions WHERE id = $1`,
    [jurisdictionId],
  );
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current.type === 'state') return statuteForState(current.name);
    if (current.type === 'country') return null;
    if (!current.parent_id) return null;
    current = await queryOne(`SELECT id, name, type, parent_id FROM jurisdictions WHERE id = $1`, [current.parent_id]);
  }
  return null;
}

const VALID_TRANSITIONS: Record<string, string[]> = {
  draft: ['sent', 'closed'],
  sent: ['acknowledged', 'response', 'appeal', 'closed'],
  acknowledged: ['response', 'appeal', 'closed'],
  response: ['appeal', 'closed'],
  appeal: ['response', 'closed'],
  closed: [],
};

export function registerFoiaRoutes(app: FastifyInstance): void {
  app.get('/foia', async (req) => {
    requireAuth(req);
    const q = parseOrThrow(listFoiaQuery, req.query);
    const clauses = ['f.deleted_at IS NULL'];
    const params: unknown[] = [];
    let i = 1;

    if (q.workspaceId) {
      await workspaceRole(req, q.workspaceId, 'viewer');
      clauses.push(`f.workspace_id = $${i}`);
      params.push(q.workspaceId);
      i += 1;
    } else {
      clauses.push(`f.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = $${i})`);
      params.push(req.user!.id);
      i += 1;
    }
    if (q.status) {
      clauses.push(`f.status = $${i}`);
      params.push(q.status);
      i += 1;
    }
    if (q.q) {
      clauses.push(`(f.subject ILIKE $${i} OR f.body ILIKE $${i})`);
      params.push(`%${q.q}%`);
      i += 1;
    }
    const offset = (q.page - 1) * q.pageSize;
    const { rows } = await query(
      `SELECT ${FOIA_SELECT} FROM foia_requests f
       LEFT JOIN jurisdictions j ON j.id = f.jurisdiction_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY f.updated_at DESC LIMIT ${q.pageSize} OFFSET ${offset}`,
      params,
    );
    const total = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM foia_requests f WHERE ${clauses.join(' AND ')}`,
      params,
    );
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post('/foia', async (req, reply) => {
    requireAuth(req);
    const body = parseOrThrow(createFoiaSchema, req.body);
    await workspaceRole(req, body.workspaceId, 'editor');

    const row = await queryOne<{ id: string }>(
      `INSERT INTO foia_requests (workspace_id, jurisdiction_id, created_by, subject, body, due_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [body.workspaceId, body.jurisdictionId ?? null, req.user!.id, body.subject, body.body, body.dueAt ?? null],
    );
    await audit({ actorId: req.user!.id, action: 'foia.created', resource: 'foia', resourceId: row!.id, ip: req.ip });
    const full = await queryOne(
      `SELECT ${FOIA_SELECT} FROM foia_requests f LEFT JOIN jurisdictions j ON j.id = f.jurisdiction_id WHERE f.id = $1`,
      [row!.id],
    );
    return reply.status(201).send(full);
  });

  /** Compose endpoint: builds a statute-correct request letter (template + jurisdiction). */
  app.post('/foia/compose', async (req) => {
    requireAuth(req);
    const body = (req.body ?? {}) as { templateId?: string; jurisdictionId?: string; requesterName?: string; organization?: string; recordsWindowMonths?: number };
    if (!body.templateId) throw badRequest('templateId is required');
    parseOrThrow(uuidSchema, body.templateId);

    const template = await queryOne<{ name: string; body: string; technology: string | null }>(
      `SELECT name, body, technology FROM foia_templates WHERE id = $1`,
      [body.templateId],
    );
    if (!template) throw notFound('Template');

    let jurisdictionName = '[AGENCY / JURISDICTION]';
    let statute = null;
    if (body.jurisdictionId) {
      parseOrThrow(uuidSchema, body.jurisdictionId);
      const j = await queryOne<{ name: string }>(`SELECT name FROM jurisdictions WHERE id = $1`, [body.jurisdictionId]);
      if (j) jurisdictionName = j.name;
      statute = await findStatuteFor(body.jurisdictionId);
    }

    const me = await queryOne<{ name: string; email: string }>(`SELECT name, email FROM users WHERE id = $1`, [req.user!.id]);
    const months = Math.min(Math.max(body.recordsWindowMonths ?? 24, 1), 120);
    const since = new Date();
    since.setMonth(since.getMonth() - months);

    const lawName = statute?.lawName ?? 'the applicable public records law';
    const citation = statute?.citation ? ` (${statute.citation})` : '';
    const deadlineSentence = statute?.responseDays
      ? `Under ${lawName}${citation}, a response is required within ${statute.responseDays} ${statute.businessDays ? 'business' : 'calendar'} days.`
      : `Under ${lawName}${citation}, a prompt response within a reasonable time is required.`;

    const composed = template.body
      .replaceAll('{{JURISDICTION}}', jurisdictionName)
      .replaceAll('{{LAW_NAME}}', lawName)
      .replaceAll('{{CITATION}}', statute?.citation ?? '')
      .replaceAll('{{DEADLINE_SENTENCE}}', deadlineSentence)
      .replaceAll('{{SINCE_DATE}}', since.toISOString().slice(0, 10))
      .replaceAll('{{TODAY}}', new Date().toISOString().slice(0, 10))
      .replaceAll('{{REQUESTER_NAME}}', body.requesterName?.slice(0, 120) || me?.name || '[YOUR NAME]')
      .replaceAll('{{ORGANIZATION}}', body.organization?.slice(0, 160) || '')
      .replaceAll('{{EMAIL}}', me?.email ?? '[YOUR EMAIL]');

    return {
      subject: `Public records request: ${template.name} — ${jurisdictionName}`,
      body: composed,
      statute,
      suggestedDueDate: statute ? computeFoiaDueDate(new Date(), statute).toISOString().slice(0, 10) : null,
    };
  });

  app.get('/foia/templates', async () => {
    const { rows } = await query(
      `SELECT id, name, technology, body FROM foia_templates ORDER BY name`,
    );
    return { items: rows };
  });

  app.get('/foia/:id', async (req) => {
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const foia = await queryOne<{ workspaceId: string; jurisdictionId: string | null } & Record<string, unknown>>(
      `SELECT ${FOIA_SELECT} FROM foia_requests f
       LEFT JOIN jurisdictions j ON j.id = f.jurisdiction_id
       WHERE f.id = $1 AND f.deleted_at IS NULL`,
      [id],
    );
    if (!foia) throw notFound('FOIA request');
    await workspaceRole(req, foia.workspaceId, 'viewer');
    const docs = await query(
      `SELECT id, request_id AS "requestId", file_key AS "fileKey", file_name AS "fileName",
              file_type AS "fileType", size_bytes AS "sizeBytes", redactions,
              scan_status AS "scanStatus", pii_status AS "piiStatus", created_at AS "createdAt"
       FROM foia_documents WHERE request_id = $1 AND scan_status != 'quarantined' ORDER BY created_at`,
      [id],
    );
    const statute = await findStatuteFor(foia.jurisdictionId);
    return { ...foia, documents: docs.rows, statute };
  });

  app.patch('/foia/:id', async (req) => {
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const body = parseOrThrow(updateFoiaSchema, req.body);
    const existing = await queryOne<{ workspace_id: string; status: string; jurisdiction_id: string | null; sent_at: string | null }>(
      `SELECT workspace_id, status, jurisdiction_id, sent_at FROM foia_requests WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (!existing) throw notFound('FOIA request');
    await workspaceRole(req, existing.workspace_id, 'editor');

    if (body.status && body.status !== existing.status) {
      const allowed = VALID_TRANSITIONS[existing.status] ?? [];
      if (!allowed.includes(body.status)) {
        throw badRequest(
          `Cannot move from "${existing.status}" to "${body.status}". Allowed: ${allowed.join(', ') || 'none (closed is final)'}`,
        );
      }
    }

    // Marking as sent computes the statutory due date automatically.
    let computedDue: string | null = null;
    let sentAt: string | null = null;
    if (body.status === 'sent' && existing.status === 'draft') {
      sentAt = body.sentAt ?? new Date().toISOString().slice(0, 10);
      if (!body.dueAt) {
        const statute = await findStatuteFor(body.jurisdictionId ?? existing.jurisdiction_id);
        computedDue = computeFoiaDueDate(new Date(sentAt), statute).toISOString().slice(0, 10);
      }
    }

    const updated = await queryOne(
      `UPDATE foia_requests SET
         subject = COALESCE($2, subject),
         body = COALESCE($3, body),
         jurisdiction_id = CASE WHEN $4 = 'set' THEN $5::uuid ELSE jurisdiction_id END,
         status = COALESCE($6, status),
         outcome = CASE WHEN $7 = 'set' THEN $8 ELSE outcome END,
         foia_number = COALESCE($9, foia_number),
         due_at = COALESCE($10::timestamptz, due_at),
         sent_at = COALESCE($11::timestamptz, sent_at)
       WHERE id = $1 RETURNING id`,
      [
        id,
        body.subject ?? null,
        body.body ?? null,
        body.jurisdictionId !== undefined ? 'set' : 'keep',
        body.jurisdictionId ?? null,
        body.status ?? null,
        body.outcome !== undefined ? 'set' : 'keep',
        body.outcome ?? null,
        body.foiaNumber ?? null,
        body.dueAt ?? computedDue,
        body.sentAt ?? sentAt,
      ],
    );
    if (!updated) throw notFound('FOIA request');
    await audit({ actorId: req.user!.id, action: 'foia.updated', resource: 'foia', resourceId: id, metadata: { status: body.status }, ip: req.ip });
    return await queryOne(
      `SELECT ${FOIA_SELECT} FROM foia_requests f LEFT JOIN jurisdictions j ON j.id = f.jurisdiction_id WHERE f.id = $1`,
      [id],
    );
  });

  app.delete('/foia/:id', async (req) => {
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const existing = await queryOne<{ workspace_id: string }>(
      `SELECT workspace_id FROM foia_requests WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (!existing) throw notFound('FOIA request');
    await workspaceRole(req, existing.workspace_id, 'admin');
    await query(`UPDATE foia_requests SET deleted_at = now() WHERE id = $1`, [id]);
    await audit({ actorId: req.user!.id, action: 'foia.deleted', resource: 'foia', resourceId: id, ip: req.ip });
    return { ok: true };
  });

  app.post('/foia/:id/documents', async (req, reply) => {
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const existing = await queryOne<{ workspace_id: string }>(
      `SELECT workspace_id FROM foia_requests WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (!existing) throw notFound('FOIA request');
    await workspaceRole(req, existing.workspace_id, 'editor');

    const file = await req.file();
    if (!file) throw badRequest('Attach a file (multipart field "file")');
    const buf = await file.toBuffer().catch(() => {
      throw payloadTooLarge(`Files are limited to ${Math.round(LIMITS.uploadMaxBytes / 1024 / 1024)}MB`);
    });
    if (!(ALLOWED_UPLOAD_MIME as readonly string[]).includes(file.mimetype)) {
      throw badRequest(`Unsupported file type ${file.mimetype}. Allowed: PDF, PNG, JPEG, WebP, AVIF, CSV, TXT.`);
    }
    const scan = await scanUpload(buf, file.mimetype);
    const key = foiaDocKey(id, file.filename || 'document');
    await storage.put(scan.malware === 'quarantined' ? quarantineKey(key) : key, buf, file.mimetype);

    const doc = await queryOne<{ id: string }>(
      `INSERT INTO foia_documents (request_id, file_key, file_name, file_type, size_bytes, scan_status, pii_status, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [id, key, (file.filename || 'document').slice(0, 200), file.mimetype, buf.length, scan.malware, scan.pii === 'flagged' ? 'flagged' : 'clean', req.user!.id],
    );
    await audit({ actorId: req.user!.id, action: 'foia.document_uploaded', resource: 'foia', resourceId: id, metadata: { scan: scan.malware, pii: scan.pii }, ip: req.ip });

    if (scan.malware === 'quarantined') {
      return reply.status(202).send({
        ok: false,
        quarantined: true,
        message: 'This file failed the safety scan and was quarantined for admin review.',
        reasons: scan.malwareReasons,
      });
    }
    return reply.status(201).send({
      ok: true,
      documentId: doc!.id,
      ...(scan.pii === 'flagged'
        ? { piiFlagged: true, message: 'Possible personal information detected (' + scan.piiKinds.join(', ') + ') — review redactions before sharing.', kinds: scan.piiKinds }
        : {}),
    });
  });

  /** Save redaction annotations for a response document. */
  app.patch('/foia/:id/documents/:docId', async (req) => {
    const { id, docId } = req.params as { id: string; docId: string };
    parseOrThrow(uuidSchema, id);
    parseOrThrow(uuidSchema, docId);
    const existing = await queryOne<{ workspace_id: string }>(
      `SELECT workspace_id FROM foia_requests WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (!existing) throw notFound('FOIA request');
    await workspaceRole(req, existing.workspace_id, 'editor');
    const body = (req.body ?? {}) as { redactions?: unknown };
    const res = await query(`UPDATE foia_documents SET redactions = $3 WHERE id = $2 AND request_id = $1`, [
      id,
      docId,
      JSON.stringify(body.redactions ?? null),
    ]);
    if (res.rowCount === 0) throw notFound('Document');
    return { ok: true };
  });

  app.delete('/foia/:id/documents/:docId', async (req) => {
    const { id, docId } = req.params as { id: string; docId: string };
    parseOrThrow(uuidSchema, id);
    parseOrThrow(uuidSchema, docId);
    const existing = await queryOne<{ workspace_id: string }>(
      `SELECT workspace_id FROM foia_requests WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (!existing) throw notFound('FOIA request');
    await workspaceRole(req, existing.workspace_id, 'editor');
    const doc = await queryOne<{ file_key: string }>(
      `DELETE FROM foia_documents WHERE id = $2 AND request_id = $1 RETURNING file_key`,
      [id, docId],
    );
    if (!doc) throw notFound('Document');
    await storage.delete(doc.file_key).catch(() => undefined);
    await audit({ actorId: req.user!.id, action: 'foia.document_deleted', resource: 'foia', resourceId: id, ip: req.ip });
    return { ok: true };
  });
}
