import { randomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

function env(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${key}`);
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`Environment variable ${key} must be an integer`);
  return n;
}

const NODE_ENV = env('NODE_ENV', 'development') as 'development' | 'test' | 'production';
const isProd = NODE_ENV === 'production';

/**
 * Secrets: in production they MUST be provided. In dev/test we generate
 * ephemeral secrets per boot (and persist dev secrets to var/ so refresh
 * tokens survive restarts during local development).
 */
function devSecret(name: string): string {
  if (isProd) throw new Error(`${name} must be set in production`);
  const dir = path.join(process.cwd(), 'var');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `.${name.toLowerCase()}`);
  if (NODE_ENV === 'development' && fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const secret = randomBytes(48).toString('base64url');
  if (NODE_ENV === 'development') fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

const routingConfig = {
  valhallaUrl: process.env.VALHALLA_URL ?? '',
  orsApiKey: process.env.ORS_API_KEY ?? '',
  osrmUrl: process.env.OSRM_URL ?? 'https://router.project-osrm.org',
  googleApiKey: process.env.GOOGLE_MAPS_API_KEY ?? '',
  nominatimUrl: process.env.NOMINATIM_URL ?? 'https://nominatim.openstreetmap.org',
  nominatimEmail: process.env.NOMINATIM_EMAIL ?? '',
};

const stripeConfig = {
  secretKey: process.env.STRIPE_SECRET_KEY ?? '',
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  priceIdPro: process.env.STRIPE_PRICE_ID_PRO ?? '',
  get configured(): boolean {
    return Boolean(this.secretKey && this.priceIdPro);
  },
};

export const config = {
  nodeEnv: NODE_ENV,
  routing: routingConfig,
  stripe: stripeConfig,
  isProd,
  isTest: NODE_ENV === 'test',
  host: env('HOST', '0.0.0.0'),
  port: envInt('PORT', 4000),
  publicUrl: env('PUBLIC_URL', `http://localhost:${envInt('PORT', 4000)}`),
  trustProxy: env('TRUST_PROXY', isProd ? 'true' : 'false') === 'true',

  databaseUrl: env(
    'DATABASE_URL',
    isProd ? undefined : 'postgres://stn:stn_dev_password@localhost:5432/stn',
  ),
  dbPoolMax: envInt('DB_POOL_MAX', 10),

  redisUrl: process.env.REDIS_URL ?? (isProd ? '' : 'redis://localhost:6379'),

  jwtSecret: process.env.JWT_SECRET || devSecret('JWT_SECRET'),
  refreshSecret: process.env.REFRESH_SECRET || devSecret('REFRESH_SECRET'),
  downloadSecret: process.env.DOWNLOAD_SECRET || devSecret('DOWNLOAD_SECRET'),

  accessTokenTtlSec: envInt('ACCESS_TOKEN_TTL_SEC', 15 * 60),
  refreshTokenTtlSec: envInt('REFRESH_TOKEN_TTL_SEC', 30 * 24 * 3600),

  cookieSecure: env('COOKIE_SECURE', isProd ? 'true' : 'false') === 'true',
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  storageBackend: env('STORAGE_BACKEND', 'local') as 'local' | 's3',
  storageLocalDir: env('STORAGE_LOCAL_DIR', path.join(process.cwd(), 'var', 'storage')),
  s3: {
    endpoint: process.env.S3_ENDPOINT ?? '',
    region: process.env.S3_REGION ?? 'us-east-1',
    bucket: process.env.S3_BUCKET ?? 'stn',
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
  },

  /** Destination for operator notifications (error reports). Empty = store-only. */
  adminEmail: process.env.ADMIN_EMAIL ?? '',

  mail: {
    transport: env('MAIL_TRANSPORT', isProd ? 'smtp' : 'outbox') as 'smtp' | 'outbox',
    from: env('MAIL_FROM', 'Lens of Light <no-reply@stn.local>'),
    smtpHost: process.env.SMTP_HOST ?? '',
    smtpPort: envInt('SMTP_PORT', 587),
    smtpUser: process.env.SMTP_USER ?? '',
    smtpPass: process.env.SMTP_PASS ?? '',
    outboxDir: env('MAIL_OUTBOX_DIR', path.join(process.cwd(), 'var', 'mail')),
  },

  clamav: {
    host: process.env.CLAMD_HOST ?? '',
    port: envInt('CLAMD_PORT', 3310),
  },

  rateLimit: {
    windowSec: envInt('RATE_LIMIT_WINDOW_SEC', 60),
    max: envInt('RATE_LIMIT_MAX', 300),
    authMax: envInt('RATE_LIMIT_AUTH_MAX', 10),
  },

  uploads: {
    maxBytes: envInt('UPLOAD_MAX_BYTES', 50 * 1024 * 1024),
  },

  jobs: {
    enabled: env('JOBS_ENABLED', NODE_ENV === 'test' ? 'false' : 'true') === 'true',
    tickMs: envInt('JOBS_TICK_MS', 5000),
    concurrency: envInt('JOBS_CONCURRENCY', 2),
  },

  retention: {
    exportTtlHours: envInt('EXPORT_TTL_HOURS', 72),
    auditLogDays: envInt('AUDIT_LOG_RETENTION_DAYS', 730),
    deletedUserPurgeDays: envInt('DELETED_USER_PURGE_DAYS', 30),
    notificationDays: envInt('NOTIFICATION_RETENTION_DAYS', 90),
  },

  webDistDir: env('WEB_DIST_DIR', path.join(process.cwd(), '..', 'web', 'dist')),
  version: env('APP_VERSION', '1.0.0'),
};

export type Config = typeof config;
