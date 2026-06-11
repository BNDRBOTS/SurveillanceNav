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
