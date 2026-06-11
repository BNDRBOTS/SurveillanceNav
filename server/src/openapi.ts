/**
 * OpenAPI 3.1 document for the STN API, served at /api/v1/openapi.json.
 * Kept in code so it can never drift from the deployed route table without
 * failing the contract test (test/openapi.test.ts asserts every registered
 * API route appears here).
 */

const errorEnvelope = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: {},
        retryAfterSec: { type: 'number' },
      },
      required: ['code', 'message'],
    },
  },
} as const;

function op(summary: string, opts: { auth?: boolean; body?: boolean; multipart?: boolean; tag?: string } = {}) {
  return {
    summary,
    tags: [opts.tag ?? 'general'],
    ...(opts.auth === false ? {} : { security: [{ bearerAuth: [] }] }),
    ...(opts.body
      ? {
          requestBody: {
            required: true,
            content: opts.multipart
              ? { 'multipart/form-data': { schema: { type: 'object' } } }
              : { 'application/json': { schema: { type: 'object' } } },
          },
        }
      : {}),
    responses: {
      '200': { description: 'Success' },
      '4XX': { description: 'Client error', content: { 'application/json': { schema: errorEnvelope } } },
      '5XX': { description: 'Server error', content: { 'application/json': { schema: errorEnvelope } } },
    },
  };
}

