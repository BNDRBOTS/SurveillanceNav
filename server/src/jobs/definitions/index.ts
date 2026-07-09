import { spawn } from 'node:child_process';
import { query, queryOne } from '../../db/pool.js';
import { config } from '../../config.js';
import { storage, exportKey, quarantineKey } from '../../storage/index.js';
import { recalcAssetConfidence } from '../../services/confidence.js';
import { scanUpload } from '../../services/scanner.js';
import { parseProcurementText } from '../../services/procurementParser.js';
import { sendMail } from '../../services/mailer.js';
import { toCsv, toGeoJson, toKml } from '../../lib/formats.js';
import { PdfBuilder } from '../../lib/pdf.js';
import { audit } from '../../services/audit.js';
import { TECH_COLORS, LIMITS, type TechnologyType } from '@stn/shared';
import type { JobHandler } from '../queue.js';
import { runImportRegion, refreshDeflockMetros, type Bbox } from '../../services/overpass.js';

export const scheduleDefaults: Array<{ name: string; description: string; intervalSec: number }> = [
  { name: 'statute_recheck', description: 'Refetch each statute\'s authoritative source page; on drift, file a change proposal for admin review (LLM-assisted when configured). Never auto-publishes.', intervalSec: 604_800 },
  { name: 'integrity_check', description: 'Detect duplicate assets, orphaned evidence, and records missing jurisdictions; queue for curator review.', intervalSec: 21_600 },
  { name: 'retention_enforcement', description: 'Enforce data retention: purge/anonymize per policy, archive then prune expired audit logs, clean idempotency keys & stale notifications. Emits a compliance report.', intervalSec: 86_400 },
  { name: 'cache_warmup', description: 'Pre-warm asset query cache for the most active regions at off-peak.', intervalSec: 3_600 },
  { name: 'backup_verify', description: 'Nightly logical backup to object storage; weekly restore verification into a scratch database.', intervalSec: 86_400 },
  { name: 'scan_pending_files', description: 'Re-scan uploads stuck in pending (malware + PII), quarantining as needed.', intervalSec: 900 },
  { name: 'confidence_recalc', description: 'Recompute confidence scores from verification recency, evidence, disputes, and corroboration.', intervalSec: 86_400 },
  { name: 'export_cleanup', description: 'Expire and delete old export files; release storage.', intervalSec: 3_600 },
  { name: 'index_maintenance', description: 'ANALYZE hot tables, vacuum when dead-tuple ratio is high, alert on bloat anomalies.', intervalSec: 86_400 },
  { name: 'foia_deadline_check', description: 'Notify owners of FOIA requests approaching or past their statutory deadline.', intervalSec: 3_600 },
  { name: 'deflock_refresh', description: 'Refresh De-Flock / OpenStreetMap surveillance data for covered metro regions, keeping the live map in sync.', intervalSec: 86_400 },
];

/* ------------------------------------------------------------------ */

