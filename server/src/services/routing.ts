import {
  bufferSquareRing,
  distanceToPolylineMeters,
  type TechnologyType,
} from '@stn/shared';
import { query } from '../db/pool.js';
import { cachedJson } from '../cache/index.js';
import { config } from '../config.js';

/**
 * Camera-aware routing with a pluggable engine chain:
 *   1. Valhalla  (VALHALLA_URL)  — true hard avoidance via exclude_polygons
 *   2. OpenRouteService (ORS_API_KEY) — avoid_polygons (free key tier)
 *   3. OSRM (OSRM_URL, default public demo) — no exclusion support, so we
 *      request alternatives and pick the lowest camera-exposure one
 *      ("best-effort" avoidance, clearly labeled in the response)
 * Every engine call has a timeout; failures fall through the chain. The
 * fastest (no-avoidance) route is always computed too, so the UI can show
 * "avoids X of Y cameras · +N min" honestly.
 */

export type TravelMode = 'driving' | 'walking' | 'cycling';

export interface RoutePoint {
  lng: number;
  lat: number;
}

export interface RouteStep {
  instruction: string;
  distanceM: number;
  durationS: number;
  lng: number;
  lat: number;
}

export interface ExposedCamera {
  id: string;
  name: string;
  technologyType: TechnologyType;
  lng: number;
  lat: number;
  distanceM: number;
}

export interface ComputedRoute {
  geometry: Array<[number, number]>;
  distanceM: number;
  durationS: number;
  steps: RouteStep[];
  exposure: { count: number; cameras: ExposedCamera[] };
}

export interface RouteResult {
  engine: string;
  avoidance: 'hard' | 'best-effort' | 'off';
  avoidant: ComputedRoute | null;
  fastest: ComputedRoute;
  camerasConsidered: number;
  warnings: string[];
}

const TIMEOUT_MS = 8000;

async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------------- camera corridor ----------------------------- */

interface CorridorCamera {
  id: string;
  name: string;
  technology_type: TechnologyType;
  lng: number;
  lat: number;
}

/** Active (non-retired) assets inside the O/D bounding box, padded ~3km. */
export async function corridorCameras(
  origin: RoutePoint,
  destination: RoutePoint,
  opts: { minConfidence: number; technologyType?: string[] },
): Promise<CorridorCamera[]> {
  const pad = 0.03;
  const minLng = Math.min(origin.lng, destination.lng) - pad;
  const maxLng = Math.max(origin.lng, destination.lng) + pad;
  const minLat = Math.min(origin.lat, destination.lat) - pad;
  const maxLat = Math.max(origin.lat, destination.lat) + pad;
  const params: unknown[] = [minLng, maxLng, minLat, maxLat, opts.minConfidence];
  let techClause = '';
  if (opts.technologyType && opts.technologyType.length > 0) {
    params.push(opts.technologyType);
    techClause = `AND technology_type = ANY($${params.length}::text[])`;
  }
  const { rows } = await query<CorridorCamera>(
    `SELECT id, name, technology_type, lng, lat FROM surveillance_assets
     WHERE deleted_at IS NULL
       AND status NOT IN ('retired','removed')
       AND lng BETWEEN $1 AND $2 AND lat BETWEEN $3 AND $4
       AND confidence_score >= $5
       ${techClause}
     ORDER BY confidence_score DESC
     LIMIT 600`,
    params,
  );
  return rows;
}

export function scoreExposure(
  line: Array<[number, number]>,
  cameras: CorridorCamera[],
  bufferM: number,
): { count: number; cameras: ExposedCamera[] } {
  const exposed: ExposedCamera[] = [];
  for (const cam of cameras) {
    const d = distanceToPolylineMeters(cam.lng, cam.lat, line);
    if (d <= bufferM) {
      exposed.push({
        id: cam.id,
        name: cam.name,
        technologyType: cam.technology_type,
        lng: cam.lng,
        lat: cam.lat,
        distanceM: Math.round(d),
      });
    }
  }
  exposed.sort((a, b) => a.distanceM - b.distanceM);
  return { count: exposed.length, cameras: exposed.slice(0, 100) };
}

/* ------------------------------- engines ------------------------------- */

