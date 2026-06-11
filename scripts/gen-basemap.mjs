/**
 * Generates the bundled offline basemap (web/src/data/us-states.json) from
 * the us-atlas Census TopoJSON. Coordinates are rounded to 2 decimal places
 * (~1.1 km) — ample for the national/regional zooms the vector basemap
 * serves; street-level context comes from the optional OSM raster layer.
 *
 * Run: node scripts/gen-basemap.mjs   (re-run only when us-atlas updates)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..', 'web');
const require = (await import('node:module')).createRequire(pathToFileURL(path.join(webDir, 'package.json')));

const topojson = require('topojson-client');
const topoPath = require.resolve('us-atlas/states-10m.json');
const topo = JSON.parse(fs.readFileSync(topoPath, 'utf8'));

const geo = topojson.feature(topo, topo.objects.states);

function round(coords) {
  if (typeof coords[0] === 'number') {
    return [Math.round(coords[0] * 100) / 100, Math.round(coords[1] * 100) / 100];
  }
  return coords.map(round);
}

let dropped = 0;
const features = geo.features
  .map((f) => {
    if (!f.geometry) {
      dropped += 1;
      return null;
    }
    return {
      type: 'Feature',
      properties: { name: f.properties?.name ?? 'Unknown' },
      geometry: { type: f.geometry.type, coordinates: round(f.geometry.coordinates) },
    };
  })
  .filter(Boolean);

const out = { type: 'FeatureCollection', features };
const outPath = path.join(webDir, 'src', 'data', 'us-states.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out));
const kb = Math.round(fs.statSync(outPath).size / 1024);
console.log(`basemap: ${features.length} state features → ${outPath} (${kb} KB, dropped ${dropped})`);