const integrityCheck: JobHandler = async () => {
  // 1. near-duplicates: <25m apart, same technology, similar name/vendor
  const dupes = await query<{ a: string; b: string; dist: number; name_sim: number }>(
    `SELECT a1.id AS a, a2.id AS b,
            (6371008.8 * 2 * asin(sqrt(
              power(sin(radians(a2.lat - a1.lat)/2),2) +
              cos(radians(a1.lat))*cos(radians(a2.lat))*power(sin(radians(a2.lng - a1.lng)/2),2)
            )))::float8 AS dist,
            similarity(coalesce(a1.name,'') || ' ' || coalesce(a1.vendor,''),
                       coalesce(a2.name,'') || ' ' || coalesce(a2.vendor,'')) AS name_sim
     FROM surveillance_assets a1
     JOIN surveillance_assets a2
       ON a1.id < a2.id
      AND a1.technology_type = a2.technology_type
      AND abs(a1.lat - a2.lat) < 0.0005 AND abs(a1.lng - a2.lng) < 0.0005
     WHERE a1.deleted_at IS NULL AND a2.deleted_at IS NULL
     LIMIT 500`,
  );
  let candidates = 0;
  for (const d of dupes.rows) {
    if (d.dist > 25 && d.name_sim < 0.6) continue;
    const res = await query(
      `INSERT INTO merge_candidates (asset_a, asset_b, score, reasons)
       VALUES ($1, $2, $3, $4) ON CONFLICT (asset_a, asset_b) DO NOTHING`,
      [
        d.a,
        d.b,
        Math.min(1, (25 - Math.min(d.dist, 25)) / 25 * 0.6 + d.name_sim * 0.4),
        JSON.stringify([
          `distance ${Math.round(d.dist)}m`,
          `name/vendor similarity ${(d.name_sim * 100).toFixed(0)}%`,
          'same technology type',
        ]),
      ],
    );
    candidates += res.rowCount;
  }

  // 2. orphaned evidence (storage key missing)
  const evidence = await query<{ id: string; file_key: string }>(
    `SELECT id, file_key FROM asset_evidence WHERE scan_status = 'clean' ORDER BY created_at DESC LIMIT 200`,
  );
  let orphaned = 0;
  for (const e of evidence.rows) {
    if (!(await storage.exists(e.file_key))) {
      orphaned += 1;
      await query(`UPDATE asset_evidence SET scan_status = 'quarantined' WHERE id = $1`, [e.id]);
    }
  }

  // 3. assets missing jurisdiction
  const missing = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM surveillance_assets WHERE jurisdiction_id IS NULL AND deleted_at IS NULL`,
  );

  if (candidates > 0) {
    await query(
      `INSERT INTO notifications (user_id, kind, title, body, link)
       SELECT id, 'integrity', 'Possible duplicate records', $1, '/admin/curation' FROM users WHERE role = 'admin' AND status = 'active'`,
      [`${candidates} new merge candidate(s) await review.`],
    );
  }
  return { mergeCandidates: candidates, orphanedEvidence: orphaned, missingJurisdiction: missing?.n ?? 0 };
};

/* ------------------------------------------------------------------ */

const retentionEnforcement: JobHandler = async () => {
  const report: Record<string, number> = {};

  // 1. hard-anonymize users soft-deleted past the grace window
  const purgeUsers = await query<{ id: string }>(
    `SELECT id FROM users WHERE status = 'deleted' AND deleted_at < now() - ($1 || ' days')::interval`,
    [String(config.retention.deletedUserPurgeDays)],
  );
  for (const u of purgeUsers.rows) {
    await query(`UPDATE surveillance_assets SET created_by = NULL WHERE created_by = $1`, [u.id]);
    await query(`UPDATE comments SET deleted_at = now(), body = '[removed]' WHERE user_id = $1 AND deleted_at IS NULL`, [u.id]);
    await query(`DELETE FROM notifications WHERE user_id = $1`, [u.id]);
    await query(`DELETE FROM password_resets WHERE user_id = $1`, [u.id]);
    await query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [u.id]);
  }
  report.usersPurged = purgeUsers.rows.length;

  // 2. audit logs past retention: archive to storage, then prune
  const cutoff = `now() - interval '${config.retention.auditLogDays} days'`;
  const oldLogs = await query<Record<string, unknown>>(
    `SELECT * FROM audit_logs WHERE created_at < ${cutoff} ORDER BY id LIMIT 50000`,
  );
  if (oldLogs.rows.length > 0) {
    const archiveName = `archive/audit-${new Date().toISOString().slice(0, 10)}-${Date.now()}.jsonl`;
    await storage.put(
      archiveName,
      Buffer.from(oldLogs.rows.map((r) => JSON.stringify(r)).join('\n')),
      'application/x-ndjson',
    );
    const maxId = Math.max(...oldLogs.rows.map((r) => Number(r.id)));
    const { withTransaction } = await import('../../db/pool.js');
    await withTransaction(async (tx) => {
      // GUC is transaction-local on this connection; required by the
      // append-only trigger before any audit_logs delete is permitted.
      await tx.query(`SELECT set_config('stn.allow_audit_prune', 'on', true)`);
      await tx.query(`DELETE FROM audit_logs WHERE created_at < ${cutoff} AND id <= $1`, [maxId]);
    });
  }
  report.auditLogsArchived = oldLogs.rows.length;

  // 3. expired idempotency keys & old notifications
  report.idempotencyPruned = (
    await query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '48 hours'`)
  ).rowCount;
  report.notificationsPruned = (
    await query(
      `DELETE FROM notifications WHERE created_at < now() - ($1 || ' days')::interval AND read_at IS NOT NULL`,
      [String(config.retention.notificationDays)],
    )
  ).rowCount;

  // 4. expired workspace invites
  report.invitesPruned = (
    await query(`DELETE FROM workspace_invites WHERE expires_at < now() - interval '30 days'`)
  ).rowCount;

  // 5. request metrics older than 90 days
  report.metricsPruned = (
    await query(`DELETE FROM request_metrics WHERE bucket < now() - interval '90 days'`)
  ).rowCount;

  await audit({
    actorId: null,
    action: 'retention.enforced',
    resource: 'system',
    metadata: report,
  });
  await query(
    `INSERT INTO notifications (user_id, kind, title, body, link)
     SELECT id, 'compliance', 'Retention run complete', $1, '/admin/monitoring' FROM users WHERE role = 'admin' AND status = 'active'`,
    [`Compliance report: ${JSON.stringify(report)}`],
  );
  return report;
};