const VALHALLA_COSTING: Record<TravelMode, string> = {
  driving: 'auto',
  walking: 'pedestrian',
  cycling: 'bicycle',
};

function decodePolyline(encoded: string, precision = 6): Array<[number, number]> {
  // Valhalla uses polyline6
  const factor = 10 ** precision;
  const coords: Array<[number, number]> = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    for (const which of [0, 1] as const) {
      let result = 0, shift = 0, byte = 0x20;
      while (byte >= 0x20) {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      }
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lng += delta;
    }
    coords.push([lng / factor, lat / factor]);
  }
  return coords;
}

async function routeValhalla(
  base: string,
  origin: RoutePoint,
  destination: RoutePoint,
  mode: TravelMode,
  excludeRings: Array<Array<[number, number]>>,
): Promise<Omit<ComputedRoute, 'exposure'>> {
  const body = {
    locations: [
      { lat: origin.lat, lon: origin.lng },
      { lat: destination.lat, lon: destination.lng },
    ],
    costing: VALHALLA_COSTING[mode],
    units: 'kilometers',
    ...(excludeRings.length > 0
      ? { exclude_polygons: excludeRings.map((ring) => ring.map(([lng, lat]) => [lng, lat])) }
      : {}),
  };
  const data = (await fetchJson(`${base.replace(/\/$/, '')}/route`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })) as {
    trip: {
      legs: Array<{ shape: string; maneuvers: Array<{ instruction: string; length: number; time: number; begin_shape_index: number }> }>;
      summary: { length: number; time: number };
    };
  };
  const leg = data.trip.legs[0]!;
  const geometry = decodePolyline(leg.shape, 6);
  return {
    geometry,
    distanceM: Math.round(data.trip.summary.length * 1000),
    durationS: Math.round(data.trip.summary.time),
    steps: leg.maneuvers.map((m) => {
      const at = geometry[Math.min(m.begin_shape_index, geometry.length - 1)] ?? geometry[0]!;
      return {
        instruction: m.instruction,
        distanceM: Math.round(m.length * 1000),
        durationS: Math.round(m.time),
        lng: at[0],
        lat: at[1],
      };
    }),
  };
}

const ORS_PROFILE: Record<TravelMode, string> = {
  driving: 'driving-car',
  walking: 'foot-walking',
  cycling: 'cycling-regular',
};

async function routeOrs(
  apiKey: string,
  origin: RoutePoint,
  destination: RoutePoint,
  mode: TravelMode,
  excludeRings: Array<Array<[number, number]>>,
): Promise<Omit<ComputedRoute, 'exposure'>> {
  const body: Record<string, unknown> = {
    coordinates: [
      [origin.lng, origin.lat],
      [destination.lng, destination.lat],
    ],
    instructions: true,
  };
  if (excludeRings.length > 0) {
    body.options = {
      avoid_polygons: { type: 'MultiPolygon', coordinates: excludeRings.map((ring) => [ring]) },
    };
  }
  const data = (await fetchJson(`https://api.openrouteservice.org/v2/directions/${ORS_PROFILE[mode]}/geojson`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: apiKey },
    body: JSON.stringify(body),
  })) as {
    features: Array<{
      geometry: { coordinates: Array<[number, number]> };
      properties: {
        summary: { distance: number; duration: number };
        segments: Array<{ steps: Array<{ instruction: string; distance: number; duration: number; way_points: [number, number] }> }>;
      };
    }>;
  };
  const f = data.features[0]!;
  const geometry = f.geometry.coordinates;
  return {
    geometry,
    distanceM: Math.round(f.properties.summary.distance),
    durationS: Math.round(f.properties.summary.duration),
    steps: f.properties.segments.flatMap((seg) =>
      seg.steps.map((s) => {
        const at = geometry[Math.min(s.way_points[0], geometry.length - 1)] ?? geometry[0]!;
        return { instruction: s.instruction, distanceM: Math.round(s.distance), durationS: Math.round(s.duration), lng: at[0], lat: at[1] };
      }),
    ),
  };
}

const OSRM_PROFILE: Record<TravelMode, string> = { driving: 'driving', walking: 'walking', cycling: 'cycling' };

