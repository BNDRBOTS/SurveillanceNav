import type { FastifyInstance } from 'fastify';
import {
  listAssetsQuery,
  createAssetSchema,
  updateAssetSchema,
  flagAssetSchema,
  disputeAssetSchema,
  createCommentSchema,
  uuid as uuidSchema,
  pointToBbox,
  LIMITS,
  ALLOWED_UPLOAD_MIME,
} from '@stn/shared';
import { parseOrThrow, paginate, safeSort } from '../lib/validation.js';
import { query, queryOne, withTransaction, isDbHealthy } from '../db/pool.js';
import { requireAuth, requireRole, workspaceRole } from '../plugins/auth.js';
import { badRequest, notFound, serviceUnavailable, payloadTooLarge } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { recalcAssetConfidence } from '../services/confidence.js';
import { scanUpload } from '../services/scanner.js';
import { storage, evidenceKey, quarantineKey } from '../storage/index.js';
import { cache, cachedJson } from '../cache/index.js';
import { enqueueJob } from '../jobs/queue.js';
import { maybeEnqueueImport } from '../services/overpass.js';

let postgisChecked = false;
let postgis = false;

export async function hasPostgis(): Promise<boolean> {
  if (postgisChecked) return postgis;
  try {
    const row = await queryOne(`SELECT 1 FROM pg_extension WHERE extname = 'postgis'`);
    postgis = !!row;
  } catch {
    postgis = false;
  }
  postgisChecked = true;
  return postgis;
}

const ASSET_SELECT = `
  a.id, a.name, a.jurisdiction_id AS "jurisdictionId", j.name AS "jurisdictionName",
  a.source_id AS "sourceId", s.name AS "sourceName", s.type AS "sourceType",
  s.verification_status AS "sourceVerification",
  a.technology_type AS "technologyType", a.vendor, a.status,
  to_char(a.deployment_date, 'YYYY-MM-DD') AS "deploymentDate",
  to_char(a.retirement_date, 'YYYY-MM-DD') AS "retirementDate",
  a.confidence_score AS "confidenceScore", a.confidence_factors AS "confidenceFactors",
  a.lng, a.lat, a.properties,
  (SELECT count(*)::int FROM asset_evidence e WHERE e.asset_id = a.id AND e.scan_status = 'clean') AS "evidenceCount",
  (SELECT count(*)::int FROM disputes d WHERE d.asset_id = a.id AND d.status IN ('open','under_review')) AS "openDisputes",
  a.last_verified_at AS "lastVerifiedAt", a.created_at AS "createdAt", a.updated_at AS "updatedAt"
`;

interface FilterBuild {
  where: string;
  params: unknown[];
}

function buildFilters(q: ReturnType<typeof listAssetsQuery.parse>, startIndex = 1): FilterBuild {
  const clauses: string[] = ['a.deleted_at IS NULL'];
  const params: unknown[] = [];
  let i = startIndex;

  let bboxFilter = q.bbox;
  if (!bboxFilter && q.nearLng !== undefined && q.nearLat !== undefined) {
    bboxFilter = pointToBbox(q.nearLng, q.nearLat, q.radiusMeters ?? 1609);
  }
  if (bboxFilter) {
    clauses.push(`a.lng BETWEEN $${i} AND $${i + 1} AND a.lat BETWEEN $${i + 2} AND $${i + 3}`);
    params.push(bboxFilter.minLng, bboxFilter.maxLng, bboxFilter.minLat, bboxFilter.maxLat);
    i += 4;
  }
  if (q.jurisdictionId) {
    clauses.push(`(a.jurisdiction_id = $${i} OR j.parent_id = $${i})`);
    params.push(q.jurisdictionId);
    i += 1;
  }
  if (q.technologyType?.length) {
    clauses.push(`a.technology_type = ANY($${i}::text[])`);
    params.push(q.technologyType);
    i += 1;
  }
  if (q.vendor) {
    clauses.push(`a.vendor ILIKE $${i}`);
    params.push(`%${q.vendor}%`);
    i += 1;
  }
  if (q.status?.length) {
    clauses.push(`a.status = ANY($${i}::text[])`);
    params.push(q.status);
    i += 1;
  }
  if (q.sourceType?.length) {
    clauses.push(`s.type = ANY($${i}::text[])`);
    params.push(q.sourceType);
    i += 1;
  }
  if (q.verification) {
    clauses.push(`s.verification_status = $${i}`);
    params.push(q.verification);
    i += 1;
  }
  if (q.minConfidence !== undefined) {
    clauses.push(`a.confidence_score >= $${i}`);
    params.push(q.minConfidence);
    i += 1;
  }
  if (q.deployedAfter) {
    clauses.push(`a.deployment_date >= $${i}`);
    params.push(q.deployedAfter);
    i += 1;
  }
  if (q.deployedBefore) {
    clauses.push(`a.deployment_date <= $${i}`);
    params.push(q.deployedBefore);
    i += 1;
  }
  if (q.q) {
    clauses.push(`(a.fts @@ plainto_tsquery('english', $${i}) OR a.name ILIKE $${i + 1})`);
    params.push(q.q, `%${q.q}%`);
    i += 2;
  }
  return { where: clauses.join(' AND '), params };
}

