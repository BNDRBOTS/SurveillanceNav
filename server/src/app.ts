import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { loggerOptions } from './logger.js';
import { registerErrorHandling } from './plugins/errors.js';
import { registerSecurityHeaders } from './plugins/security.js';
import { registerAuth } from './plugins/auth.js';
import { registerRateLimit } from './plugins/rateLimit.js';
import { registerMetrics } from './plugins/metrics.js';
import { registerIdempotency } from './plugins/idempotency.js';
import { assertSaneJsonDepth } from './lib/validation.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerUserRoutes } from './routes/users.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerAssetRoutes } from './routes/assets.js';
import { registerFoiaRoutes } from './routes/foia.js';
import { registerProcurementRoutes } from './routes/procurement.js';
import { registerPolicyRoutes } from './routes/policies.js';
import { registerReferenceRoutes } from './routes/reference.js';
import { registerExportRoutes } from './routes/exports.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerFeedbackRoutes } from './routes/feedback.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerNavigationRoutes } from './routes/navigation.js';
import { registerBillingRoutes } from './routes/billing.js';
import { openapiDocument, renderDocsHtml } from './openapi.js';
import { API_PREFIX } from '@stn/shared';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
    bodyLimit: 1024 * 1024, // JSON bodies ≤ 1MB; uploads go through multipart
    trustProxy: config.trustProxy,
    disableRequestLogging: !config.isProd,
  });

  await app.register(fastifyCookie);
  await app.register(fastifyCors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });
  await app.register(fastifyMultipart, {
    limits: { fileSize: config.uploads.maxBytes, files: 1, fields: 10 },
    throwFileSizeLimit: true,
  });

  registerErrorHandling(app);
  registerSecurityHeaders(app);
  registerAuth(app);
  registerRateLimit(app);
  registerMetrics(app);

  // JSON-bomb guard before any handler logic touches the body.
  app.addHook('preValidation', async (req) => {
    if (req.body && typeof req.body === 'object') assertSaneJsonDepth(req.body);
  });

  await app.register(
    async (api) => {
      registerIdempotency(api);
      registerAuthRoutes(api);
      registerUserRoutes(api);
      registerWorkspaceRoutes(api);
      registerAssetRoutes(api);
      registerFoiaRoutes(api);
      registerProcurementRoutes(api);
      registerPolicyRoutes(api);
      registerReferenceRoutes(api);
      registerExportRoutes(api);
      registerAdminRoutes(api);
      registerNavigationRoutes(api);
      registerBillingRoutes(api);
      registerFeedbackRoutes(api);
      registerHealthRoutes(api);
      api.get('/openapi.json', async () => openapiDocument);
    },
    { prefix: API_PREFIX },
  );

  // Spec-literal health paths (also under /api/v1 via the block above).
  registerHealthRoutes(app);

  // Human-readable, no-JS API reference (renders the OpenAPI spec). Works under
  // the strict app CSP (inline styles only, no scripts) — no relaxation needed.
  app.get('/docs', async (_req, reply) => reply.type('text/html').send(renderDocsHtml()));

  // Serve the built SPA same-origin (production / integrated dev).
  const dist = config.webDistDir;
  const hasWebBuild = fs.existsSync(path.join(dist, 'index.html'));
  if (hasWebBuild) {
    await app.register(fastifyStatic, {
      root: dist,
      wildcard: false,
      maxAge: '1h',
      immutable: false,
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (filePath.endsWith('sw.js') || filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    });
  }

  // Single not-found handler: SPA fallback for app routes, JSON envelope otherwise.
  app.setNotFoundHandler((req, reply) => {
    // Decide on the pathname alone — query strings routinely contain dots
    // (shared map links look like /map?lng=-122.41&lat=37.78) and must not
    // knock a client route back to the JSON 404.
    const pathname = req.url.split('?')[0]!;
    if (hasWebBuild && !pathname.startsWith('/api/') && req.method === 'GET' && !pathname.includes('.')) {
      return reply.type('text/html').send(fs.readFileSync(path.join(dist, 'index.html')));
    }
    return reply.status(404).send({
      error: { code: 'not_found', message: `No route ${req.method} ${req.url.split('?')[0]}` },
    });
  });

  return app;
}