interface OsrmRoute {
  geometry: { coordinates: Array<[number, number]> };
  distance: number;
  duration: number;
  legs: Array<{
    steps: Array<{
      maneuver: { type: string; modifier?: string; location: [number, number] };
      name: string;
      distance: number;
      duration: number;
    }>;
  }>;
}

function osrmInstruction(step: OsrmRoute['legs'][0]['steps'][0]): string {
  const { type, modifier } = step.maneuver;
  const road = step.name ? ` onto ${step.name}` : '';
  switch (type) {
    case 'depart': return `Head out${step.name ? ` on ${step.name}` : ''}`;
    case 'arrive': return 'Arrive at your destination';
    case 'turn': return `Turn ${modifier ?? ''}${road}`.trim();
    case 'new name': return `Continue${road}`;
    case 'merge': return `Merge ${modifier ?? ''}${road}`.trim();
    case 'on ramp': return `Take the ramp${road}`;
    case 'off ramp': return `Take the exit${road}`;
    case 'fork': return `Keep ${modifier ?? 'straight'} at the fork${road}`;
    case 'roundabout':
    case 'rotary': return `Take the roundabout${road}`;
    case 'end of road': return `At the end of the road, turn ${modifier ?? ''}${road}`.trim();
    default: return `Continue ${modifier ?? ''}${road}`.trim();
  }
}

async function routeOsrm(
  base: string,
  origin: RoutePoint,
  destination: RoutePoint,
  mode: TravelMode,
  alternatives: boolean,
): Promise<Array<Omit<ComputedRoute, 'exposure'>>> {
  const url = `${base.replace(/\/$/, '')}/route/v1/${OSRM_PROFILE[mode]}/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=geojson&steps=true&alternatives=${alternatives ? '3' : 'false'}`;
  const data = (await fetchJson(url)) as { code: string; routes: OsrmRoute[] };
  if (data.code !== 'Ok' || data.routes.length === 0) throw new Error(`OSRM: ${data.code}`);
  return data.routes.map((r) => ({
    geometry: r.geometry.coordinates,
    distanceM: Math.round(r.distance),
    durationS: Math.round(r.duration),
    steps: r.legs.flatMap((leg) =>
      leg.steps.map((s) => ({
        instruction: osrmInstruction(s),
        distanceM: Math.round(s.distance),
        durationS: Math.round(s.duration),
        lng: s.maneuver.location[0],
        lat: s.maneuver.location[1],
      })),
    ),
  }));
}

const GOOGLE_MODE: Record<TravelMode, string> = { driving: 'driving', walking: 'walking', cycling: 'bicycling' };

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

interface GoogleRoute {
  overview_polyline: { points: string };
  legs: Array<{
    distance: { value: number };
    duration: { value: number };
    steps: Array<{
      html_instructions: string;
      distance: { value: number };
      duration: { value: number };
      start_location: { lat: number; lng: number };
    }>;
  }>;
}

/**
 * Optional, opt-in engine: Google Directions (needs GOOGLE_MAPS_API_KEY). Google
 * has no polygon exclusion, so avoidance is best-effort via alternatives — the
 * default engines keep hard avoidance.
 */
async function routeGoogle(
  apiKey: string,
  origin: RoutePoint,
  destination: RoutePoint,
  mode: TravelMode,
  alternatives: boolean,
): Promise<Array<Omit<ComputedRoute, 'exposure'>>> {
  const url =
    `https://maps.googleapis.com/maps/api/directions/json?origin=${origin.lat},${origin.lng}` +
    `&destination=${destination.lat},${destination.lng}&mode=${GOOGLE_MODE[mode]}` +
    `&alternatives=${alternatives ? 'true' : 'false'}&key=${encodeURIComponent(apiKey)}`;
  const data = (await fetchJson(url)) as { status: string; routes: GoogleRoute[]; error_message?: string };
  if (data.status !== 'OK' || data.routes.length === 0) {
    throw new Error(`Google: ${data.status}${data.error_message ? ` (${data.error_message})` : ''}`);
  }
  return data.routes.map((r) => {
    const geometry = decodePolyline(r.overview_polyline.points, 5); // Google uses polyline5
    const leg = r.legs[0]!;
    return {
      geometry,
      distanceM: leg.distance.value,
      durationS: leg.duration.value,
      steps: leg.steps.map((s) => ({
        instruction: stripHtml(s.html_instructions),
        distanceM: s.distance.value,
        durationS: s.duration.value,
        lng: s.start_location.lng,
        lat: s.start_location.lat,
      })),
    };
  });
}

