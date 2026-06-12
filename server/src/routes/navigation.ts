import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { latitude, longitude, safeString } from '@stn/shared';
import { parseOrThrow } from '../lib/validation.js';
import { badRequest, serviceUnavailable } from '../lib/errors.js';
import { computeRoute, geocode, reverseGeocode, activeEngine, type TravelMode } from '../services/routing.js';
import { cachedJson } from '../cache/index.js';

const routeBody = z.object({
  origin: z.object({ lng: longitude, lat: latitude }),
  destination: z.object({ lng: longitude, lat: latitude }),
  mode: z.enum(['driving', 'walking', 'cycling']).default('driving'),
  avoid: z
    .object({
      enabled: z.boolean().default(true),
      minConfidence: z.coerce.number().int().min(0).max(100).default(30),
      bufferMeters: z.coerce.number().min(20).max(500).default(120),
      technologyType: z.array(safeString(40)).max(12).optional(),
    })
    .default({}),
});

export function registerNavigationRoutes(app: FastifyInstance): void {
  /** Address/place search (server-proxied Nominatim, cached, CSP-friendly). */
  app.get('/geo/search', async (req) => {
    const q = String((req.query as { q?: string }).q ?? '').trim();
    if (q.length < 3) return { items: [] };
    if (q.length > 200) throw badRequest('Search query too long');
    try {
      return { items: await geocode(q) };
    } catch {
      throw serviceUnavailable('Address search is temporarily unavailable — you can paste coordinates (lat, lng) instead.');
    }
  });

  app.get('/geo/reverse', async (req) => {
    const qp = req.query as { lng?: string; lat?: string };
    const lng = Number(qp.lng);
    const lat = Number(qp.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw badRequest('Provide valid lng/lat');
    }
    try {
      return { label: await reverseGeocode(lng, lat) };
    } catch {
      return { label: `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
    }
  });

  /**
   * Camera-aware routing. Public (the core civic function stays free);
   * rate-limited like the rest of the API; results cached briefly.
   */
  app.post('/navigation/route', async (req) => {
    const body = parseOrThrow(routeBody, req.body);
    const { origin, destination } = body;
    const sameSpot =
      Math.abs(origin.lng - destination.lng) < 1e-5 && Math.abs(origin.lat - destination.lat) < 1e-5;
    if (sameSpot) throw badRequest('Origin and destination are the same place.');
    const crow =
      Math.abs(origin.lng - destination.lng) + Math.abs(origin.lat - destination.lat);
    if (crow > 6) {
      throw badRequest('Routes are limited to regional trips (~500 km). Break longer journeys into segments.');
    }
    if (activeEngine().name === 'none') {
      throw serviceUnavailable('No routing engine is configured. Set VALHALLA_URL, ORS_API_KEY, or OSRM_URL.');
    }

    const cacheKey = `route:${activeEngine().name}:${JSON.stringify(body)}`;
    try {
      return await cachedJson(cacheKey, 60, () =>
        computeRoute(origin, destination, body.mode as TravelMode, body.avoid),
      );
    } catch (err) {
      req.log.warn({ err }, 'routing failed');
      throw serviceUnavailable('Routing is temporarily unavailable — all engines unreachable. Try again shortly.');
    }
  });
}
