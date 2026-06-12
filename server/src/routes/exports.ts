import type { FastifyInstance } from 'fastify';
import { createExportSchema, uuid as uuidSchema, LIMITS } from '@stn/shared';
import { parseOrThrow } from '../lib/validation.js';
import { query, queryOne } from '../db/pool.js';
import { requireAuth, workspaceRole } from '../plugins/auth.js';
import { notFound, badRequest, forbidden } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { enqueueJob } from '../jobs/queue.js';
import { storage } from '../storage/index.js';
import { signDownload, verifyDownload } from '../auth/crypto.js';
import { config } from '../config.js';

const EXPORT_SELECT = `
  e.id, e.workspace_id AS "workspaceId", e.user_id AS "userId", e.format, e.resource,
  e.params, e.file_key AS "fileKey", e.status, e.error, e.row_count AS "rowCount",
  e.truncated, e.expires_at AS "expiresAt", e.created_at AS "createdAt", e.completed_at AS "completedAt"
`;

const CONTENT_TYPES: Record<string, string> = {
  csv: 'text/csv; charset=utf-8',
  json: 'application/json',
  geojson: 'application/geo+json',
  kml: 'application/vnd.google-earth.kml+xml',
  pdf: 'application/pdf',
  html: 'text/html; charset=utf-8',
};

function withDownloadUrl<T extends { fileKey?: string | null; status?: string; id?: string }>(row: T): T & { downloadUrl: string | null } {
  if (row.status !== 'completed' || !row.fileKey) return { ...row, downloadUrl: null };
  const suffix = signDownload(row.fileKey, config.downloadSecret, 15 * 60);
  return { ...row, downloadUrl: `/api/v1/exports/download/${encodeURIComponent(row.fileKey)}?${suffix}` };
}

export function registerExportRoutes(app: FastifyInstance): void {
  app.get('/exports', async (req) => {
    requireAuth(req);
    const { rows } = await query(
      `SELECT ${EXPORT_SELECT} FROM exports e WHERE e.user_id = $1 ORDER BY e.created_at DESC LIMIT 50`,
      [req.user!.id],
    );
    return { items: rows.map((r) => withDownloadUrl(r as { fileKey: string | null; status: string })) };
  });

  app.post('/exports', async (req, reply) => {
    requireAuth(req);
    const body = parseOrThrow(createExportSchema, req.body);

    // RBAC + data-minimization: FOIA exports are workspace-scoped;
    // asset exports are public-data only (enforced by the generator's column list).
    if (body.resource === 'foia') {
      if (!body.workspaceId) throw badRequest('FOIA exports require a workspaceId');
      await workspaceRole(req, body.workspaceId, 'viewer');
    } else if (body.workspaceId) {
      await workspaceRole(req, body.workspaceId, 'viewer');
    }
    if ((body.format === 'pdf' || body.format === 'html') && body.resource === 'foia') {
      throw badRequest('FOIA tracking exports support CSV and JSON formats');
    }

    const row = await queryOne<{ id: string }>(
      `INSERT INTO exports (workspace_id, user_id, format, resource, params)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [body.workspaceId ?? null, req.user!.id, body.format, body.resource, JSON.stringify(body.params)],
    );
    const jobId = await enqueueJob('generate_export', { exportId: row!.id }, { priority: 4 });
    if (!jobId) {
      await query(`UPDATE exports SET status = 'failed', error = 'queue unavailable' WHERE id = $1`, [row!.id]);
      throw badRequest('Export queue is temporarily unavailable — try again shortly.');
    }
    await audit({ actorId: req.user!.id, action: 'export.requested', resource: 'export', resourceId: row!.id, metadata: { format: body.format, resource: body.resource }, ip: req.ip });
    return reply.status(202).send({
      id: row!.id,
      status: 'queued',
      message: `Export started. Free accounts cap at ${LIMITS.exportFreeRows.toLocaleString()} rows (Supporters: ${LIMITS.exportMaxRows.toLocaleString()}); oversized results are truncated with a warning.`,
    });
  });

  app.get('/exports/:id', async (req) => {
    requireAuth(req);
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const row = await queryOne<{ userId: string; fileKey: string | null; status: string }>(
      `SELECT ${EXPORT_SELECT} FROM exports e WHERE e.id = $1`,
      [id],
    );
    if (!row) throw notFound('Export');
    if (row.userId !== req.user!.id && req.user!.role !== 'admin') throw forbidden();
    return withDownloadUrl(row);
  });

  /** Signed short-TTL download — no auth header needed (works in new tabs), signature is the credential. */
  app.get('/exports/download/:fileKey', async (req, reply) => {
    const fileKey = decodeURIComponent((req.params as { fileKey: string }).fileKey);
    const { exp, sig } = req.query as { exp?: string; sig?: string };
    if (!exp || !sig || !verifyDownload(fileKey, exp, sig, config.downloadSecret)) {
      throw forbidden('This download link is invalid or has expired — request a fresh one from the Reports page.');
    }
    if (!fileKey.startsWith('exports/')) throw forbidden();
    const data = await storage.get(fileKey);
    if (!data) throw notFound('Export file (it may have expired)');
    const ext = fileKey.split('.').pop() ?? 'bin';
    reply.header('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="stn-export.${ext}"`);
    reply.header('Cache-Control', 'private, no-store');
    return reply.send(data);
  });
}
