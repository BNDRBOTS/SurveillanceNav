/** Geospatial helpers shared by server fallbacks and the web client. */

const EARTH_RADIUS_M = 6_371_008.8;

export function haversineMeters(aLng: number, aLat: number, bLng: number, bLat: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const sa =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(sa)));
}

/** Expand a point into a bbox of `radius` meters (clamped to valid ranges). */
export function pointToBbox(lng: number, lat: number, radiusMeters: number) {
  const dLat = (radiusMeters / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLng = dLat / Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  return {
    minLng: Math.max(-180, lng - dLng),
    minLat: Math.max(-90, lat - dLat),
    maxLng: Math.min(180, lng + dLng),
    maxLat: Math.min(90, lat + dLat),
  };
}

/** Parse "lat, lng" or "lng, lat" pasted coordinates; returns null on garbage. */
export function parseCoordinates(raw: string): { lng: number; lat: number } | null {
  const cleaned = raw.replace(/[\u200B-\u200D\uFEFF\u2060]/g, "").trim();
  const m = cleaned.match(/^(-?\d{1,3}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  // Prefer lat,lng interpretation (common copy/paste from map apps).
  if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lng: b };
  if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return { lat: b, lng: a };
  return null;
}

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  const mi = meters / 1609.344;
  return `${km.toFixed(1)} km (${mi.toFixed(1)} mi)`;
}

/* ------------------------- navigation geometry ------------------------- */

/** Meters from a point to a segment (equirectangular approx — fine ≤ ~50km). */
export function distanceToSegmentMeters(
  pLng: number, pLat: number,
  aLng: number, aLat: number,
  bLng: number, bLat: number,
): number {
  const kx = Math.cos((((aLat + bLat) / 2) * Math.PI) / 180) * 111_320;
  const ky = 110_574;
  const ax = aLng * kx, ay = aLat * ky;
  const bx = bLng * kx, by = bLat * ky;
  const px = pLng * kx, py = pLat * ky;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Minimum distance (m) from a point to a polyline of [lng,lat] coords. */
export function distanceToPolylineMeters(lng: number, lat: number, line: Array<[number, number]>): number {
  let min = Infinity;
  for (let i = 0; i < line.length - 1; i += 1) {
    const a = line[i]!, b = line[i + 1]!;
    const d = distanceToSegmentMeters(lng, lat, a[0], a[1], b[0], b[1]);
    if (d < min) min = d;
  }
  return min;
}

/** Square buffer ring around a point (closed, counter-clockwise [lng,lat]). */
export function bufferSquareRing(lng: number, lat: number, meters: number): Array<[number, number]> {
  const dLat = meters / 110_574;
  const dLng = meters / (111_320 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  return [
    [lng - dLng, lat - dLat],
    [lng + dLng, lat - dLat],
    [lng + dLng, lat + dLat],
    [lng - dLng, lat + dLat],
    [lng - dLng, lat - dLat],
  ];
}

/** Evenly sample up to n intermediate via-points from a route line (excludes endpoints). */
export function sampleWaypoints(line: Array<[number, number]>, n: number): Array<[number, number]> {
  if (line.length < 3 || n <= 0) return [];
  const out: Array<[number, number]> = [];
  for (let i = 1; i <= n; i += 1) {
    const idx = Math.round((i * (line.length - 1)) / (n + 1));
    if (idx > 0 && idx < line.length - 1) out.push(line[idx]!);
  }
  return out;
}

/** Google Maps directions deep link pinned through our avoidance via-points (≤8). */
export function googleMapsDirectionsUrl(
  origin: { lng: number; lat: number },
  destination: { lng: number; lat: number },
  line: Array<[number, number]>,
  mode: 'driving' | 'walking' | 'bicycling' = 'driving',
): string {
  const way = sampleWaypoints(line, 8)
    .map(([lng, lat]) => `${lat.toFixed(5)},${lng.toFixed(5)}`)
    .join('|');
  const params = new URLSearchParams({
    api: '1',
    origin: `${origin.lat.toFixed(6)},${origin.lng.toFixed(6)}`,
    destination: `${destination.lat.toFixed(6)},${destination.lng.toFixed(6)}`,
    travelmode: mode,
  });
  if (way) params.set('waypoints', way);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

export function appleMapsDirectionsUrl(
  origin: { lng: number; lat: number },
  destination: { lng: number; lat: number },
  mode: 'driving' | 'walking' | 'bicycling' = 'driving',
): string {
  const flag = mode === 'walking' ? 'w' : 'd';
  return `https://maps.apple.com/?saddr=${origin.lat},${origin.lng}&daddr=${destination.lat},${destination.lng}&dirflg=${flag}`;
}