/* ------------------------------------------------------------------ */

const cacheWarmup: JobHandler = async () => {
  // Most active 1°×1° regions by asset density
  const regions = await query<{ glng: number; glat: number; n: number }>(
    `SELECT floor(lng)::int AS glng, floor(lat)::int AS glat, count(*)::int AS n
     FROM surveillance_assets WHERE deleted_at IS NULL
     GROUP BY 1, 2 ORDER BY n DESC LIMIT 10`,
  );
  const { cachedJson } = await import('../../cache/index.js');
  let warmed = 0;
  for (const r of regions.rows) {
    const bbox = `${r.glng},${r.glat},${r.glng + 1},${r.glat + 1}`;
    const key = `assets:${JSON.stringify({ bbox, format: 'geojson', zoom: '10' })}`;
    await cachedJson(key, 3600, async () => {
      const { rows } = await query(
        `SELECT id, name, technology_type AS "technologyType", vendor, status, confidence_score AS "confidenceScore", lng, lat
         FROM surveillance_assets
         WHERE deleted_at IS NULL AND lng BETWEEN $1 AND $2 AND lat BETWEEN $3 AND $4
         LIMIT ${LIMITS.assetPageMax}`,
        [r.glng, r.glng + 1, r.glat, r.glat + 1],
      );
      return {
        type: 'FeatureCollection',
        clustered: false,
        features: rows.map((row) => ({
          type: 'Feature',
          id: (row as { id: string }).id,
          geometry: { type: 'Point', coordinates: [(row as { lng: number }).lng, (row as { lat: number }).lat] },
          properties: row,
        })),
      };
    });
    warmed += 1;
  }
  return { regionsWarmed: warmed };
};

/* ------------------------------------------------------------------ */

function runCommand(cmd: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('error', () => resolve({ code: 127, stdout: Buffer.alloc(0), stderr: 'command not found' }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err }));
  });
}