/** Grid clustering for low zooms — keeps payloads bounded at any scale. */
async function clusteredResponse(q: ReturnType<typeof listAssetsQuery.parse>, filters: FilterBuild) {
  const zoom = q.zoom ?? 4;
  const cellDeg = 360 / 2 ** Math.min(14, Math.floor(zoom) + 2) * 4;
  const { rows } = await query<{
    glng: number;
    glat: number;
    count: number;
    tech: Record<string, number>;
  }>(
    `SELECT
       (floor(a.lng / ${cellDeg}) * ${cellDeg} + ${cellDeg / 2})::float8 AS glng,
       (floor(a.lat / ${cellDeg}) * ${cellDeg} + ${cellDeg / 2})::float8 AS glat,
       count(*)::int AS count,
       jsonb_object_agg(t.technology_type, t.n) AS tech
     FROM surveillance_assets a
     LEFT JOIN jurisdictions j ON j.id = a.jurisdiction_id
     LEFT JOIN sources s ON s.id = a.source_id
     CROSS JOIN LATERAL (
       SELECT a.technology_type, 1 AS n
     ) t
     WHERE ${filters.where}
     GROUP BY 1, 2
     ORDER BY count DESC
     LIMIT 4000`,
    filters.params,
  );
  return {
    type: 'FeatureCollection' as const,
    clustered: true,
    features: rows.map((r) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [r.glng, r.glat] as [number, number] },
      properties: { cluster: true as const, count: r.count, techBreakdown: r.tech },
    })),
  };
}

async function snapshotHistory(
  assetId: string,
  userId: string | null,
  action: string,
  diff: Record<string, { from: unknown; to: unknown }> | null,
): Promise<void> {
  await query(`INSERT INTO asset_history (asset_id, user_id, action, diff) VALUES ($1, $2, $3, $4)`, [
    assetId,
    userId,
    action,
    diff ? JSON.stringify(diff) : null,
  ]);
}

