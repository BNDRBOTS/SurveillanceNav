import type { FastifyInstance } from 'fastify';
import { activeStatutes } from '../services/statutes.js';
import {
  createJurisdictionSchema,
  createSourceSchema,
  updateSourceSchema,
  layerPresetSchema,
  uuid as uuidSchema,
  FEDERAL_FOIA,
} from '@stn/shared';
import { parseOrThrow } from '../lib/validation.js';
import { query, queryOne } from '../db/pool.js';
import { requireAuth, requireRole, workspaceRole } from '../plugins/auth.js';
import { notFound, badRequest } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { cachedJson, cache } from '../cache/index.js';
import { randomToken } from '../auth/crypto.js';

export function registerReferenceRoutes(app: FastifyInstance): void {
  /* ---------------------------------------------------------- jurisdictions */

  app.get('/jurisdictions', async (req) => {
    const qp = req.query as { q?: string; type?: string; parentId?: string; withGeometry?: string };
    const key = `jurisdictions:${JSON.stringify(qp)}`;
    return cachedJson(key, 300, async () => {
      const clauses: string[] = ['true'];
      const params: unknown[] = [];
      let i = 1;
      if (qp.q) {
        clauses.push(`name ILIKE $${i}`);
        params.push(`%${qp.q.slice(0, 100)}%`);
        i += 1;
      }
      if (qp.type && ['country', 'state', 'county', 'city', 'agency'].includes(qp.type)) {
        clauses.push(`type = $${i}`);
        params.push(qp.type);
        i += 1;
      }
      if (qp.parentId) {
        parseOrThrow(uuidSchema, qp.parentId);
        clauses.push(`parent_id = $${i}`);
        params.push(qp.parentId);
        i += 1;
      }
      const { rows } = await query(
        `SELECT id, name, type, parent_id AS "parentId",
                ${qp.withGeometry === 'true' ? 'geojson,' : ''}
                (SELECT count(*)::int FROM surveillance_assets a WHERE a.jurisdiction_id = jurisdictions.id AND a.deleted_at IS NULL) AS "assetCount",
                created_at AS "createdAt"
         FROM jurisdictions WHERE ${clauses.join(' AND ')}
         ORDER BY type, name LIMIT 500`,
        params,
      );
      return { items: rows };
    });
  });

  app.get('/jurisdictions/:id', async (req) => {
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const row = await queryOne(
      `SELECT id, name, type, parent_id AS "parentId", geojson, created_at AS "createdAt" FROM jurisdictions WHERE id = $1`,
      [id],
    );
    if (!row) throw notFound('Jurisdiction');
    return row;
  });

  app.post('/jurisdictions', async (req, reply) => {
    requireRole(req, 'editor');
    const body = parseOrThrow(createJurisdictionSchema, req.body);
    const row = await queryOne<{ id: string }>(
      `INSERT INTO jurisdictions (name, type, parent_id, geojson) VALUES ($1, $2, $3, $4)
       ON CONFLICT (lower(name), type) DO UPDATE SET parent_id = EXCLUDED.parent_id
       RETURNING id`,
      [body.name, body.type, body.parentId ?? null, body.geojson ? JSON.stringify(body.geojson) : null],
    );
    await cache.del('jurisdictions:', true);
    await audit({ actorId: req.user!.id, action: 'jurisdiction.created', resource: 'jurisdiction', resourceId: row!.id, ip: req.ip });
    return reply.status(201).send(row);
  });

  /* ---------------------------------------------------------- sources */

  app.get('/sources', async () => {
    return cachedJson('sources:list', 120, async () => {
      const { rows } = await query(
        `SELECT id, name, type, url, contact, verification_status AS "verificationStatus",
                last_verified_at AS "lastVerifiedAt", created_at AS "createdAt",
                (SELECT count(*)::int FROM surveillance_assets a WHERE a.source_id = sources.id AND a.deleted_at IS NULL) AS "assetCount"
         FROM sources ORDER BY name`,
      );
      return { items: rows };
    });
  });

  app.post('/sources', async (req, reply) => {
    requireRole(req, 'editor');
    const body = parseOrThrow(createSourceSchema, req.body);
    const row = await queryOne<{ id: string }>(
      `INSERT INTO sources (name, type, url, contact) VALUES ($1, $2, $3, $4)
       ON CONFLICT (lower(name)) DO UPDATE SET url = COALESCE(EXCLUDED.url, sources.url)
       RETURNING id`,
      [body.name, body.type, body.url ?? null, body.contact ?? null],
    );
    await cache.del('sources:list');
    await audit({ actorId: req.user!.id, action: 'source.created', resource: 'source', resourceId: row!.id, ip: req.ip });
    return reply.status(201).send(row);
  });

  app.patch('/sources/:id', async (req) => {
    requireRole(req, 'admin'); // verification status changes are admin acts
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const body = parseOrThrow(updateSourceSchema, req.body);
    const updated = await queryOne(
      `UPDATE sources SET
         name = COALESCE($2, name),
         type = COALESCE($3, type),
         url = CASE WHEN $4 = 'set' THEN $5 ELSE url END,
         contact = CASE WHEN $6 = 'set' THEN $7 ELSE contact END,
         verification_status = COALESCE($8, verification_status),
         last_verified_at = CASE WHEN $8 = 'verified' THEN now() ELSE last_verified_at END
       WHERE id = $1 RETURNING id, verification_status AS "verificationStatus"`,
      [
        id,
        body.name ?? null,
        body.type ?? null,
        body.url !== undefined ? 'set' : 'keep',
        body.url ?? null,
        body.contact !== undefined ? 'set' : 'keep',
        body.contact ?? null,
        body.verificationStatus ?? null,
      ],
    );
    if (!updated) throw notFound('Source');
    await cache.del('sources:list');
    await cache.del('assets:', true);
    await audit({ actorId: req.user!.id, action: 'source.updated', resource: 'source', resourceId: id, metadata: { verificationStatus: body.verificationStatus }, ip: req.ip });
    return updated;
  });

  /* ---------------------------------------------------------- statutes (public reference) */

  app.get('/reference/foia-statutes', async () => {
    const all = await activeStatutes();
    const federal = all.find((s) => s.abbr === 'US') ?? FEDERAL_FOIA;
    const territoryKeys = new Set(['PR', 'GU', 'VI', 'MP', 'AS']);
    return {
      federal,
      states: all.filter((s) => s.abbr !== 'US' && !territoryKeys.has(s.abbr)),
      territories: all.filter((s) => territoryKeys.has(s.abbr)),
    };
  });

  /* ---------------------------------------------------------- public stats */

  /* Aggregate counts only — no user data, no coordinates, nothing precise
     enough to be sensitive. Powers the live numbers on the marketing page. */
  app.get('/stats', async () =>
    cachedJson('stats:public', 300, async () => {
      const one = async (sql: string): Promise<number> => {
        const { rows } = await query<{ n: number }>(sql);
        return rows[0]?.n ?? 0;
      };
      const [documentedAssets, foiaRequests, procurementRecords, policiesTracked, statuteJurisdictions] =
        await Promise.all([
          one(`SELECT count(*)::int AS n FROM surveillance_assets WHERE deleted_at IS NULL`),
          one(`SELECT count(*)::int AS n FROM foia_requests`),
          one(`SELECT count(*)::int AS n FROM procurements`),
          one(`SELECT count(*)::int AS n FROM policies`),
          one(`SELECT count(*)::int AS n FROM statutes WHERE review_status = 'approved' AND superseded_at IS NULL`),
        ]);
      return { documentedAssets, foiaRequests, procurementRecords, policiesTracked, statuteJurisdictions };
    }));

  /* ---------------------------------------------------------- layer presets */

  app.get('/presets', async (req) => {
    requireAuth(req);
    const { rows } = await query(
      `SELECT p.id, p.name, p.workspace_id AS "workspaceId", p.user_id AS "userId", p.config,
              p.share_token AS "shareToken", p.created_at AS "createdAt"
       FROM layer_presets p
       WHERE p.user_id = $1
          OR p.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = $1)
       ORDER BY p.created_at DESC LIMIT 100`,
      [req.user!.id],
    );
    return { items: rows };
  });

  app.post('/presets', async (req, reply) => {
    requireAuth(req);
    const body = parseOrThrow(layerPresetSchema, req.body);
    if (body.workspaceId) await workspaceRole(req, body.workspaceId, 'editor');
    const row = await queryOne<{ id: string; share_token: string }>(
      `INSERT INTO layer_presets (name, workspace_id, user_id, config, share_token)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, share_token`,
      [body.name, body.workspaceId ?? null, req.user!.id, JSON.stringify(body.config), randomToken(12)],
    );
    return reply.status(201).send({ id: row!.id, shareToken: row!.share_token });
  });

  /** Public, unauthenticated resolution of a shared preset URL. */
  app.get('/presets/shared/:token', async (req) => {
    const token = String((req.params as { token: string }).token);
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(token)) throw badRequest('Invalid share token');
    const row = await queryOne(
      `SELECT name, config FROM layer_presets WHERE share_token = $1`,
      [token],
    );
    if (!row) throw notFound('Shared preset');
    return row;
  });

  app.delete('/presets/:id', async (req) => {
    requireAuth(req);
    const id = parseOrThrow(uuidSchema, (req.params as { id: string }).id);
    const res = await query(
      `DELETE FROM layer_presets WHERE id = $1 AND (user_id = $2 OR $3 = 'admin')`,
      [id, req.user!.id, req.user!.role],
    );
    if (res.rowCount === 0) throw notFound('Preset');
    return { ok: true };
  });
}
