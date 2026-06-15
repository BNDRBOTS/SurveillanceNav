import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { config } from '../src/config.js';
import { mapTechnology, parseOverpassNodes, ensureOsmSource, importOsmNodes, maybeEnqueueImport } from '../src/services/overpass.js';

const SAMPLE = {
  elements: [
    { type: 'node', id: 1, lat: 37.77, lon: -122.41, tags: { man_made: 'surveillance', 'surveillance:type': 'ALPR', manufacturer: 'Flock Safety' } },
    { type: 'node', id: 2, lat: 37.78, lon: -122.42, tags: { man_made: 'surveillance', 'surveillance:type': 'camera', 'camera:type': 'fixed' } },
    { type: 'node', id: 3, lat: 999, lon: 0, tags: { man_made: 'surveillance' } }, // out-of-range → dropped
    { type: 'way', id: 4, tags: { man_made: 'surveillance' } }, // not a node → dropped
  ],
};

describe('deflock / overpass importer', () => {
  it('maps OSM surveillance tags to technology types', () => {
    expect(mapTechnology({ 'surveillance:type': 'ALPR' })).toBe('lpr');
    expect(mapTechnology({ name: 'Flock ALPR reader' })).toBe('lpr');
    expect(mapTechnology({ 'surveillance:type': 'camera', 'camera:type': 'dome' })).toBe('cctv');
    expect(mapTechnology({ 'surveillance:type': 'gunshot_detector' })).toBe('gunshot_detection');
    expect(mapTechnology({ man_made: 'surveillance' })).toBe('cctv');
  });

  it('parses Overpass JSON, dropping non-nodes and out-of-range coords', () => {
    const nodes = parseOverpassNodes(SAMPLE);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ osmId: 1, technology: 'lpr', vendor: 'Flock Safety', name: 'ALPR camera' });
    expect(nodes[1]).toMatchObject({ osmId: 2, technology: 'cctv', name: 'Surveillance camera' });
    expect(parseOverpassNodes(null)).toEqual([]);
    expect(parseOverpassNodes({})).toEqual([]);
  });

  it('imports nodes idempotently — re-import upserts in place, never duplicates', async () => {
    const client = new pg.Client({ connectionString: config.databaseUrl });
    await client.connect();
    try {
      await client.query(`DELETE FROM surveillance_assets WHERE external_ref LIKE 'osm:node/%'`);
      const nodes = parseOverpassNodes(SAMPLE);
      const sourceId = await ensureOsmSource(client);

      await importOsmNodes(client, nodes, sourceId);
      const first = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM surveillance_assets WHERE external_ref LIKE 'osm:node/%'`,
      );
      expect(first.rows[0]!.n).toBe(2);

      await importOsmNodes(client, nodes, sourceId); // re-import the same nodes
      const second = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM surveillance_assets WHERE external_ref LIKE 'osm:node/%'`,
      );
      expect(second.rows[0]!.n).toBe(2); // idempotent — no duplicates

      const asset = await client.query<{ status: string; confidence_score: number; technology_type: string }>(
        `SELECT status, confidence_score, technology_type FROM surveillance_assets WHERE external_ref = 'osm:node/1'`,
      );
      expect(asset.rows[0]!.status).toBe('unverified');
      expect(asset.rows[0]!.technology_type).toBe('lpr');
      expect(asset.rows[0]!.confidence_score).toBeLessThan(60);
    } finally {
      await client.query(`DELETE FROM surveillance_assets WHERE external_ref LIKE 'osm:node/%'`).catch(() => undefined);
      await client.end();
    }
  });

  it('viewport trigger enqueues one import per tile, throttled by cooldown and zoom', async () => {
    const client = new pg.Client({ connectionString: config.databaseUrl });
    await client.connect();
    const bbox = { minLng: -122.45, minLat: 37.75, maxLng: -122.4, maxLat: 37.8 };
    const countJobs = async () =>
      (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE type = 'import_region'`)).rows[0]!.n;
    try {
      await client.query(`DELETE FROM jobs WHERE type = 'import_region'`);
      await client.query(`DELETE FROM import_tiles`);

      await maybeEnqueueImport(bbox, 13);
      expect(await countJobs()).toBe(1); // first view of the tile → one import enqueued

      await maybeEnqueueImport(bbox, 13);
      expect(await countJobs()).toBe(1); // same tile within cooldown → throttled, no new job

      await maybeEnqueueImport(bbox, 5);
      expect(await countJobs()).toBe(1); // too zoomed out → skipped
    } finally {
      await client.query(`DELETE FROM jobs WHERE type = 'import_region'`).catch(() => undefined);
      await client.query(`DELETE FROM import_tiles`).catch(() => undefined);
      await client.end();
    }
  });
});
