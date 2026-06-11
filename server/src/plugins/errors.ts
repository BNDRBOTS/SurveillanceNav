import type { FastifyInstance, FastifyError } from 'fastify';
import { AppError } from '../lib/errors.js';
import { config } from '../config.js';

/**
 * Consistent error envelope: { error: { code, message, details?, retryAfterSec? } }
 * Internal errors are logged with a correlation id; clients never see stack
 * traces or driver messages.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      if (err.retryAfterSec) reply.header('Retry-After', String(err.retryAfterSec));
      return reply.status(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
          ...(err.retryAfterSec !== undefined ? { retryAfterSec: err.retryAfterSec } : {}),
        },
      });
    }

    const fastifyErr = err as FastifyError;
    // Fastify validation / body parse errors → 400, content-type → 415, body size → 413
    if (fastifyErr.statusCode === 400 || fastifyErr.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.status(fastifyErr.statusCode ?? 400).send({
        error: { code: 'bad_request', message: 'Malformed request — check the request body.' },
      });
    }
    if (fastifyErr.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || fastifyErr.statusCode === 413) {
      return reply.status(413).send({
        error: { code: 'payload_too_large', message: 'Request body exceeds the size limit.' },
      });
    }

    const correlationId = req.id;
    req.log.error({ err, correlationId }, 'unhandled error');
    return reply.status(500).send({
      error: {
        code: 'internal_error',
        message: `Something went wrong on our side. It has been logged (ref ${correlationId}). Please retry.`,
        ...(config.isProd ? {} : { details: { hint: fastifyErr.message } }),
      },
    });
  });

  // The not-found handler is registered once in app.ts (it also serves the
  // SPA fallback when a web build is present).
}
