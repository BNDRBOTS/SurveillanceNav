import { config } from './config.js';

/**
 * Fastify logger options. Structured JSON logs in production (pino default),
 * human-readable single-line logs in development, silent in tests.
 * Redacts credentials and tokens so secrets never reach log sinks.
 */
export const loggerOptions = config.isTest
  ? false
  : {
      level: process.env.LOG_LEVEL ?? (config.isProd ? 'info' : 'info'),
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          '*.password',
          '*.token',
          '*.accessToken',
          '*.refreshToken',
          '*.secret',
        ],
        censor: '[redacted]',
      },
      serializers: {
        req(req: { method: string; url: string; ip: string }) {
          return { method: req.method, url: req.url, ip: req.ip };
        },
      },
    };