/** Whether the optional Google Directions engine is configured. */
export function googleRoutingAvailable(): boolean {
  return Boolean(config.routing.googleApiKey);
}

/* ------------------------------ orchestrator ------------------------------ */

export function activeEngine(): { name: string; hardAvoidance: boolean } {
  if (config.routing.valhallaUrl) return { name: 'valhalla', hardAvoidance: true };
  if (config.routing.orsApiKey) return { name: 'openrouteservice', hardAvoidance: true };
  if (config.routing.osrmUrl) {
    const isPublicDemo = config.routing.osrmUrl.includes('router.project-osrm.org');
    return { name: isPublicDemo ? 'osrm-public' : 'osrm', hardAvoidance: false };
  }
  return { name: 'none', hardAvoidance: false };
}

export async function computeRoute(
  origin: RoutePoint,
  destination: RoutePoint,
  mode: TravelMode,
  avoid: { enabled: boolean; minConfidence: number; bufferMeters: number; technologyType?: string[] },
  preferGoogle = false,
): Promise<RouteResult> {
  const warnings: string[] = [];
  const cameras = avoid.enabled
    ? await corridorCameras(origin, destination, { minConfidence: avoid.minConfidence, technologyType: avoid.technologyType })
    : [];
  if (cameras.length === 600) warnings.push('Dense area: avoidance considered the 600 highest-confidence cameras in the corridor.');

  // Exclusion polygons: cap for engine limits, highest-confidence first.
  const rings = cameras.slice(0, 150).map((c) => bufferSquareRing(c.lng, c.lat, avoid.bufferMeters));
  if (avoid.enabled && cameras.length > 150) {
    warnings.push(`Hard avoidance applied to the 150 highest-confidence cameras; all ${cameras.length} are scored for exposure.`);
  }

  const finish = (
    engine: string,
    avoidance: RouteResult['avoidance'],
    fastestRaw: Omit<ComputedRoute, 'exposure'>,
    avoidantRaw: Omit<ComputedRoute, 'exposure'> | null,
  ): RouteResult => ({
    engine,
    avoidance,
    fastest: { ...fastestRaw, exposure: scoreExposure(fastestRaw.geometry, cameras, avoid.bufferMeters) },
    avoidant: avoidantRaw
      ? { ...avoidantRaw, exposure: scoreExposure(avoidantRaw.geometry, cameras, avoid.bufferMeters) }
      : null,
    camerasConsidered: cameras.length,
    warnings,
  });

  // 0 · Google Directions (opt-in; best-effort avoidance via alternatives)
  if (preferGoogle && config.routing.googleApiKey) {
    try {
      const routes = await routeGoogle(config.routing.googleApiKey, origin, destination, mode, avoid.enabled);
      const fastest = routes[0]!;
      if (!avoid.enabled || routes.length === 1) {
        if (avoid.enabled) {
          warnings.push('Google route shown with camera exposure marked; use the default engine for guaranteed hard avoidance.');
        }
        return finish('google', avoid.enabled ? 'best-effort' : 'off', fastest, null);
      }
      const scored = routes.map((r) => ({ r, exp: scoreExposure(r.geometry, cameras, avoid.bufferMeters).count }));
      scored.sort((a, b) => a.exp - b.exp || a.r.durationS - b.r.durationS);
      const best = scored[0]!.r;
      warnings.push('Google route: best-effort avoidance (lowest-exposure alternative). The default engine offers guaranteed hard avoidance.');
      return finish('google', 'best-effort', fastest, best === fastest ? null : best);
    } catch (err) {
      warnings.push(`Google routing failed (${(err as Error).message.slice(0, 80)}); using the default engine.`);
    }
  }

  // 1 · Valhalla
  if (config.routing.valhallaUrl) {
    try {
      const fastest = await routeValhalla(config.routing.valhallaUrl, origin, destination, mode, []);
      if (!avoid.enabled) return finish('valhalla', 'off', fastest, null);
      try {
        const avoidant = await routeValhalla(config.routing.valhallaUrl, origin, destination, mode, rings);
        return finish('valhalla', 'hard', fastest, avoidant);
      } catch (err) {
        warnings.push(`Avoidance routing failed (${(err as Error).message.slice(0, 80)}); showing fastest route with exposure marked.`);
        return finish('valhalla', 'off', fastest, null);
      }
    } catch {
      warnings.push('Valhalla unreachable — trying the next engine.');
    }
  }

  // 2 · OpenRouteService
  if (config.routing.orsApiKey) {
    try {
      const fastest = await routeOrs(config.routing.orsApiKey, origin, destination, mode, []);
      if (!avoid.enabled) return finish('openrouteservice', 'off', fastest, null);
      try {
        // ORS area limits: cap polygons harder.
        const avoidant = await routeOrs(config.routing.orsApiKey, origin, destination, mode, rings.slice(0, 80));
        return finish('openrouteservice', 'hard', fastest, avoidant);
      } catch (err) {
        warnings.push(`Avoidance routing failed (${(err as Error).message.slice(0, 80)}); showing fastest route with exposure marked.`);
        return finish('openrouteservice', 'off', fastest, null);
      }
    } catch {
      warnings.push('OpenRouteService unreachable — trying the next engine.');
    }
  }

  // 3 · OSRM (best-effort: pick lowest-exposure alternative)
  if (config.routing.osrmUrl) {
    const routes = await routeOsrm(config.routing.osrmUrl, origin, destination, mode, avoid.enabled);
    const fastest = routes[0]!;
    if (!avoid.enabled || routes.length === 1) {
      if (avoid.enabled) {
        warnings.push('This routing engine cannot hard-exclude areas and returned no alternatives — exposure is marked on the fastest route. Configure Valhalla or OpenRouteService for guaranteed avoidance.');
      }
      return finish(activeEngine().name, avoid.enabled ? 'best-effort' : 'off', fastest, null);
    }
    const scored = routes.map((r) => ({ r, exp: scoreExposure(r.geometry, cameras, avoid.bufferMeters).count }));
    scored.sort((a, b) => a.exp - b.exp || a.r.durationS - b.r.durationS);
    const best = scored[0]!.r;
    warnings.push('Best-effort avoidance: picked the lowest-exposure alternative. Configure Valhalla or OpenRouteService for hard avoidance.');
    return finish(activeEngine().name, 'best-effort', fastest, best === fastest ? null : best);
  }

  throw new Error('No routing engine configured');
}