export function registerAssetRoutes(app: FastifyInstance): void {
  /**
   * GET /assets — spatial + attribute filters, pagination & sort.
   * format=geojson returns features; at zoom < 9 with a bbox the server
   * returns grid clusters instead of raw points so the map stays smooth at
   * 100k+ records. Results are cached (30s, stale-while-revalidate via
   * client) and served from cache when the DB is degraded.
   */
  app.get('/assets', async (req, reply) => {
    const q = parseOrThrow(listAssetsQuery, req.query);
    const filters = buildFilters(q);
    const cacheKey = `assets:${JSON.stringify(req.query)}`;

    // De-Flock: auto-import this viewport in the background (throttled per tile,
    // best-effort, never blocks). A fresh map fills in with real data as browsed.
    void maybeEnqueueImport(q.bbox, q.zoom);

    if (!isDbHealthy()) {
      const cached = await cache.get(cacheKey);
      if (cached) {
        reply.header('X-Data-Stale', 'true');
        return reply.send(JSON.parse(cached));
      }
      throw serviceUnavailable('Asset data is temporarily unavailable — showing nothing rather than guessing.');
    }

    const result = await cachedJson(cacheKey, 30, async () => {
      if (q.format === 'geojson' && q.bbox && (q.zoom ?? 24) < 9) {
        return clusteredResponse(q, filters);
      }
      if (q.format === 'geojson') {
        const limit = Math.min(q.pageSize === 50 ? LIMITS.assetPageMax : q.pageSize, LIMITS.assetPageMax);
        const { rows } = await query<Record<string, unknown>>(
          `SELECT ${ASSET_SELECT}
           FROM surveillance_assets a
           LEFT JOIN jurisdictions j ON j.id = a.jurisdiction_id
           LEFT JOIN sources s ON s.id = a.source_id
           WHERE ${filters.where}
           ORDER BY a.confidence_score DESC
           LIMIT ${limit}`,
          filters.params,
        );
        const total = await queryOne<{ n: number }>(
          `SELECT count(*)::int AS n FROM surveillance_assets a
           LEFT JOIN jurisdictions j ON j.id = a.jurisdiction_id
           LEFT JOIN sources s ON s.id = a.source_id WHERE ${filters.where}`,
          filters.params,
        );
        return {
          type: 'FeatureCollection' as const,
          clustered: false,
          total: total?.n ?? rows.length,
          truncated: (total?.n ?? 0) > rows.length,
          features: rows.map((r) => ({
            type: 'Feature' as const,
            id: r.id,
            geometry: { type: 'Point' as const, coordinates: [r.lng, r.lat] },
            properties: r,
          })),
        };
      }

      const sortCol = safeSort(
        q.sort,
        {
          name: 'a.name',
          confidence: 'a.confidence_score',
          deployed: 'a.deployment_date',
          updated: 'a.updated_at',
          created: 'a.created_at',
        },
        'a.updated_at',
      );
      const offset = (q.page - 1) * q.pageSize;
      const { rows } = await query<Record<string, unknown>>(
        `SELECT ${ASSET_SELECT}
         FROM surveillance_assets a
         LEFT JOIN jurisdictions j ON j.id = a.jurisdiction_id
         LEFT JOIN sources s ON s.id = a.source_id
         WHERE ${filters.where}
         ORDER BY ${sortCol} ${q.order === 'asc' ? 'ASC' : 'DESC'} NULLS LAST
         LIMIT ${q.pageSize} OFFSET ${offset}`,
        filters.params,
      );
      const total = await queryOne<{ n: number }>(
        `SELECT count(*)::int AS n FROM surveillance_assets a
         LEFT JOIN jurisdictions j ON j.id = a.jurisdiction_id
         LEFT JOIN sources s ON s.id = a.source_id WHERE ${filters.where}`,
        filters.params,
      );
      return paginate(rows, total?.n ?? 0, q);
    });

    return reply.send(result);
  });

  /** Radius/route proximity analysis with real distances. */
  app.get('/assets/nearby', async (req) => {
    const params = req.query as Record<string, string>;
    const lng = Number(params.lng);
    const lat = Number(params.lat);
    const radius = Math.min(Number(params.radiusMeters ?? 1609), 50_000);
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw badRequest('Provide valid lng/lat coordinates');
    }
    if (await hasPostgis()) {
      const { rows } = await query(
        `SELECT ${ASSET_SELECT},
                ST_Distance(a.geo_point, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)::float8 AS "distanceMeters"
         FROM surveillance_assets a
         LEFT JOIN jurisdictions j ON j.id = a.jurisdiction_id
         LEFT JOIN sources s ON s.id = a.source_id
         WHERE a.deleted_at IS NULL
           AND ST_DWithin(a.geo_point, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
         ORDER BY "distanceMeters"
         LIMIT 500`,
        [lng, lat, radius],
      );
      return { items: rows, radiusMeters: radius, engine: 'postgis' };
    }
    // Fallback: bounding box prefilter + haversine in SQL
    const box = pointToBbox(lng, lat, radius);
    const { rows } = await query(
      `SELECT ${ASSET_SELECT},
              (6371008.8 * 2 * asin(sqrt(
                 power(sin(radians(a.lat - $2) / 2), 2) +
                 cos(radians($2)) * cos(radians(a.lat)) * power(sin(radians(a.lng - $1) / 2), 2)
              )))::float8 AS "distanceMeters"
       FROM surveillance_assets a
       LEFT JOIN jurisdictions j ON j.id = a.jurisdiction_id
       LEFT JOIN sources s ON s.id = a.source_id
       WHERE a.deleted_at IS NULL
         AND a.lng BETWEEN $3 AND $4 AND a.lat BETWEEN $5 AND $6
       ORDER BY "distanceMeters"
       LIMIT 500`,
      [lng, lat, box.minLng, box.maxLng, box.minLat, box.maxLat],
    );
    return { items: rows.filter((r) => (r as { distanceMeters: number }).distanceMeters <= radius), radiusMeters: radius, engine: 'haversine' };
  });

  /** Jurisdiction comparison (side-by-side stats). */
  app.get('/assets/compare', async (req) => {
    const params = req.query as Record<string, string>;
    const ids = String(params.jurisdictions ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 4);
    if (ids.length < 2) throw badRequest('Provide 2–4 jurisdiction ids: ?jurisdictions=a,b');
    for (const id of ids) parseOrThrow(uuidSchema, id);

    const results = await Promise.all(
      ids.map(async (id) => {
        const j = await queryOne<{ id: string; name: string; type: string }>(
          `SELECT id, name, type FROM jurisdictions WHERE id = $1`,
          [id],
        );
        if (!j) throw notFound('Jurisdiction');
        const stats = await query<{ technology_type: string; n: number; avg_conf: number }>(
          `SELECT technology_type, count(*)::int AS n, avg(confidence_score)::float8 AS avg_conf
           FROM surveillance_assets a
           LEFT JOIN jurisdictions jj ON jj.id = a.jurisdiction_id
           WHERE a.deleted_at IS NULL AND (a.jurisdiction_id = $1 OR jj.parent_id = $1)
           GROUP BY technology_type ORDER BY n DESC`,
          [id],
        );
        const policies = await queryOne<{ n: number }>(
          `SELECT count(*)::int AS n FROM policies WHERE jurisdiction_id = $1 AND deleted_at IS NULL`,
          [id],
        );
        const procurement = await queryOne<{ n: number; total: number | null }>(
          `SELECT count(*)::int AS n, sum(amount)::float8 AS total FROM procurements
           WHERE jurisdiction_id = $1 AND deleted_at IS NULL AND review_status = 'approved'`,
          [id],
        );
        return {
          jurisdiction: j,
          technologies: stats.rows,
          totalAssets: stats.rows.reduce((acc, r) => acc + r.n, 0),
          policyCount: policies?.n ?? 0,
          procurementCount: procurement?.n ?? 0,
          procurementTotal: procurement?.total ?? 0,
        };
      }),
    );
    return { items: results };
  });

  app.get('/assets/:id', async (req) => {
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const asset = await queryOne<Record<string, unknown>>(
      `SELECT ${ASSET_SELECT}
       FROM surveillance_assets a
       LEFT JOIN jurisdictions j ON j.id = a.jurisdiction_id
       LEFT JOIN sources s ON s.id = a.source_id
       WHERE a.id = $1 AND a.deleted_at IS NULL`,
      [id],
    );
    if (!asset) throw notFound('Asset');

    const [evidence, history, disputes, related, relatedPolicies, relatedFoia] = await Promise.all([
      query(
        `SELECT id, asset_id AS "assetId", file_key AS "fileKey", file_name AS "fileName", file_type AS "fileType",
                size_bytes AS "sizeBytes", scan_status AS "scanStatus", pii_status AS "piiStatus", created_at AS "createdAt"
         FROM asset_evidence WHERE asset_id = $1 AND scan_status != 'quarantined' ORDER BY created_at DESC`,
        [id],
      ),
      query(
        `SELECT h.id, h.asset_id AS "assetId", h.user_id AS "userId", u.name AS "userName", h.action, h.diff, h.created_at AS "createdAt"
         FROM asset_history h LEFT JOIN users u ON u.id = h.user_id
         WHERE h.asset_id = $1 ORDER BY h.created_at DESC LIMIT 100`,
        [id],
      ),
      query(
        `SELECT d.id, d.asset_id AS "assetId", d.reason, d.status, d.resolution, d.created_at AS "createdAt", d.updated_at AS "updatedAt"
         FROM disputes d WHERE d.asset_id = $1 ORDER BY d.created_at DESC`,
        [id],
      ),
      query(
        `SELECT a2.id, a2.name, a2.technology_type AS "technologyType", a2.lng, a2.lat
         FROM surveillance_assets a2, surveillance_assets a1
         WHERE a1.id = $1 AND a2.id != $1 AND a2.deleted_at IS NULL
           AND a2.jurisdiction_id IS NOT DISTINCT FROM a1.jurisdiction_id
           AND abs(a2.lng - a1.lng) < 0.02 AND abs(a2.lat - a1.lat) < 0.02
         LIMIT 8`,
        [id],
      ),
      query(
        `SELECT p.id, p.title, to_char(p.effective_date, 'YYYY-MM-DD') AS "effectiveDate"
         FROM policies p JOIN surveillance_assets a ON a.id = $1
         WHERE p.jurisdiction_id = a.jurisdiction_id AND p.deleted_at IS NULL
         ORDER BY p.effective_date DESC LIMIT 5`,
        [id],
      ),
      query(
        `SELECT f.id, f.subject, f.status FROM foia_requests f JOIN surveillance_assets a ON a.id = $1
         WHERE f.jurisdiction_id = a.jurisdiction_id AND f.deleted_at IS NULL
         ORDER BY f.created_at DESC LIMIT 5`,
        [id],
      ),
    ]);

    return {
      ...asset,
      evidence: evidence.rows,
      history: history.rows,
      disputes: disputes.rows,
      related: related.rows,
      relatedPolicies: relatedPolicies.rows,
      relatedFoia: relatedFoia.rows,
    };
  });

  app.post('/assets', async (req, reply) => {
    requireRole(req, 'editor');
    const body = parseOrThrow(createAssetSchema, req.body);

    const asset = await withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO surveillance_assets
           (name, jurisdiction_id, source_id, technology_type, vendor, status,
            deployment_date, retirement_date, lng, lat, properties, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id`,
        [
          body.name,
          body.jurisdictionId ?? null,
          body.sourceId ?? null,
          body.technologyType,
          body.vendor || null,
          body.status,
          body.deploymentDate ?? null,
          body.retirementDate ?? null,
          body.lng,
          body.lat,
          JSON.stringify(body.properties),
          req.user!.id,
        ],
      );
      return rows[0] as { id: string };
    });

    await snapshotHistory(asset.id, req.user!.id, 'create', null);
    await recalcAssetConfidence(asset.id);
    await audit({ actorId: req.user!.id, action: 'asset.created', resource: 'asset', resourceId: asset.id, ip: req.ip });
    await cache.del('assets:', true);
    await enqueueJob('dedupe_scan_one', { assetId: asset.id });

    const full = await queryOne(
      `SELECT ${ASSET_SELECT} FROM surveillance_assets a
       LEFT JOIN jurisdictions j ON j.id = a.jurisdiction_id
       LEFT JOIN sources s ON s.id = a.source_id WHERE a.id = $1`,
      [asset.id],
    );
    return reply.status(201).send(full);
  });

  app.patch('/assets/:id', async (req) => {
    requireRole(req, 'editor');
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const body = parseOrThrow(updateAssetSchema, req.body);
    const before = await queryOne<Record<string, unknown>>(
      `SELECT name, jurisdiction_id, source_id, technology_type, vendor, status,
              to_char(deployment_date,'YYYY-MM-DD') AS deployment_date,
              to_char(retirement_date,'YYYY-MM-DD') AS retirement_date, lng, lat, properties
       FROM surveillance_assets WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (!before) throw notFound('Asset');

    const mapping: Record<string, string> = {
      name: 'name',
      jurisdictionId: 'jurisdiction_id',
      sourceId: 'source_id',
      technologyType: 'technology_type',
      vendor: 'vendor',
      status: 'status',
      deploymentDate: 'deployment_date',
      retirementDate: 'retirement_date',
      lng: 'lng',
      lat: 'lat',
      properties: 'properties',
    };
    const sets: string[] = [];
    const params: unknown[] = [id];
    const diff: Record<string, { from: unknown; to: unknown }> = {};
    let i = 2;
    for (const [key, col] of Object.entries(mapping)) {
      if (!(key in body)) continue;
      const value = (body as Record<string, unknown>)[key];
      const dbValue = key === 'properties' ? JSON.stringify(value) : (value === '' ? null : value);
      sets.push(`${col} = $${i}`);
      params.push(dbValue ?? null);
      if (JSON.stringify(before[col]) !== JSON.stringify(value ?? null)) {
        diff[key] = { from: before[col], to: value ?? null };
      }
      i += 1;
    }
    if (sets.length === 0) throw badRequest('No fields to update');

    await query(`UPDATE surveillance_assets SET ${sets.join(', ')} WHERE id = $1`, params);
    if (Object.keys(diff).length > 0) await snapshotHistory(id, req.user!.id, 'update', diff);
    await recalcAssetConfidence(id);
    await audit({ actorId: req.user!.id, action: 'asset.updated', resource: 'asset', resourceId: id, metadata: { fields: Object.keys(diff) }, ip: req.ip });
    await cache.del('assets:', true);

    return await queryOne(
      `SELECT ${ASSET_SELECT} FROM surveillance_assets a
       LEFT JOIN jurisdictions j ON j.id = a.jurisdiction_id
       LEFT JOIN sources s ON s.id = a.source_id WHERE a.id = $1`,
      [id],
    );
  });

  app.delete('/assets/:id', async (req) => {
    requireRole(req, 'admin');
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const res = await query(`UPDATE surveillance_assets SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (res.rowCount === 0) throw notFound('Asset');
    await snapshotHistory(id, req.user!.id, 'delete', null);
    await audit({ actorId: req.user!.id, action: 'asset.deleted', resource: 'asset', resourceId: id, ip: req.ip });
    await cache.del('assets:', true);
    return { ok: true };
  });

  /** Mark verified (editor+): bumps last_verified_at and recalculates confidence. */
  app.post('/assets/:id/verify', async (req) => {
    requireRole(req, 'editor');
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const res = await query(`UPDATE surveillance_assets SET last_verified_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (res.rowCount === 0) throw notFound('Asset');
    await snapshotHistory(id, req.user!.id, 'verify', null);
    const score = await recalcAssetConfidence(id);
    await audit({ actorId: req.user!.id, action: 'asset.verified', resource: 'asset', resourceId: id, ip: req.ip });
    await cache.del('assets:', true);
    return { ok: true, confidenceScore: score };
  });

  app.post('/assets/:id/flag', async (req, reply) => {
    requireAuth(req);
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const body = parseOrThrow(flagAssetSchema, req.body);
    const exists = await queryOne(`SELECT 1 FROM surveillance_assets WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!exists) throw notFound('Asset');
    const flag = await queryOne<{ id: string }>(
      `INSERT INTO flags (asset_id, user_id, reason) VALUES ($1, $2, $3) RETURNING id`,
      [id, req.user!.id, body.reason],
    );
    await snapshotHistory(id, req.user!.id, 'flag', null);
    await audit({ actorId: req.user!.id, action: 'asset.flagged', resource: 'asset', resourceId: id, ip: req.ip });
    return reply.status(201).send({ ok: true, flagId: flag!.id, message: 'Thanks — a curator will review this flag.' });
  });

  app.post('/assets/:id/dispute', async (req, reply) => {
    requireAuth(req);
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const body = parseOrThrow(disputeAssetSchema, req.body);
    const exists = await queryOne(`SELECT 1 FROM surveillance_assets WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!exists) throw notFound('Asset');
    const dispute = await queryOne<{ id: string }>(
      `INSERT INTO disputes (asset_id, user_id, reason, evidence, evidence_url)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [id, req.user!.id, body.reason, body.evidence, body.evidenceUrl || null],
    );
    await snapshotHistory(id, req.user!.id, 'dispute', null);
    await recalcAssetConfidence(id);
    // notify admins
    await query(
      `INSERT INTO notifications (user_id, kind, title, body, link)
       SELECT id, 'dispute_opened', 'New data dispute', $1, $2 FROM users WHERE role = 'admin' AND status = 'active'`,
      [`Dispute opened: ${body.reason.slice(0, 120)}`, `/admin/curation`],
    );
    await audit({ actorId: req.user!.id, action: 'asset.disputed', resource: 'asset', resourceId: id, ip: req.ip });
    await cache.del('assets:', true);
    return reply.status(201).send({
      ok: true,
      disputeId: dispute!.id,
      message: 'Dispute submitted. The record now shows a dispute badge until resolution.',
    });
  });

  /** Evidence upload (multipart) with full scan pipeline. */
  app.post('/assets/:id/evidence', async (req, reply) => {
    requireAuth(req);
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const exists = await queryOne(`SELECT 1 FROM surveillance_assets WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!exists) throw notFound('Asset');

    const file = await req.file();
    if (!file) throw badRequest('Attach a file (multipart field "file")');
    const buf = await file.toBuffer().catch(() => {
      throw payloadTooLarge(`Files are limited to ${Math.round(LIMITS.uploadMaxBytes / 1024 / 1024)}MB`);
    });
    if (!(ALLOWED_UPLOAD_MIME as readonly string[]).includes(file.mimetype)) {
      throw badRequest(`Unsupported file type ${file.mimetype}. Allowed: PDF, PNG, JPEG, WebP, AVIF, CSV, TXT.`);
    }

    const scan = await scanUpload(buf, file.mimetype);
    const key = evidenceKey(id, file.filename || 'evidence');
    if (scan.malware === 'quarantined') {
      await storage.put(quarantineKey(key), buf, file.mimetype);
    } else {
      await storage.put(key, buf, file.mimetype);
    }

    const row = await queryOne<{ id: string }>(
      `INSERT INTO asset_evidence (asset_id, file_key, file_name, file_type, size_bytes, scan_status, pii_status, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        id,
        key,
        (file.filename || 'evidence').slice(0, 200),
        file.mimetype,
        buf.length,
        scan.malware,
        scan.pii === 'flagged' ? 'flagged' : 'clean',
        req.user!.id,
      ],
    );
    await snapshotHistory(id, req.user!.id, 'evidence_added', null);
    await recalcAssetConfidence(id);
    await audit({
      actorId: req.user!.id,
      action: 'asset.evidence_uploaded',
      resource: 'asset',
      resourceId: id,
      metadata: { scan: scan.malware, pii: scan.pii, reasons: scan.malwareReasons, kinds: scan.piiKinds },
      ip: req.ip,
    });

    if (scan.malware === 'quarantined') {
      return reply.status(202).send({
        ok: false,
        quarantined: true,
        evidenceId: row!.id,
        message: 'This file was quarantined by the safety scan and routed to admin review. It will not be published.',
        reasons: scan.malwareReasons,
      });
    }
    return reply.status(201).send({
      ok: true,
      evidenceId: row!.id,
      fileKey: key,
      ...(scan.pii === 'flagged'
        ? { piiFlagged: true, message: 'Possible personal information detected — a reviewer will check before public display.', kinds: scan.piiKinds }
        : {}),
    });
  });

  /** Comments (workspace-scoped collaboration with @mentions). */
  app.get('/assets/:id/comments', async (req) => {
    requireAuth(req);
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const workspaceId = (req.query as { workspaceId?: string }).workspaceId;
    if (!workspaceId) throw badRequest('workspaceId is required');
    await workspaceRole(req, workspaceId, 'viewer');
    const { rows } = await query(
      `SELECT c.id, c.asset_id AS "assetId", c.workspace_id AS "workspaceId", c.user_id AS "userId",
              u.name AS "userName", c.body, c.mentions, c.created_at AS "createdAt"
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.asset_id = $1 AND c.workspace_id = $2 AND c.deleted_at IS NULL
       ORDER BY c.created_at`,
      [id, workspaceId],
    );
    return { items: rows };
  });

  app.post('/assets/:id/comments', async (req, reply) => {
    requireAuth(req);
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const body = parseOrThrow(createCommentSchema, req.body);
    await workspaceRole(req, body.workspaceId, 'editor');
    const exists = await queryOne(`SELECT 1 FROM surveillance_assets WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!exists) throw notFound('Asset');

    // Resolve @mentions ("@Full Name" or @email) to workspace members.
    const mentionTokens = body.body.match(/@([\w.+-]+@[\w.-]+|[A-Za-z][\w]*(?:\s[A-Z][\w]*)?)/g) ?? [];
    const mentioned: string[] = [];
    for (const token of mentionTokens.slice(0, 10)) {
      const needle = token.slice(1).trim();
      const m = await queryOne<{ id: string }>(
        `SELECT u.id FROM users u JOIN workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = $1
         WHERE lower(u.email) = lower($2) OR lower(u.name) = lower($2) LIMIT 1`,
        [body.workspaceId, needle],
      );
      if (m && !mentioned.includes(m.id)) mentioned.push(m.id);
    }

    const comment = await queryOne<{ id: string }>(
      `INSERT INTO comments (workspace_id, asset_id, user_id, body, mentions)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [body.workspaceId, id, req.user!.id, body.body, mentioned],
    );
    for (const userId of mentioned) {
      if (userId === req.user!.id) continue;
      await query(
        `INSERT INTO notifications (user_id, kind, title, body, link) VALUES ($1, 'mention', $2, $3, $4)`,
        [userId, 'You were mentioned', body.body.slice(0, 140), `/map?asset=${id}`],
      );
    }
    return reply.status(201).send({ ok: true, commentId: comment!.id, mentions: mentioned.length });
  });
}