const backupVerify: JobHandler = async () => {
  const url = new URL(config.databaseUrl);
  const env = { PGPASSWORD: decodeURIComponent(url.password) };
  const baseArgs = [
    '-h', url.hostname,
    '-p', url.port || '5432',
    '-U', decodeURIComponent(url.username),
    url.pathname.slice(1),
  ];

  const dump = await runCommand('pg_dump', ['--format=custom', '--no-owner', ...baseArgs], env);
  if (dump.code !== 0) {
    throw new Error(`pg_dump failed (${dump.code}): ${dump.stderr.slice(0, 400)}`);
  }
  const key = `backups/stn-${new Date().toISOString().slice(0, 10)}.dump`;
  await storage.put(key, dump.stdout, 'application/octet-stream');

  // Weekly restore verification (Sundays): restore into scratch DB and count tables.
  let restoreVerified: boolean | string = 'skipped (runs Sundays)';
  if (new Date().getDay() === 0) {
    const scratch = 'stn_restore_verify';
    const psqlBase = ['-h', url.hostname, '-p', url.port || '5432', '-U', decodeURIComponent(url.username)];
    await runCommand('psql', [...psqlBase, '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${scratch}`], env);
    const create = await runCommand('psql', [...psqlBase, '-d', 'postgres', '-c', `CREATE DATABASE ${scratch}`], env);
    if (create.code === 0) {
      const tmp = `/tmp/stn-restore-${Date.now()}.dump`;
      const fs = await import('node:fs');
      await fs.promises.writeFile(tmp, dump.stdout);
      const restore = await runCommand(
        'pg_restore',
        ['--no-owner', '-h', url.hostname, '-p', url.port || '5432', '-U', decodeURIComponent(url.username), '-d', scratch, tmp],
        env,
      );
      const check = await runCommand(
        'psql',
        [...psqlBase, '-d', scratch, '-t', '-c', `SELECT count(*) FROM information_schema.tables WHERE table_schema='public'`],
        env,
      );
      const tableCount = Number(check.stdout.toString().trim());
      restoreVerified = restore.code === 0 && tableCount > 10;
      await fs.promises.unlink(tmp).catch(() => undefined);
      await runCommand('psql', [...psqlBase, '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${scratch}`], env);
      if (restoreVerified !== true) {
        throw new Error(`Restore verification failed: code=${restore.code} tables=${tableCount}`);
      }
    } else {
      restoreVerified = `scratch db create failed: ${create.stderr.slice(0, 200)}`;
    }
  }
  return { backupKey: key, sizeBytes: dump.stdout.length, restoreVerified };
};

/* ------------------------------------------------------------------ */

const scanPendingFiles: JobHandler = async () => {
  const pending = await query<{ id: string; file_key: string; file_type: string; table: string }>(
    `SELECT id, file_key, file_type, 'asset_evidence' AS "table" FROM asset_evidence WHERE scan_status = 'pending'
     UNION ALL
     SELECT id, file_key, file_type, 'foia_documents' AS "table" FROM foia_documents WHERE scan_status = 'pending'
     LIMIT 50`,
  );
  let scanned = 0;
  let quarantined = 0;
  for (const f of pending.rows) {
    const table = f.table === 'asset_evidence' ? 'asset_evidence' : 'foia_documents';
    const buf = await storage.get(f.file_key);
    if (!buf) {
      await query(`UPDATE ${table} SET scan_status = 'quarantined' WHERE id = $1`, [f.id]);
      quarantined += 1;
      continue;
    }
    const result = await scanUpload(buf, f.file_type);
    if (result.malware === 'quarantined') {
      await storage.put(quarantineKey(f.file_key), buf);
      await storage.delete(f.file_key);
      quarantined += 1;
    }
    await query(`UPDATE ${table} SET scan_status = $2, pii_status = $3 WHERE id = $1`, [
      f.id,
      result.malware,
      result.pii === 'flagged' ? 'flagged' : 'clean',
    ]);
    scanned += 1;
  }
  return { scanned, quarantined };
};

/* ------------------------------------------------------------------ */

const confidenceRecalc: JobHandler = async () => {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM surveillance_assets WHERE deleted_at IS NULL ORDER BY updated_at LIMIT 5000`,
  );
  let updated = 0;
  for (const r of rows) {
    await recalcAssetConfidence(r.id);
    updated += 1;
  }
  const { cache } = await import('../../cache/index.js');
  await cache.del('assets:', true);
  return { recalculated: updated };
};

/* ------------------------------------------------------------------ */

const exportCleanup: JobHandler = async () => {
  const expired = await query<{ id: string; file_key: string | null }>(
    `UPDATE exports SET status = 'expired'
     WHERE status = 'completed' AND expires_at < now()
     RETURNING id, file_key`,
  );
  for (const e of expired.rows) {
    if (e.file_key) await storage.delete(e.file_key).catch(() => undefined);
  }
  return { expired: expired.rows.length };
};

/* ------------------------------------------------------------------ */

const indexMaintenance: JobHandler = async () => {
  const hotTables = ['surveillance_assets', 'audit_logs', 'jobs', 'foia_requests', 'procurements', 'policies', 'notifications'];
  for (const t of hotTables) {
    await query(`ANALYZE ${t}`);
  }
  const bloat = await query<{ relname: string; dead: number; live: number }>(
    `SELECT relname, n_dead_tup::int AS dead, n_live_tup::int AS live
     FROM pg_stat_user_tables WHERE n_live_tup > 0 ORDER BY n_dead_tup DESC LIMIT 20`,
  );
  const vacuumed: string[] = [];
  for (const r of bloat.rows) {
    if (r.dead > 1000 && r.dead > r.live * 0.2 && hotTables.includes(r.relname)) {
      await query(`VACUUM (ANALYZE) ${r.relname}`);
      vacuumed.push(r.relname);
    }
  }
  const anomalies = bloat.rows.filter((r) => r.dead > r.live * 2 && r.dead > 10_000);
  if (anomalies.length > 0) {
    await query(
      `INSERT INTO notifications (user_id, kind, title, body, link)
       SELECT id, 'db_health', 'Table bloat anomaly', $1, '/admin/monitoring' FROM users WHERE role = 'admin' AND status = 'active'`,
      [`High dead-tuple ratio: ${anomalies.map((a) => a.relname).join(', ')}`],
    );
  }
  return { analyzed: hotTables.length, vacuumed, anomalies: anomalies.map((a) => a.relname) };
};

/* ------------------------------------------------------------------ */

const foiaDeadlineCheck: JobHandler = async () => {
  const approaching = await query<{
    id: string;
    subject: string;
    due_at: string;
    created_by: string;
    workspace_id: string;
  }>(
    `SELECT id, subject, due_at, created_by, workspace_id FROM foia_requests
     WHERE deleted_at IS NULL AND status IN ('sent','acknowledged')
       AND due_at IS NOT NULL AND due_at < now() + interval '3 days'
       AND (reminded_at IS NULL OR reminded_at < now() - interval '24 hours')
     LIMIT 100`,
  );
  let reminded = 0;
  for (const f of approaching.rows) {
    const overdue = new Date(f.due_at).getTime() < Date.now();
    await query(
      `INSERT INTO notifications (user_id, kind, title, body, link) VALUES ($1, 'foia_deadline', $2, $3, $4)`,
      [
        f.created_by,
        overdue ? 'FOIA response overdue' : 'FOIA deadline approaching',
        `"${f.subject.slice(0, 100)}" ${overdue ? 'passed its statutory response deadline — consider a follow-up or appeal.' : `is due ${new Date(f.due_at).toLocaleDateString()}.`}`,
        `/foia/${f.id}`,
      ],
    );
    const owner = await queryOne<{ email: string; name: string }>(`SELECT email, name FROM users WHERE id = $1`, [f.created_by]);
    if (owner) {
      await sendMail({
        to: owner.email,
        subject: overdue ? `FOIA overdue: ${f.subject.slice(0, 80)}` : `FOIA deadline soon: ${f.subject.slice(0, 80)}`,
        text: `Hi ${owner.name},\n\nYour public records request "${f.subject}" ${overdue ? 'has passed' : 'is approaching'} its statutory response deadline (${new Date(f.due_at).toDateString()}).\n\nTrack it: ${config.publicUrl}/foia/${f.id}\n\n— Lens of Light`,
      });
    }
    await query(`UPDATE foia_requests SET reminded_at = now() WHERE id = $1`, [f.id]);
    reminded += 1;
  }
  return { reminded };
};

/* ------------------------------------------------------------------ */

const dedupeScanOne: JobHandler = async (payload) => {
  const assetId = String(payload.assetId ?? '');
  if (!assetId) return { skipped: true };
  const matches = await query<{ id: string; dist: number; sim: number }>(
    `SELECT a2.id,
            (6371008.8 * 2 * asin(sqrt(
              power(sin(radians(a2.lat - a1.lat)/2),2) +
              cos(radians(a1.lat))*cos(radians(a2.lat))*power(sin(radians(a2.lng - a1.lng)/2),2)
            )))::float8 AS dist,
            similarity(coalesce(a1.name,''), coalesce(a2.name,'')) AS sim
     FROM surveillance_assets a1
     JOIN surveillance_assets a2 ON a2.id != a1.id
       AND a2.technology_type = a1.technology_type
       AND abs(a1.lat - a2.lat) < 0.0005 AND abs(a1.lng - a2.lng) < 0.0005
       AND a2.deleted_at IS NULL
     WHERE a1.id = $1 AND a1.deleted_at IS NULL
     LIMIT 10`,
    [assetId],
  );
  let queued = 0;
  for (const m of matches.rows) {
    if (m.dist > 25) continue;
    const [a, b] = assetId < m.id ? [assetId, m.id] : [m.id, assetId];
    const res = await query(
      `INSERT INTO merge_candidates (asset_a, asset_b, score, reasons) VALUES ($1, $2, $3, $4)
       ON CONFLICT (asset_a, asset_b) DO NOTHING`,
      [a, b, Math.min(1, 0.5 + m.sim / 2), JSON.stringify([`distance ${Math.round(m.dist)}m`, `name similarity ${(m.sim * 100).toFixed(0)}%`])],
    );
    queued += res.rowCount;
  }
  return { merged: 0, candidatesQueued: queued };
};

/* ------------------------------------------------------------------ */

const statuteRecheckJob: JobHandler = async () => {
  const { recheckStatutes } = await import('../../services/statutes.js');
  const result = await recheckStatutes();
  return { ...result };
};

const parseProcurementJob: JobHandler = async (payload) => {
  const procurementId = String(payload.procurementId ?? '');
  const proc = await queryOne<{ id: string; raw_file_key: string | null; raw_text_excerpt: string | null; title: string }>(
    `SELECT id, raw_file_key, raw_text_excerpt, title FROM procurements WHERE id = $1`,
    [procurementId],
  );
  if (!proc) throw new Error('Procurement record vanished');

  let text = String(payload.text ?? '');
  if (!text && proc.raw_file_key) {
    const buf = await storage.get(proc.raw_file_key);
    if (!buf) throw new Error('Raw document missing from storage');
    if (buf.subarray(0, 4).toString('latin1') === '%PDF') {
      try {
        const pdfParse = (await import('pdf-parse')).default;
        const parsed = await pdfParse(buf);
        text = parsed.text ?? '';
      } catch (err) {
        // OCR-needed / corrupted PDF → flag for manual review, don't fail forever
        await query(
          `UPDATE procurements SET normalized = normalized || $2::jsonb, review_status = 'needs_review' WHERE id = $1`,
          [procurementId, JSON.stringify({ parseError: `PDF text extraction failed: ${(err as Error).message.slice(0, 200)}. Manual transcription or OCR required.` })],
        );
        return { status: 'needs_manual_review' };
      }
    } else {
      text = buf.toString('utf8');
    }
  }

  const result = parseProcurementText(text);
  await query(
    `UPDATE procurements SET
       vendor = COALESCE($2, vendor),
       amount = COALESCE($3, amount),
       start_date = COALESCE($4::date, start_date),
       end_date = COALESCE($5::date, end_date),
       technology_terms = $6,
       confidence_score = $7,
       raw_text_excerpt = $8,
       normalized = $9,
       review_status = 'needs_review'
     WHERE id = $1`,
    [
      procurementId,
      result.vendor,
      result.amount,
      result.startDate,
      result.endDate,
      result.technologyTerms,
      result.confidence,
      result.excerpt,
      JSON.stringify({
        vendorEvidence: result.vendorEvidence,
        amountEvidence: result.amountEvidence,
        dateEvidence: result.dateEvidence,
        fieldConfidence: result.fieldConfidence,
        warnings: result.warnings,
        // PII detected in the submitted text — reviewers see it before approval
        ...(Array.isArray(payload.piiKinds) && (payload.piiKinds as string[]).length > 0
          ? { piiKinds: payload.piiKinds }
          : {}),
      }),
    ],
  );
  return { confidence: result.confidence, technologyTerms: result.technologyTerms };
};

/* ------------------------------------------------------------------ */

interface ExportRow extends Record<string, unknown> {
  lng?: number;
  lat?: number;
}

const generateExport: JobHandler = async (payload) => {
  const exportId = String(payload.exportId ?? '');
  const job = await queryOne<{
    id: string;
    user_id: string;
    workspace_id: string | null;
    format: string;
    resource: string;
    params: Record<string, unknown>;
  }>(`SELECT * FROM exports WHERE id = $1`, [exportId]);
  if (!job) throw new Error('Export record missing');

  await query(`UPDATE exports SET status = 'processing' WHERE id = $1`, [exportId]);

  const owner = await queryOne<{ plan: string; role: string }>(`SELECT plan, role FROM users WHERE id = $1`, [job.user_id]);
  const isPro = owner?.plan === 'pro' || owner?.role === 'admin';
  const params = job.params ?? {};
  const cap = isPro ? LIMITS.exportMaxRows : LIMITS.exportFreeRows;
  let rows: ExportRow[] = [];
  let columns: string[] = [];

  if (job.resource === 'assets' || job.resource === 'report') {
    const where: string[] = ['a.deleted_at IS NULL'];
    const qp: unknown[] = [];
    let i = 1;
    if (typeof params.jurisdictionId === 'string') {
      where.push(`a.jurisdiction_id = $${i}`);
      qp.push(params.jurisdictionId);
      i += 1;
    }
    if (Array.isArray(params.technologyType) && params.technologyType.length > 0) {
      where.push(`a.technology_type = ANY($${i}::text[])`);
      qp.push(params.technologyType);
      i += 1;
    }
    if (typeof params.minConfidence === 'number') {
      where.push(`a.confidence_score >= $${i}`);
      qp.push(params.minConfidence);
      i += 1;
    }
    if (typeof params.bbox === 'string') {
      const parts = params.bbox.split(',').map(Number);
      if (parts.length === 4 && parts.every(Number.isFinite)) {
        where.push(`a.lng BETWEEN $${i} AND $${i + 1} AND a.lat BETWEEN $${i + 2} AND $${i + 3}`);
        qp.push(parts[0], parts[2], parts[1], parts[3]);
        i += 4;
      }
    }
    const res = await query<ExportRow>(
      `SELECT a.id, a.name, j.name AS jurisdiction, a.technology_type, a.vendor, a.status,
              to_char(a.deployment_date,'YYYY-MM-DD') AS deployment_date,
              a.confidence_score, s.name AS source, s.verification_status AS source_verification,
              a.lng, a.lat, a.last_verified_at, a.created_at
       FROM surveillance_assets a
       LEFT JOIN jurisdictions j ON j.id = a.jurisdiction_id
       LEFT JOIN sources s ON s.id = a.source_id
       WHERE ${where.join(' AND ')}
       ORDER BY a.confidence_score DESC
       LIMIT ${cap + 1}`,
      qp,
    );
    rows = res.rows;
    columns = ['id', 'name', 'jurisdiction', 'technology_type', 'vendor', 'status', 'deployment_date', 'confidence_score', 'source', 'source_verification', 'lng', 'lat', 'last_verified_at', 'created_at'];
  } else if (job.resource === 'foia') {
    if (!job.workspace_id) throw new Error('FOIA exports require a workspace');
    const res = await query<ExportRow>(
      `SELECT f.id, f.subject, f.status, f.outcome, f.foia_number, j.name AS jurisdiction,
              f.sent_at, f.due_at, f.created_at
       FROM foia_requests f LEFT JOIN jurisdictions j ON j.id = f.jurisdiction_id
       WHERE f.workspace_id = $1 AND f.deleted_at IS NULL ORDER BY f.created_at DESC LIMIT ${cap + 1}`,
      [job.workspace_id],
    );
    rows = res.rows;
    columns = ['id', 'subject', 'status', 'outcome', 'foia_number', 'jurisdiction', 'sent_at', 'due_at', 'created_at'];
  } else if (job.resource === 'procurements') {
    const res = await query<ExportRow>(
      `SELECT p.id, p.title, p.vendor, p.amount, p.currency, j.name AS jurisdiction,
              to_char(p.start_date,'YYYY-MM-DD') AS start_date, to_char(p.end_date,'YYYY-MM-DD') AS end_date,
              array_to_string(p.technology_terms, '; ') AS technology_terms, p.confidence_score, p.review_status
       FROM procurements p LEFT JOIN jurisdictions j ON j.id = p.jurisdiction_id
       WHERE p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT ${cap + 1}`,
    );
    rows = res.rows;
    columns = ['id', 'title', 'vendor', 'amount', 'currency', 'jurisdiction', 'start_date', 'end_date', 'technology_terms', 'confidence_score', 'review_status'];
  } else if (job.resource === 'policies') {
    const res = await query<ExportRow>(
      `SELECT p.id, p.title, j.name AS jurisdiction, to_char(p.effective_date,'YYYY-MM-DD') AS effective_date,
              p.source_url, left(p.content, 2000) AS content
       FROM policies p JOIN jurisdictions j ON j.id = p.jurisdiction_id
       WHERE p.deleted_at IS NULL ORDER BY p.effective_date DESC LIMIT ${cap + 1}`,
    );
    rows = res.rows;
    columns = ['id', 'title', 'jurisdiction', 'effective_date', 'source_url', 'content'];
  } else {
    throw new Error(`Unknown export resource ${job.resource}`);
  }

  const truncated = rows.length > cap;
  if (truncated) rows = rows.slice(0, cap);

  let file: Buffer;
  let contentType: string;
  switch (job.format) {
    case 'csv':
      file = Buffer.from(toCsv(rows, columns));
      contentType = 'text/csv';
      break;
    case 'json':
      file = Buffer.from(JSON.stringify({ exportedAt: new Date().toISOString(), truncated, rows }, null, 2));
      contentType = 'application/json';
      break;
    case 'geojson': {
      const geo = rows.filter((r) => typeof r.lng === 'number' && typeof r.lat === 'number');
      file = Buffer.from(
        toGeoJson(geo.map((r) => ({ lng: r.lng!, lat: r.lat!, id: String(r.id), properties: r }))),
      );
      contentType = 'application/geo+json';
      break;
    }
    case 'kml': {
      const geo = rows.filter((r) => typeof r.lng === 'number' && typeof r.lat === 'number');
      file = Buffer.from(toKml(geo.map((r) => ({ lng: r.lng!, lat: r.lat!, id: String(r.id), properties: r }))));
      contentType = 'application/vnd.google-earth.kml+xml';
      break;
    }
    case 'pdf':
    case 'html': {
      const title = `STN ${job.resource} report`;
      if (job.format === 'pdf') {
        const pdf = new PdfBuilder(title);
        pdf.heading('Surveillance Transparency Navigator', 1);
        pdf.text(`Report: ${job.resource} — generated ${new Date().toUTCString()}`, { size: 9 });
        pdf.text(`Records: ${rows.length}${truncated ? ` (truncated at ${cap})` : ''}`, { size: 9 });
        pdf.spacer(6);
        if (job.resource === 'assets' || job.resource === 'report') {
          const geo = rows.filter((r) => typeof r.lng === 'number' && typeof r.lat === 'number');
          if (geo.length > 1) {
            const lngs = geo.map((r) => r.lng!);
            const lats = geo.map((r) => r.lat!);
            pdf.heading('Map snapshot', 2);
            pdf.mapSnapshot(
              geo.map((r) => {
                const hex = TECH_COLORS[(r.technology_type as TechnologyType) ?? 'other'] ?? '#00E5A8';
                const rgb: [number, number, number] = [
                  parseInt(hex.slice(1, 3), 16) / 255,
                  parseInt(hex.slice(3, 5), 16) / 255,
                  parseInt(hex.slice(5, 7), 16) / 255,
                ];
                return { lng: r.lng!, lat: r.lat!, color: rgb };
              }),
              {
                minLng: Math.min(...lngs) - 0.05,
                minLat: Math.min(...lats) - 0.05,
                maxLng: Math.max(...lngs) + 0.05,
                maxLat: Math.max(...lats) + 0.05,
              },
            );
          }
        }
        pdf.heading('Records', 2);
        const tableCols = columns.slice(0, 6);
        pdf.table(tableCols, rows.slice(0, 400).map((r) => tableCols.map((c) => String(r[c] ?? ''))));
        pdf.heading('Methodology & provenance', 2);
        pdf.text(
          'Data aggregated by the Surveillance Transparency Navigator. Confidence scores combine source verification status, evidence, verification recency, dispute history and corroboration (0–100, explainable per record). Unverified community records are clearly marked. Full provenance and change history is available per record in the platform.',
          { size: 9 },
        );
        if (truncated) {
          pdf.text(`Note: output truncated to ${cap} rows. Narrow filters or use CSV/JSON for complete data.`, { size: 9, color: [0.8, 0.3, 0.3] });
        }
        file = pdf.build();
        contentType = 'application/pdf';
      } else {
        const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        file = Buffer.from(
          `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:14px/1.5 system-ui;margin:2rem;color:#0b0f14}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccd;padding:6px 8px;font-size:12px;text-align:left}th{background:#eef2f7}h1{color:#00795c}</style>
</head><body><h1>${esc(title)}</h1><p>Generated ${new Date().toUTCString()} — ${rows.length} records${truncated ? ` (truncated at ${cap})` : ''}</p>
<table><thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
<tbody>${rows.map((r) => `<tr>${columns.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table>
<p style="margin-top:2rem;font-size:12px;color:#555">Methodology: confidence scores combine source verification, evidence, recency, disputes and corroboration. Generated by Surveillance Transparency Navigator.</p>
</body></html>`,
        );
        contentType = 'text/html';
      }
      break;
    }
    default:
      throw new Error(`Unsupported format ${job.format}`);
  }

  const key = exportKey(exportId, job.format);
  await storage.put(key, file, contentType);
  await query(
    `UPDATE exports SET status = 'completed', file_key = $2, row_count = $3, truncated = $4,
       completed_at = now(), expires_at = now() + ($5 || ' hours')::interval
     WHERE id = $1`,
    [exportId, key, rows.length, truncated, String(config.retention.exportTtlHours)],
  );
  await query(
    `INSERT INTO notifications (user_id, kind, title, body, link) VALUES ($1, 'export_ready', $2, $3, $4)`,
    [
      job.user_id,
      'Export ready',
      `Your ${job.format.toUpperCase()} export of ${job.resource} (${rows.length} rows${truncated ? ', truncated' : ''}) is ready to download.`,
      `/reports`,
    ],
  );
  return { rows: rows.length, truncated, key };
};

const importRegionJob: JobHandler = async (payload) => {
  const bbox = payload.bbox as Bbox | undefined;
  const tile = typeof payload.tile === 'string' ? payload.tile : undefined;
  if (!bbox || typeof bbox.minLng !== 'number') return { skipped: 'invalid bbox' };
  return { ...(await runImportRegion(bbox, tile)) };
};

const deflockRefresh: JobHandler = async () => ({ ...(await refreshDeflockMetros()) });

export const jobDefinitions: Record<string, JobHandler> = {
  import_region: importRegionJob,
  deflock_refresh: deflockRefresh,
  integrity_check: integrityCheck,
  retention_enforcement: retentionEnforcement,
  cache_warmup: cacheWarmup,
  backup_verify: backupVerify,
  scan_pending_files: scanPendingFiles,
  confidence_recalc: confidenceRecalc,
  export_cleanup: exportCleanup,
  index_maintenance: indexMaintenance,
  foia_deadline_check: foiaDeadlineCheck,
  dedupe_scan_one: dedupeScanOne,
  parse_procurement: parseProcurementJob,
  statute_recheck: statuteRecheckJob,
  generate_export: generateExport,
};