export const openapiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Surveillance Transparency Navigator API',
    version: '1.0.0',
    description:
      'Public-interest transparency platform API: surveillance asset mapping with provenance, FOIA workflows with statutory deadlines, procurement parsing, policy timelines, governed exports, and an audited admin console. All endpoints return the consistent error envelope {error:{code,message,details?}}. Rate limits: 300 req/min per user/IP (10/min on auth endpoints), with X-RateLimit-* headers and Retry-After on 429.',
  },
  servers: [{ url: '/api/v1' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT (15-min access token)' },
    },
    schemas: { Error: errorEnvelope },
  },
  paths: {
    '/auth/signup': { post: op('Create account (first user becomes admin)', { auth: false, body: true, tag: 'auth' }) },
    '/auth/login': { post: op('Login with email/password (+TOTP when MFA enabled)', { auth: false, body: true, tag: 'auth' }) },
    '/auth/refresh': { post: op('Rotate refresh token (httpOnly cookie + CSRF header)', { auth: false, tag: 'auth' }) },
    '/auth/logout': { post: op('Revoke session', { auth: false, tag: 'auth' }) },
    '/auth/csrf': { get: op('Bootstrap CSRF cookie', { auth: false, tag: 'auth' }) },
    '/auth/mfa/enable': { post: op('Begin TOTP enrollment (returns otpauth URL)', { tag: 'auth' }) },
    '/auth/mfa/verify': { post: op('Verify TOTP code and activate MFA', { body: true, tag: 'auth' }) },
    '/auth/reset-password': { post: op('Request reset ({email}) or complete reset ({token,password})', { auth: false, body: true, tag: 'auth' }) },
    '/auth/revoke-all': { post: op('Revoke all refresh sessions', { tag: 'auth' }) },

    '/users/me': {
      get: op('Current user profile', { tag: 'users' }),
      patch: op('Update profile / change password / consent', { body: true, tag: 'users' }),
      delete: op('Delete account (GDPR/CCPA; de-attributes contributions)', { tag: 'users' }),
    },
    '/users/me/data': { get: op('Export all personal data (portability)', { tag: 'users' }) },
    '/users/me/notifications': { get: op('List notifications + unread count', { tag: 'users' }) },
    '/users/me/notifications/read': { post: op('Mark notifications read', { body: true, tag: 'users' }) },

    '/workspaces': {
      get: op('List my workspaces', { tag: 'workspaces' }),
      post: op('Create workspace', { body: true, tag: 'workspaces' }),
    },
    '/workspaces/{id}': {
      get: op('Workspace detail with members & pending invites', { tag: 'workspaces' }),
      patch: op('Update workspace (admin)', { body: true, tag: 'workspaces' }),
      delete: op('Delete workspace (owner)', { tag: 'workspaces' }),
    },
    '/workspaces/{id}/members': { post: op('Add member or send email invite (admin)', { body: true, tag: 'workspaces' }) },
    '/workspaces/{id}/members/{userId}': { delete: op('Remove member / leave workspace', { tag: 'workspaces' }) },
    '/workspaces/accept-invite': { post: op('Accept an email invite token', { body: true, tag: 'workspaces' }) },

    '/assets': {
      get: op('Query assets: bbox/zoom (geojson w/ server clustering at low zoom), filters, pagination, sort', { auth: false, tag: 'assets' }),
      post: op('Create asset (editor)', { body: true, tag: 'assets' }),
    },
    '/assets/nearby': { get: op('Proximity query: assets within radiusMeters of lng/lat with real distances', { auth: false, tag: 'assets' }) },
    '/assets/compare': { get: op('Side-by-side jurisdiction comparison (2–4 ids)', { auth: false, tag: 'assets' }) },
    '/assets/{id}': {
      get: op('Asset detail: provenance, confidence factors, evidence, history, disputes, related items', { auth: false, tag: 'assets' }),
      patch: op('Update asset with diffed change history (editor)', { body: true, tag: 'assets' }),
      delete: op('Soft-delete asset (admin, audited)', { tag: 'assets' }),
    },
    '/assets/{id}/verify': { post: op('Mark field-verified; recalculates confidence (editor)', { tag: 'assets' }) },
    '/assets/{id}/flag': { post: op('Flag a record for curator attention', { body: true, tag: 'assets' }) },
    '/assets/{id}/dispute': { post: op('Open an evidence-backed dispute', { body: true, tag: 'assets' }) },
    '/assets/{id}/evidence': { post: op('Upload evidence (≤50MB; malware+PII scanned; quarantine on fail)', { body: true, multipart: true, tag: 'assets' }) },
    '/assets/{id}/comments': {
      get: op('Workspace comments on an asset', { tag: 'assets' }),
      post: op('Comment with @mentions (notifies)', { body: true, tag: 'assets' }),
    },

    '/foia': {
      get: op('List FOIA requests across my workspaces', { tag: 'foia' }),
      post: op('Create FOIA request (draft)', { body: true, tag: 'foia' }),
    },
    '/foia/compose': { post: op('Compose statute-correct request letter from template + jurisdiction', { body: true, tag: 'foia' }) },
    '/foia/templates': { get: op('Request template library', { auth: false, tag: 'foia' }) },
    '/foia/{id}': {
      get: op('FOIA detail with documents and governing statute', { tag: 'foia' }),
      patch: op('Update / transition status (sent auto-computes statutory due date)', { body: true, tag: 'foia' }),
      delete: op('Delete request (workspace admin)', { tag: 'foia' }),
    },
    '/foia/{id}/documents': { post: op('Upload response document (scanned; redaction annotations supported)', { body: true, multipart: true, tag: 'foia' }) },
    '/foia/{id}/documents/{docId}': {
      patch: op('Save redaction annotations', { body: true, tag: 'foia' }),
      delete: op('Remove document', { tag: 'foia' }),
    },

    '/procurement/parse': { post: op('Parse contract/RFP (paste text or upload PDF) — async job, human review queue', { body: true, tag: 'procurement' }) },
    '/procurement/jobs/{jobId}': { get: op('Poll parse job status', { tag: 'procurement' }) },
    '/procurements': { get: op('List procurements with filters + full-text search', { auth: false, tag: 'procurement' }) },
    '/procurements/{id}': {
      get: op('Procurement detail with extraction evidence', { auth: false, tag: 'procurement' }),
      patch: op('Correct fields / approve (approve requires admin)', { body: true, tag: 'procurement' }),
    },

    '/policies': {
      get: op('List policies (full-text searchable)', { auth: false, tag: 'policies' }),
      post: op('Add policy (editor)', { body: true, tag: 'policies' }),
    },
    '/policies/timeline': { get: op('Policy timeline for 1–4 jurisdictions (comparison)', { auth: false, tag: 'policies' }) },
    '/policies/{id}': {
      patch: op('Update policy (editor)', { body: true, tag: 'policies' }),
      delete: op('Delete policy (admin)', { tag: 'policies' }),
    },

    '/exports': {
      get: op('My exports with signed download URLs', { tag: 'exports' }),
      post: op('Start export (csv/json/geojson/kml/pdf/html) — async, capped with truncation warning', { body: true, tag: 'exports' }),
    },
    '/exports/{id}': { get: op('Export status + signed URL', { tag: 'exports' }) },
    '/exports/download/{fileKey}': { get: op('Download via short-TTL HMAC-signed URL', { auth: false, tag: 'exports' }) },

    '/jurisdictions': {
      get: op('Search jurisdictions (cached)', { auth: false, tag: 'reference' }),
      post: op('Add jurisdiction (editor)', { body: true, tag: 'reference' }),
    },
    '/jurisdictions/{id}': { get: op('Jurisdiction detail with geometry', { auth: false, tag: 'reference' }) },
    '/sources': {
      get: op('Source registry with verification status', { auth: false, tag: 'reference' }),
      post: op('Register source (editor)', { body: true, tag: 'reference' }),
    },
    '/sources/{id}': { patch: op('Update source / set verification (admin)', { body: true, tag: 'reference' }) },
    '/reference/foia-statutes': { get: op('Public-records statutes for all 50 states + DC + federal', { auth: false, tag: 'reference' }) },
    '/presets': {
      get: op('My + workspace layer presets', { tag: 'reference' }),
      post: op('Save layer preset (returns share token)', { body: true, tag: 'reference' }),
    },
    '/presets/shared/{token}': { get: op('Resolve a shared preset URL (public)', { auth: false, tag: 'reference' }) },
    '/presets/{id}': { delete: op('Delete preset', { tag: 'reference' }) },

    '/admin/users': { get: op('List users (admin)', { tag: 'admin' }) },
    '/admin/users/{id}': {
      patch: op('Change role/status (admin, audited)', { body: true, tag: 'admin' }),
      delete: op('Delete user (admin, audited)', { tag: 'admin' }),
    },
    '/admin/audit-logs': { get: op('Query append-only audit trail', { tag: 'admin' }) },
    '/admin/metrics': { get: op('Live ops metrics: latency, errors, DB/cache/storage, jobs, counts', { tag: 'admin' }) },
    '/admin/jobs': { get: op('Job queue inspection', { tag: 'admin' }) },
    '/admin/jobs/{id}/retry': { post: op('Retry failed job', { tag: 'admin' }) },
    '/admin/schedules/{name}/toggle': { post: op('Enable/disable scheduled job', { tag: 'admin' }) },
    '/admin/schedules/{name}/run': { post: op('Run scheduled job now', { tag: 'admin' }) },
    '/admin/curation': { get: op('Curation queues: disputes, flags, merge candidates, quarantine, PII review', { tag: 'admin' }) },
    '/admin/disputes/{id}/resolve': { post: op('Resolve dispute (notifies reporter, recalcs confidence)', { body: true, tag: 'admin' }) },
    '/admin/flags/{id}/resolve': { post: op('Resolve/dismiss flag', { body: true, tag: 'admin' }) },
    '/admin/merge-assets': { post: op('Merge duplicate assets (evidence/disputes/history folded in)', { body: true, tag: 'admin' }) },
    '/admin/merge-candidates/{id}/dismiss': { post: op('Dismiss merge candidate', { tag: 'admin' }) },
    '/admin/quarantine/{kind}/{id}': { post: op('Release or purge quarantined file', { body: true, tag: 'admin' }) },
    '/admin/pii/{kind}/{id}/clear': { post: op('Clear PII flag after review', { tag: 'admin' }) },
    '/admin/retention/run': { post: op('Run retention enforcement now (returns compliance report)', { tag: 'admin' }) },
    '/admin/recalculate-confidence': { post: op('Queue full confidence recalculation', { tag: 'admin' }) },
    '/admin/settings': {
      get: op('Runtime settings & feature flags', { tag: 'admin' }),
      put: op('Update a settings key (audited)', { body: true, tag: 'admin' }),
    },
    '/admin/rate-limit-override': { post: op('Temporary audited rate-limit bypass (incident lever)', { body: true, tag: 'admin' }) },

    '/health/live': { get: op('Liveness', { auth: false, tag: 'health' }) },
    '/health/ready': { get: op('Readiness: DB/cache/storage checks', { auth: false, tag: 'health' }) },
  },
} as const;
