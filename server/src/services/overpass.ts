import pg from 'pg';
import { computeConfidence, type TechnologyType } from '@stn/shared';

/**
 * De-Flock / OpenStreetMap importer.
 *
 * Fetches community-mapped surveillance nodes (`man_made=surveillance` — mostly
 * ALPRs and cameras) from the Overpass API for a bounding box and upserts them
 * into `surveillance_assets`, idempotently keyed by `external_ref`
 * ("osm:node/<id>"). Imported assets are marked `unverified`, attributed to the
 * De-Flock / OpenStreetMap source, and scored low by the confidence engine
 * until corroborated: the map "starts bare and fills in" from real community
 * data as people browse, then the community audits it via the normal
 * dispute/flag flow.
 *
 * Server-side only — the server proxies Overpass (mirroring the routing /
 * geocoding services), so the browser CSP stays tight.
 *
 * Data © OpenStreetMap contributors / De-Flock, ODbL.
 */

const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const USER_AGENT =
  process.env.OVERPASS_USER_AGENT ||
  'LensOfLight/1.0 (surveillance-transparency; contact via app)';
const TIMEOUT_MS = 30_000;
const MAX_NODES = 5000;

const SOURCE_NAME = 'De-Flock / OpenStreetMap';

export interface Bbox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export interface OsmSurveillanceNode {
  osmId: number;
  lng: number;
  lat: number;
  technology: TechnologyType;
  vendor: string | null;
  name: string;
  tags: Record<string, string>;
}

export interface ImportResult {
  fetched: number;
  upserted: number;
}

/** Map OSM surveillance tags → our technology_type enum (heuristic, tag-tolerant). */
export function mapTechnology(tags: Record<string, string>): TechnologyType {
  const hay = Object.values(tags).join(' ').toLowerCase();
  const sType = (tags['surveillance:type'] ?? '').toLowerCase();
  const cType = (tags['camera:type'] ?? '').toLowerCase();
  if (sType === 'alpr' || /\b(alpr|anpr|lpr|licen[sc]e plate|number plate)\b/.test(hay)) return 'lpr';
  if (sType === 'gunshot_detector' || /gunshot|shotspotter|soundthinking/.test(hay)) return 'gunshot_detection';
  if (/facial recognition|face recognition/.test(hay)) return 'facial_recognition';
  if (sType === 'camera' || cType !== '' || tags['surveillance'] !== undefined || tags['man_made'] === 'surveillance') {
    return 'cctv';
  }
  return 'other';
}

function vendorFrom(tags: Record<string, string>): string | null {
  const v = tags['manufacturer'] || tags['brand'] || tags['operator'] || '';
  return v ? v.slice(0, 120) : null;
}

/** Parse a raw Overpass JSON response into normalized surveillance nodes. */
export function parseOverpassNodes(json: unknown): OsmSurveillanceNode[] {
  const elements = (json as { elements?: unknown[] } | null)?.elements;
  if (!Array.isArray(elements)) return [];
  const out: OsmSurveillanceNode[] = [];
  for (const el of elements) {
    const e = el as { type?: string; id?: number; lat?: number; lon?: number; tags?: Record<string, string> };
    if (e.type !== 'node' || typeof e.id !== 'number' || typeof e.lat !== 'number' || typeof e.lon !== 'number') continue;
    if (e.lat < -90 || e.lat > 90 || e.lon < -180 || e.lon > 180) continue;
    const tags = e.tags ?? {};
    const technology = mapTechnology(tags);
    const name =
      (tags['name'] ?? '').slice(0, 200) ||
      (technology === 'lpr' ? 'ALPR camera' : technology === 'cctv' ? 'Surveillance camera' : 'Surveillance device');
    out.push({ osmId: e.id, lng: e.lon, lat: e.lat, technology, vendor: vendorFrom(tags), name, tags });
  }
  return out;
}

/** Fetch surveillance nodes in a bounding box from the Overpass API (server-side). */
export async function fetchOverpassNodes(bbox: Bbox): Promise<OsmSurveillanceNode[]> {
  const { minLat, minLng, maxLat, maxLng } = bbox;
  // Overpass bbox order is south,west,north,east.
  const q = `[out:json][timeout:25];node["man_made"="surveillance"](${minLat},${minLng},${maxLat},${maxLng});out body ${MAX_NODES};`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: `data=${encodeURIComponent(q)}`,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Overpass ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return parseOverpassNodes(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

/** Ensure the De-Flock / OpenStreetMap source row exists; returns its id. */
export async function ensureOsmSource(client: pg.ClientBase): Promise<string> {
  const { rows } = await client.query(
    `INSERT INTO sources (name, type, url, verification_status)
     VALUES ($1, 'community', 'https://deflock.me', 'unverified')
     ON CONFLICT (lower(name)) DO UPDATE SET url = EXCLUDED.url
     RETURNING id`,
    [SOURCE_NAME],
  );
  return (rows[0] as { id: string }).id;
}

/** Upsert normalized OSM nodes into surveillance_assets, idempotent by external_ref. */
export async function importOsmNodes(
  client: pg.ClientBase,
  nodes: OsmSurveillanceNode[],
  sourceId: string,
): Promise<number> {
  if (nodes.length === 0) return 0;
  // Imported, community-sourced, unverified → the confidence engine scores it low
  // until field verification or corroboration arrives.
  const { score, factors } = computeConfidence({
    sourceType: 'community',
    sourceVerification: 'unverified',
    evidenceCount: 0,
    lastVerifiedAt: null,
    openDisputes: 0,
    acceptedDisputes: 0,
    corroboratingSources: 1,
  });
  let upserted = 0;
  for (const n of nodes) {
    const externalRef = `osm:node/${n.osmId}`;
    const properties = { imported: true, importedFrom: 'deflock-osm', osmId: n.osmId, osmTags: n.tags };
    const { rowCount } = await client.query(
      `INSERT INTO surveillance_assets
         (name, source_id, technology_type, vendor, status, confidence_score, confidence_factors,
          lng, lat, properties, external_ref)
       VALUES ($1, $2, $3, $4, 'unverified', $5, $6::jsonb, $7, $8, $9::jsonb, $10)
       ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL
       DO UPDATE SET lng = EXCLUDED.lng, lat = EXCLUDED.lat, vendor = EXCLUDED.vendor,
                     technology_type = EXCLUDED.technology_type, properties = EXCLUDED.properties,
                     updated_at = now()
       WHERE surveillance_assets.deleted_at IS NULL`,
      [n.name, sourceId, n.technology, n.vendor, score, JSON.stringify(factors),
       n.lng, n.lat, JSON.stringify(properties), externalRef],
    );
    upserted += rowCount ?? 0;
  }
  return upserted;
}

/** Fetch a bbox from Overpass and import it. Returns counts. */
export async function importRegion(client: pg.ClientBase, bbox: Bbox): Promise<ImportResult> {
  const nodes = await fetchOverpassNodes(bbox);
  const sourceId = await ensureOsmSource(client);
  const upserted = await importOsmNodes(client, nodes, sourceId);
  return { fetched: nodes.length, upserted };
}
