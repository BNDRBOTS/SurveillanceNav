import type { FastifyInstance } from 'fastify';
import {
  auditLogQuery,
  mergeAssetsSchema,
  updateUserAdminSchema,
  resolveDisputeSchema,
  resolveErrorReportSchema,
  updateStatuteSchema,
  settingsUpdateSchema,
  uuid as uuidSchema,
  type AdminMetrics,
} from '@stn/shared';
import { parseOrThrow, paginate } from '../lib/validation.js';
import { query, queryOne, withTransaction, probeDb } from '../db/pool.js';
import { requireRole, invalidateUserStatusCache } from '../plugins/auth.js';
import { notFound, badRequest } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { cache } from '../cache/index.js';
import { storage } from '../storage/index.js';
import { metricsSnapshot } from '../plugins/metrics.js';
import { recalcAssetConfidence } from '../services/confidence.js';
import { enqueueJob, retryJob } from '../jobs/queue.js';
import { runScheduledJobNow } from '../jobs/scheduler.js';
import { activeEngine } from '../services/routing.js';
import { config } from '../config.js';

export function registerAdminRoutes(app: FastifyInstance): void {
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/v1/admin')) requireRole(req, 'admin');
  });

  /* ------------------------------------------------------------- users */

  app.get('/admin/users', async (req) => {
    const qp = req.query as { q?: string; page?: string };
    const page = Math.max(1, Number(qp.page ?? 1) || 1);
    const pageSize = 50;
    const params: unknown[] = [];
    let where = `deleted_at IS NULL`;
    if (qp.q) {
      where += ` AND (email ILIKE $1 OR name ILIKE $1)`;
      params.push(`%${qp.q.slice(0, 100)}%`);
    }
    const { rows } = await query(
      `SELECT id, email, name, role, status, mfa_enabled AS "mfaEnabled",
              created_at AS "createdAt", last_login_at AS "lastLoginAt"
       FROM users WHERE ${where} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params,
    );
    const total = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE ${where}`, params);
    return paginate(rows, total?.n ?? 0, { page, pageSize });
  });

  app.patch('/admin/users/:id', async (req) => {
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const body = parseOrThrow(updateUserAdminSchema, req.body);
    if (id === req.user!.id && body.role && body.role !== 'admin') {
      throw badRequest('You cannot demote your own admin account');
    }
    if (id === req.user!.id && body.status === 'suspended') {
      throw badRequest('You cannot suspend your own account');
    }
    const updated = await queryOne(
      `UPDATE users SET role = COALESCE($2, role), status = COALESCE($3, status)
       WHERE id = $1 AND deleted_at IS NULL RETURNING id, email, role, status`,
      [id, body.role ?? null, body.status ?? null],
    );
    if (!updated) throw notFound('User');
    if (body.status === 'suspended') {
      await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
    }
    await invalidateUserStatusCache(id);
    await audit({ actorId: req.user!.id, action: 'admin.user_updated', resource: 'user', resourceId: id, metadata: body, ip: req.ip });
    return updated;
  });

  app.delete('/admin/users/:id', async (req) => {
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    if (id === req.user!.id) throw badRequest('Use account settings to delete your own account');
    const res = await query(
      `UPDATE users SET status = 'deleted', deleted_at = now(),
         email = 'deleted+' || id || '@redacted.invalid', name = 'Deleted user'
       WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (res.rowCount === 0) throw notFound('User');
    await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1`, [id]);
    await invalidateUserStatusCache(id);
    await audit({ actorId: req.user!.id, action: 'admin.user_deleted', resource: 'user', resourceId: id, ip: req.ip });
    return { ok: true };
  });

  /* ------------------------------------------------------------- audit logs */

  app.get('/admin/audit-logs', async (req) => {
    const q = parseOrThrow(auditLogQuery, req.query);
    const clauses: string[] = ['true'];
    const params: unknown[] = [];
    let i = 1;
    if (q.actorId) {
      clauses.push(`l.actor_id = $${i}`);
      params.push(q.actorId);
      i += 1;
    }
    if (q.action) {
      clauses.push(`l.action ILIKE $${i}`);
      params.push(`%${q.action}%`);
      i += 1;
    }
    if (q.resource) {
      clauses.push(`l.resource = $${i}`);
      params.push(q.resource);
      i += 1;
    }
    if (q.from) {
      clauses.push(`l.created_at >= $${i}::date`);
      params.push(q.from);
      i += 1;
    }
    if (q.to) {
      clauses.push(`l.created_at < ($${i}::date + interval '1 day')`);
      params.push(q.to);
      i += 1;
    }
    const offset = (q.page - 1) * q.pageSize;
    const { rows } = await query(
      `SELECT l.id, l.actor_id AS "actorId", u.email AS "actorEmail", l.action, l.resource,
              l.resource_id AS "resourceId", l.metadata, l.ip, l.user_agent AS "userAgent", l.created_at AS "createdAt"
       FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY l.id DESC LIMIT ${q.pageSize} OFFSET ${offset}`,
      params,
    );
    const total = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs l WHERE ${clauses.join(' AND ')}`,
      params,
    );
    return paginate(rows, total?.n ?? 0, q);
  });

  /* ------------------------------------------------------------- metrics & monitoring */

  app.get('/admin/metrics', async () => {
    const [db, cacheProbe, storageProbe, jobCounts, schedules, counts] = await Promise.all([
      probeDb(),
      cache.probe(),
      storage.probe(),
      queryOne<{ queued: number; running: number; failed: number }>(
        `SELECT
           count(*) FILTER (WHERE status = 'queued')::int AS queued,
           count(*) FILTER (WHERE status = 'running')::int AS running,
           count(*) FILTER (WHERE status = 'failed' AND completed_at > now() - interval '24 hours')::int AS failed
         FROM jobs`,
      ),
      query<{ name: string; enabled: boolean; interval_sec: number; last_run_at: string | null; last_status: string | null; last_duration_ms: number | null }>(
        `SELECT name, enabled, interval_sec, last_run_at, last_status, last_duration_ms FROM job_schedules ORDER BY name`,
      ),
      queryOne<Record<string, number>>(
        `SELECT
           (SELECT count(*)::int FROM users WHERE deleted_at IS NULL) AS users,
           (SELECT count(*)::int FROM surveillance_assets WHERE deleted_at IS NULL) AS assets,
           (SELECT count(*)::int FROM foia_requests WHERE deleted_at IS NULL) AS foia,
           (SELECT count(*)::int FROM procurements WHERE deleted_at IS NULL) AS procurements,
           (SELECT count(*)::int FROM policies WHERE deleted_at IS NULL) AS policies,
           (SELECT count(*)::int FROM disputes WHERE status IN ('open','under_review')) AS "openDisputes",
           (SELECT count(*)::int FROM flags WHERE status = 'open') AS "openFlags",
           (SELECT count(*)::int FROM merge_candidates WHERE status = 'open') AS "mergeCandidates",
           (SELECT count(*)::int FROM asset_evidence WHERE scan_status = 'quarantined') +
             (SELECT count(*)::int FROM foia_documents WHERE scan_status = 'quarantined') AS quarantined,
           (SELECT count(*)::int FROM asset_evidence WHERE pii_status = 'flagged') +
             (SELECT count(*)::int FROM foia_documents WHERE pii_status = 'flagged') AS "piiFlagged"`,
      ),
    ]);
    const snapshot = metricsSnapshot();
    const result: AdminMetrics = {
      ...snapshot,
      dbHealthy: db.ok,
      cacheBackend: cacheProbe.backend,
      cacheHitRatio: cache.stats().hitRatio,
      jobs: {
        queued: jobCounts?.queued ?? 0,
        running: jobCounts?.running ?? 0,
        failedLast24h: jobCounts?.failed ?? 0,
      },
      scheduledJobs: schedules.rows.map((s) => ({
        name: s.name,
        enabled: s.enabled,
        intervalSec: s.interval_sec,
        lastRunAt: s.last_run_at,
        lastStatus: s.last_status,
        lastDurationMs: s.last_duration_ms,
      })),
      storage: { backend: storage.name, ok: storageProbe.ok },
      routing: activeEngine(),
      counts: counts ?? {},
    };
    return result;
  });

  app.get('/admin/jobs', async (req) => {
    const qp = req.query as { status?: string };
    const status = ['queued', 'running', 'completed', 'failed', 'cancelled'].includes(qp.status ?? '')
      ? qp.status
      : null;
    const { rows } = await query(
      `SELECT id, type, status, priority, attempts, max_attempts AS "maxAttempts",
              last_error AS "lastError", run_at AS "runAt", created_at AS "createdAt", completed_at AS "completedAt"
       FROM jobs ${status ? `WHERE status = $1` : ''} ORDER BY created_at DESC LIMIT 100`,
      status ? [status] : [],
    );
    return { items: rows };
  });

  app.post('/admin/jobs/:id/retry', async (req) => {
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const ok = await retryJob(id);
    if (!ok) throw badRequest('Only failed or cancelled jobs can be retried');
    await audit({ actorId: req.user!.id, action: 'admin.job_retried', resource: 'job', resourceId: id, ip: req.ip });
    return { ok: true };
  });

  app.post('/admin/schedules/:name/toggle', async (req) => {
    const name = String((req.params as { name: string }).name).slice(0, 100);
    const row = await queryOne<{ enabled: boolean }>(
      `UPDATE job_schedules SET enabled = NOT enabled WHERE name = $1 RETURNING enabled`,
      [name],
    );
    if (!row) throw notFound('Schedule');
    await audit({ actorId: req.user!.id, action: 'admin.schedule_toggled', resource: 'schedule', resourceId: name, metadata: { enabled: row.enabled }, ip: req.ip });
    return { ok: true, enabled: row.enabled };
  });

  app.post('/admin/schedules/:name/run', async (req) => {
    const name = String((req.params as { name: string }).name).slice(0, 100);
    await audit({ actorId: req.user!.id, action: 'admin.schedule_run_now', resource: 'schedule', resourceId: name, ip: req.ip });
    try {
      const result = await runScheduledJobNow(name);
      return { ok: true, result: result ?? null };
    } catch (err) {
      throw badRequest(`Job failed: ${(err as Error).message.slice(0, 300)}`);
    }
  });

  /* ------------------------------------------------------------- curation */

  app.get('/admin/curation', async () => {
    const [disputes, flags, mergeCandidates, quarantine, pii, errorReports] = await Promise.all([
      query(
        `SELECT d.id, d.asset_id AS "assetId", a.name AS "assetName", d.user_id AS "userId", u.name AS "userName",
                d.reason, d.evidence, d.evidence_url AS "evidenceUrl", d.status, d.created_at AS "createdAt"
         FROM disputes d JOIN surveillance_assets a ON a.id = d.asset_id LEFT JOIN users u ON u.id = d.user_id
         WHERE d.status IN ('open','under_review') ORDER BY d.created_at LIMIT 100`,
      ),
      query(
        `SELECT f.id, f.asset_id AS "assetId", a.name AS "assetName", f.reason, f.created_at AS "createdAt"
         FROM flags f JOIN surveillance_assets a ON a.id = f.asset_id
         WHERE f.status = 'open' ORDER BY f.created_at LIMIT 100`,
      ),
      query(
        `SELECT m.id, m.asset_a AS "assetA", a1.name AS "nameA", m.asset_b AS "assetB", a2.name AS "nameB",
                m.score, m.reasons, m.created_at AS "createdAt"
         FROM merge_candidates m
         JOIN surveillance_assets a1 ON a1.id = m.asset_a
         JOIN surveillance_assets a2 ON a2.id = m.asset_b
         WHERE m.status = 'open' ORDER BY m.score DESC LIMIT 100`,
      ),
      query(
        `SELECT id, 'evidence' AS kind, file_name AS "fileName", file_key AS "fileKey", created_at AS "createdAt" FROM asset_evidence WHERE scan_status = 'quarantined'
         UNION ALL
         SELECT id, 'foia_document' AS kind, file_name AS "fileName", file_key AS "fileKey", created_at AS "createdAt" FROM foia_documents WHERE scan_status = 'quarantined'
         ORDER BY "createdAt" DESC LIMIT 100`,
      ),
      query(
        `SELECT id, 'evidence' AS kind, file_name AS "fileName", created_at AS "createdAt" FROM asset_evidence WHERE pii_status = 'flagged' AND scan_status = 'clean'
         UNION ALL
         SELECT id, 'foia_document' AS kind, file_name AS "fileName", created_at AS "createdAt" FROM foia_documents WHERE pii_status = 'flagged' AND scan_status = 'clean'
         ORDER BY "createdAt" DESC LIMIT 100`,
      ),
      query(
        `SELECT id, kind, message, detail, app_version AS "appVersion", user_agent AS "userAgent", created_at AS "createdAt"
         FROM error_reports WHERE status = 'new' ORDER BY created_at DESC LIMIT 100`,
      ),
    ]);
    return {
      disputes: disputes.rows,
      flags: flags.rows,
      mergeCandidates: mergeCandidates.rows,
      quarantinedFiles: quarantine.rows,
      piiReview: pii.rows,
      errorReports: errorReports.rows,
    };
  });

  /* -------------------------------------------------------- statutes */

  app.get('/admin/statutes', async () => {
    const [active, proposals] = await Promise.all([
      query(
        `SELECT id, jurisdiction_key AS "key", state, law_name AS "lawName", citation,
                response_days AS "responseDays", business_days AS "businessDays", notes, source_url AS "sourceUrl",
                version, checked_at AS "checkedAt", checked_by AS "checkedBy"
         FROM statutes WHERE review_status = 'approved' AND superseded_at IS NULL ORDER BY state`,
      ),
      query(
        `SELECT p.id, p.jurisdiction_key AS "key", p.state, p.law_name AS "lawName", p.citation,
                p.response_days AS "responseDays", p.business_days AS "businessDays",
                p.proposed_changes AS "proposedChanges", p.source_excerpt AS "sourceExcerpt", p.llm_model AS "llmModel",
                p.created_at AS "createdAt",
                a.law_name AS "currentLawName", a.citation AS "currentCitation",
                a.response_days AS "currentResponseDays", a.business_days AS "currentBusinessDays"
         FROM statutes p
         LEFT JOIN statutes a ON a.jurisdiction_key = p.jurisdiction_key
           AND a.review_status = 'approved' AND a.superseded_at IS NULL
         WHERE p.review_status = 'needs_review' ORDER BY p.created_at`,
      ),
    ]);
    const { legalLlmAvailable } = await import('../services/statutes.js');
    return { active: active.rows, proposals: proposals.rows, llmConfigured: legalLlmAvailable() };
  });

  app.post('/admin/statutes/:id/approve', async (req) => {
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const proposal = await queryOne<{ jurisdiction_key: string }>(
      `SELECT jurisdiction_key FROM statutes WHERE id = $1 AND review_status = 'needs_review'`,
      [id],
    );
    if (!proposal) throw notFound('Statute proposal');
    await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE statutes SET superseded_at = now()
         WHERE jurisdiction_key = $1 AND review_status = 'approved' AND superseded_at IS NULL`,
        [proposal.jurisdiction_key],
      );
      await tx.query(
        `UPDATE statutes SET review_status = 'approved', effective_from = now(), created_by = $2 WHERE id = $1`,
        [id, req.user!.id],
      );
    });
    const { invalidateStatuteCache } = await import('../services/statutes.js');
    await invalidateStatuteCache();
    await audit({ actorId: req.user!.id, action: 'admin.statute_approved', resource: 'statute', resourceId: id, ip: req.ip });
    return { ok: true };
  });

  app.post('/admin/statutes/:id/reject', async (req) => {
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const res = await query(
      `UPDATE statutes SET review_status = 'rejected' WHERE id = $1 AND review_status = 'needs_review'`,
      [id],
    );
    if (res.rowCount === 0) throw notFound('Statute proposal');
    await audit({ actorId: req.user!.id, action: 'admin.statute_rejected', resource: 'statute', resourceId: id, ip: req.ip });
    return { ok: true };
  });

  app.patch('/admin/statutes/:key', async (req) => {
    const key = String((req.params as { key: string }).key).toUpperCase().slice(0, 4);
    const body = parseOrThrow(updateStatuteSchema, req.body);
    const current = await queryOne<{ id: string; state: string; law_name: string; citation: string; response_days: number | null; business_days: boolean; notes: string | null; source_url: string | null; version: number }>(
      `SELECT id, state, law_name, citation, response_days, business_days, notes, source_url, version
       FROM statutes WHERE jurisdiction_key = $1 AND review_status = 'approved' AND superseded_at IS NULL`,
      [key],
    );
    if (!current) throw notFound('Statute');
    await withTransaction(async (tx) => {
      await tx.query(`UPDATE statutes SET superseded_at = now() WHERE id = $1`, [current.id]);
      await tx.query(
        `INSERT INTO statutes (jurisdiction_key, state, law_name, citation, response_days, business_days, notes, source_url,
                               version, review_status, checked_at, checked_by, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'approved', now(), 'admin', $10)`,
        [
          key,
          current.state,
          body.lawName ?? current.law_name,
          body.citation ?? current.citation,
          body.responseDays !== undefined ? body.responseDays : current.response_days,
          body.businessDays ?? current.business_days,
          body.notes !== undefined ? body.notes : current.notes,
          body.sourceUrl !== undefined ? body.sourceUrl : current.source_url,
          current.version + 1,
          req.user!.id,
        ],
      );
    });
    const { invalidateStatuteCache } = await import('../services/statutes.js');
    await invalidateStatuteCache();
    await audit({ actorId: req.user!.id, action: 'admin.statute_edited', resource: 'statute', resourceId: key, metadata: body, ip: req.ip });
    return { ok: true };
  });

  app.post('/admin/error-reports/:id/resolve', async (req) => {
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const body = parseOrThrow(resolveErrorReportSchema, req.body);
    const res = await query(
      `UPDATE error_reports SET status = $2, admin_id = $3, resolved_at = now()
       WHERE id = $1 AND status = 'new'`,
      [id, body.action, req.user!.id],
    );
    if (res.rowCount === 0) throw notFound('Open error report');
    await audit({
      actorId: req.user!.id,
      action: 'admin.error_report_resolved',
      resource: 'error_report',
      resourceId: id,
      metadata: { action: body.action },
      ip: req.ip,
    });
    return { ok: true };
  });

  app.post('/admin/disputes/:id/resolve', async (req) => {
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const body = parseOrThrow(resolveDisputeSchema, req.body);
    const dispute = await queryOne<{ asset_id: string; user_id: string | null }>(
      `UPDATE disputes SET status = $2, resolution = $3, admin_id = $4
       WHERE id = $1 AND status IN ('open','under_review') RETURNING asset_id, user_id`,
      [id, body.status, body.resolution, req.user!.id],
    );
    if (!dispute) throw notFound('Open dispute');
    if (body.status === 'accepted') {
      await query(`UPDATE surveillance_assets SET status = 'unverified' WHERE id = $1`, [dispute.asset_id]);
    }
    await recalcAssetConfidence(dispute.asset_id);
    if (dispute.user_id) {
      await query(
        `INSERT INTO notifications (user_id, kind, title, body, link) VALUES ($1, 'dispute_resolved', $2, $3, $4)`,
        [dispute.user_id, `Dispute ${body.status}`, body.resolution.slice(0, 200), `/map?asset=${dispute.asset_id}`],
      );
    }
    await cache.del('assets:', true);
    await audit({ actorId: req.user!.id, action: 'admin.dispute_resolved', resource: 'dispute', resourceId: id, metadata: { status: body.status }, ip: req.ip });
    return { ok: true };
  });

  app.post('/admin/flags/:id/resolve', async (req) => {
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const action = (req.body as { action?: string } | null)?.action === 'dismiss' ? 'dismissed' : 'resolved';
    const res = await query(
      `UPDATE flags SET status = $2, admin_id = $3, resolved_at = now() WHERE id = $1 AND status = 'open'`,
      [id, action, req.user!.id],
    );
    if (res.rowCount === 0) throw notFound('Open flag');
    await audit({ actorId: req.user!.id, action: 'admin.flag_resolved', resource: 'flag', resourceId: id, metadata: { action }, ip: req.ip });
    return { ok: true };
  });

  /** Merge duplicates: keeps one asset, folds evidence/history/disputes in, soft-deletes the rest. */
  app.post('/admin/merge-assets', async (req) => {
    const body = parseOrThrow(mergeAssetsSchema, req.body);
    if (body.mergeIds.includes(body.keepId)) throw badRequest('keepId cannot also be merged away');

    const keep = await queryOne(`SELECT id FROM surveillance_assets WHERE id = $1 AND deleted_at IS NULL`, [body.keepId]);
    if (!keep) throw notFound('Asset to keep');

    await withTransaction(async (tx) => {
      for (const mergeId of body.mergeIds) {
        await tx.query(`UPDATE asset_evidence SET asset_id = $1 WHERE asset_id = $2`, [body.keepId, mergeId]);
        await tx.query(`UPDATE disputes SET asset_id = $1 WHERE asset_id = $2`, [body.keepId, mergeId]);
        await tx.query(`UPDATE comments SET asset_id = $1 WHERE asset_id = $2`, [body.keepId, mergeId]);
        await tx.query(
          `INSERT INTO asset_sources (asset_id, source_id)
           SELECT $1, source_id FROM surveillance_assets WHERE id = $2 AND source_id IS NOT NULL
           ON CONFLICT DO NOTHING`,
          [body.keepId, mergeId],
        );
        await tx.query(`UPDATE surveillance_assets SET deleted_at = now() WHERE id = $1`, [mergeId]);
        await tx.query(
          `INSERT INTO asset_history (asset_id, user_id, action, diff) VALUES ($1, $2, 'merge', $3)`,
          [body.keepId, req.user!.id, JSON.stringify({ mergedFrom: { from: mergeId, to: body.keepId } })],
        );
        await tx.query(
          `UPDATE merge_candidates SET status = 'merged', admin_id = $3, resolved_at = now()
           WHERE (asset_a = $1 AND asset_b = $2) OR (asset_a = $2 AND asset_b = $1)`,
          [body.keepId, mergeId, req.user!.id],
        );
      }
    });
    await recalcAssetConfidence(body.keepId);
    await cache.del('assets:', true);
    await audit({ actorId: req.user!.id, action: 'admin.assets_merged', resource: 'asset', resourceId: body.keepId, metadata: { merged: body.mergeIds }, ip: req.ip });
    return { ok: true, keptId: body.keepId, mergedCount: body.mergeIds.length };
  });

  app.post('/admin/merge-candidates/:id/dismiss', async (req) => {
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const res = await query(
      `UPDATE merge_candidates SET status = 'dismissed', admin_id = $2, resolved_at = now() WHERE id = $1 AND status = 'open'`,
      [id, req.user!.id],
    );
    if (res.rowCount === 0) throw notFound('Merge candidate');
    return { ok: true };
  });

  /** Quarantined file handling: release (false positive) or purge. */
  app.post('/admin/quarantine/:kind/:id', async (req) => {
    const { kind, id } = req.params as { kind: string; id: string };
    parseOrThrow(uuidSchema, id);
    const table = kind === 'evidence' ? 'asset_evidence' : kind === 'foia_document' ? 'foia_documents' : null;
    if (!table) throw badRequest('kind must be evidence or foia_document');
    const decision = (req.body as { action?: string } | null)?.action;
    if (decision !== 'release' && decision !== 'purge') throw badRequest('action must be "release" or "purge"');

    const row = await queryOne<{ file_key: string }>(`SELECT file_key FROM ${table} WHERE id = $1 AND scan_status = 'quarantined'`, [id]);
    if (!row) throw notFound('Quarantined file');
    const { quarantineKey } = await import('../storage/index.js');
    const qKey = quarantineKey(row.file_key);

    if (decision === 'release') {
      const data = await storage.get(qKey);
      if (data) {
        await storage.put(row.file_key, data);
        await storage.delete(qKey);
      }
      await query(`UPDATE ${table} SET scan_status = 'clean' WHERE id = $1`, [id]);
    } else {
      await storage.delete(qKey).catch(() => undefined);
      await storage.delete(row.file_key).catch(() => undefined);
      await query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    }
    await audit({ actorId: req.user!.id, action: `admin.quarantine_${decision}`, resource: kind, resourceId: id, ip: req.ip });
    return { ok: true };
  });

  app.post('/admin/pii/:kind/:id/clear', async (req) => {
    const { kind, id } = req.params as { kind: string; id: string };
    parseOrThrow(uuidSchema, id);
    const table = kind === 'evidence' ? 'asset_evidence' : kind === 'foia_document' ? 'foia_documents' : null;
    if (!table) throw badRequest('kind must be evidence or foia_document');
    const res = await query(`UPDATE ${table} SET pii_status = 'clean' WHERE id = $1 AND pii_status = 'flagged'`, [id]);
    if (res.rowCount === 0) throw notFound('Flagged file');
    await audit({ actorId: req.user!.id, action: 'admin.pii_cleared', resource: kind, resourceId: id, ip: req.ip });
    return { ok: true };
  });

  /* ------------------------------------------------------------- operations */

  app.post('/admin/retention/run', async (req) => {
    await audit({ actorId: req.user!.id, action: 'admin.retention_run', resource: 'system', ip: req.ip });
    const result = await runScheduledJobNow('retention_enforcement');
    return { ok: true, report: result ?? null };
  });

  app.post('/admin/recalculate-confidence', async (req) => {
    const jobId = await enqueueJob('confidence_recalc', {}, { priority: 2 });
    await audit({ actorId: req.user!.id, action: 'admin.confidence_recalc', resource: 'system', ip: req.ip });
    return { ok: true, jobId };
  });

  /* ------------------------------------------------------------- settings & feature flags */

  app.get('/admin/settings', async () => {
    const { rows } = await query(`SELECT key, value, updated_at AS "updatedAt" FROM app_settings ORDER BY key`);
    const defaults: Record<string, unknown> = {
      rate_limits: { windowSec: config.rateLimit.windowSec, max: config.rateLimit.max, authMax: config.rateLimit.authMax },
      feature_flags: { onlineBasemap: true, publicSignup: true, communitySubmissions: true },
      cache_ttls: { assetsSec: 30, jurisdictionsSec: 300 },
      retention: {
        exportTtlHours: config.retention.exportTtlHours,
        auditLogDays: config.retention.auditLogDays,
        deletedUserPurgeDays: config.retention.deletedUserPurgeDays,
      },
      'foia.deadlineOverrides': {},
    };
    const current: Record<string, unknown> = { ...defaults };
    for (const row of rows as Array<{ key: string; value: unknown }>) current[row.key] = row.value;
    return { settings: current, persisted: rows };
  });

  app.put('/admin/settings', async (req) => {
    const body = parseOrThrow(settingsUpdateSchema, req.body);
    const ALLOWED_KEYS = ['rate_limits', 'feature_flags', 'cache_ttls', 'retention', 'foia.deadlineOverrides', 'tile_provider', 'auth.resetDisclosure'];
    if (!ALLOWED_KEYS.includes(body.key)) {
      throw badRequest(`Unknown settings key. Allowed: ${ALLOWED_KEYS.join(', ')}`);
    }
    await query(
      `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [body.key, JSON.stringify(body.value ?? null), req.user!.id],
    );
    await audit({ actorId: req.user!.id, action: 'admin.settings_updated', resource: 'settings', resourceId: body.key, metadata: { value: body.value }, ip: req.ip });
    return { ok: true };
  });

  /** Temporary audited rate-limit override (incident lever). */
  app.post('/admin/rate-limit-override', async (req) => {
    const minutes = Math.min(Math.max(Number((req.body as { minutes?: number } | null)?.minutes ?? 15), 1), 120);
    const until = new Date(Date.now() + minutes * 60_000).toISOString();
    const current = await queryOne<{ value: Record<string, unknown> }>(`SELECT value FROM app_settings WHERE key = 'rate_limits'`);
    const value = { ...(current?.value ?? {}), overrideUntil: until };
    await query(
      `INSERT INTO app_settings (key, value, updated_by) VALUES ('rate_limits', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [JSON.stringify(value), req.user!.id],
    );
    await audit({ actorId: req.user!.id, action: 'admin.rate_limit_override', resource: 'settings', metadata: { minutes, until }, ip: req.ip });
    return { ok: true, overrideUntil: until, message: `Rate limiting bypassed for ${minutes} minutes (audited).` };
  });
}