/* ------------------------------- geocoding ------------------------------- */

export interface GeocodeHit {
  label: string;
  lng: number;
  lat: number;
  type: string;
}

export async function geocode(q: string): Promise<GeocodeHit[]> {
  const key = `geocode:${q.toLowerCase()}`;
  return cachedJson(key, 600, async () => {
    const url = `${config.routing.nominatimUrl.replace(/\/$/, '')}/search?format=jsonv2&limit=6&addressdetails=0&q=${encodeURIComponent(q)}${config.routing.nominatimEmail ? `&email=${encodeURIComponent(config.routing.nominatimEmail)}` : ''}`;
    const data = (await fetchJson(url, {
      headers: { 'user-agent': `LensOfLight-STN/1.0 (${config.publicUrl})` },
    })) as Array<{ display_name: string; lon: string; lat: string; type: string }>;
    return data.map((d) => ({
      label: d.display_name,
      lng: Number(d.lon),
      lat: Number(d.lat),
      type: d.type,
    }));
  });
}

export async function reverseGeocode(lng: number, lat: number): Promise<string> {
  const key = `revgeo:${lng.toFixed(4)},${lat.toFixed(4)}`;
  return cachedJson(key, 3600, async () => {
    const url = `${config.routing.nominatimUrl.replace(/\/$/, '')}/reverse?format=jsonv2&lon=${lng}&lat=${lat}${config.routing.nominatimEmail ? `&email=${encodeURIComponent(config.routing.nominatimEmail)}` : ''}`;
    const data = (await fetchJson(url, {
      headers: { 'user-agent': `LensOfLight-STN/1.0 (${config.publicUrl})` },
    })) as { display_name?: string };
    return data.display_name ?? `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  });
}
