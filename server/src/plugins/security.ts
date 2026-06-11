import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

/**
 * Security headers on every response. CSP allows self plus the optional
 * raster tile hosts (OSM) used by the online basemap layer; everything else
 * is locked down. The SPA is served same-origin so no third-party script,
 * style, or frame sources are ever required.
 */

const TILE_HOSTS =
  'https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://server.arcgisonline.com';

const CSP = [
  `default-src 'self'`,
  `script-src 'self'`,
  `style-src 'self' 'unsafe-inline'`, // MapLibre injects inline styles for canvas containers
  `img-src 'self' data: blob: ${TILE_HOSTS}`,
  `connect-src 'self' ${TILE_HOSTS}`,
  `worker-src 'self' blob:`,
  `font-src 'self'`,
  `object-src 'none'`,
  `base-uri 'self'`,
  `form-action 'self'`,
  `frame-ancestors 'none'`,
  `manifest-src 'self'`,
].join('; ');

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header(
      'Permissions-Policy',
      'geolocation=(self), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()',
    );
    reply.header('Content-Security-Policy', CSP);
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    if (config.cookieSecure) {
      reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    }
    if (req.url.startsWith('/api/')) {
      reply.header('Cache-Control', reply.getHeader('Cache-Control') ?? 'no-store');
    }
  });
}
