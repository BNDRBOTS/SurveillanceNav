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
    '/auth/recovery-codes': {
      get: op('Remaining one-time recovery codes', { tag: 'auth' }),
      post: op('Regenerate recovery codes (requires current password; shown once)', { body: true, tag: 'auth' }),
    },
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

    '/feedback/error-report': {
      post: op('Submit an anonymous diagnostic error report (bounded, PII-free, rate-limited)', {
        auth: false,
        body: true,
        tag: 'feedback',
      }),
    },
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
    '/admin/curation': { get: op('Curation queues: disputes, flags, merge candidates, quarantine, PII review, error reports', { tag: 'admin' }) },
    '/admin/error-reports/{id}/resolve': { post: op('Resolve/dismiss an error report', { body: true, tag: 'admin' }) },
    '/admin/statutes': { get: op('Live statute store: active rows + pending change proposals', { tag: 'admin' }) },
    '/admin/statutes/{id}/approve': { post: op('Approve a statute change proposal (supersedes the active row)', { tag: 'admin' }) },
    '/admin/statutes/{id}/reject': { post: op('Reject a statute change proposal', { tag: 'admin' }) },
    '/admin/statutes/{key}': { patch: op('Directly correct a statute (creates an approved new version)', { body: true, tag: 'admin' }) },
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

    '/geo/search': { get: op('Address/place search (server-proxied geocoding, cached)', { auth: false, tag: 'navigation' }) },
    '/geo/reverse': { get: op('Reverse geocode a coordinate', { auth: false, tag: 'navigation' }) },
    '/navigation/route': { post: op('Camera-aware routing: avoidant + fastest routes with exposure scoring (engine chain: Valhalla → ORS → OSRM best-effort; optional Google when GOOGLE_MAPS_API_KEY is set)', { auth: false, body: true, tag: 'navigation' }) },
    '/navigation/config': { get: op('Optional routing capabilities available to the client (e.g. Google routing)', { auth: false, tag: 'navigation' }) },
    '/billing/status': { get: op('Billing configuration + current plan', { auth: false, tag: 'billing' }) },
    '/billing/checkout': { post: op('Start Stripe Checkout (subscription)', { tag: 'billing' }) },
    '/billing/portal': { post: op('Open Stripe customer portal', { tag: 'billing' }) },
    '/billing/webhook': { post: op('Stripe webhook (signature-verified, idempotent)', { auth: false, body: true, tag: 'billing' }) },

    '/health/live': { get: op('Liveness', { auth: false, tag: 'health' }) },
    '/health/ready': { get: op('Readiness: DB/cache/storage checks', { auth: false, tag: 'health' }) },
  },
} as const;

/* --------------------------- rendered reference --------------------------- */

interface DocOp {
  summary: string;
  tags?: readonly string[];
  security?: unknown;
  requestBody?: unknown;
}

const METHOD_COLOR: Record<string, string> = {
  get: '#00e5a8', post: '#4aa8ff', patch: '#ffb454', put: '#ffb454', delete: '#ff5d6c',
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const DOC_STYLE =
  ':root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0a0b0c;color:#e7e9ea;' +
  'font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding-bottom:64px}' +
  'header{padding:32px 24px;border-bottom:1px solid #1f2123;background:#0e0f10}h1{margin:0 0 4px;font-size:24px}' +
  '.v{color:#9aa0a6;font-size:13px;margin:0 0 12px}.d{color:#c2c7cc;max-width:820px;margin:0 0 14px}' +
  'a{color:#00e5a8;text-decoration:none}a:hover{text-decoration:underline}main{max-width:940px;margin:0 auto;padding:24px}' +
  'section{margin:0 0 26px}h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#9aa0a6;' +
  'border-bottom:1px solid #1f2123;padding-bottom:6px;margin:0 0 8px}ul{list-style:none;margin:0;padding:0}' +
  'li{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:7px 10px;border-radius:8px}li:hover{background:#141618}' +
  '.m{font-weight:700;font-size:12px;min-width:52px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}' +
  'code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}' +
  '.s{color:#9aa0a6;flex:1;min-width:220px;font-size:13px}.tag{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid #2a2d30}' +
  '.auth{color:#ffb454}.pub{color:#00e5a8}.body{color:#4aa8ff}';

/**
 * Server-rendered, no-JS HTML reference for the API (renders the OpenAPI spec).
 * Works under the strict app CSP — inline <style> only, zero scripts — so it
 * needs no CSP relaxation. Linked from the app nav in place of raw JSON.
 */
export function renderDocsHtml(): string {
  const doc = openapiDocument as unknown as {
    info: { title: string; version: string; description: string };
    servers: ReadonlyArray<{ url: string }>;
    paths: Record<string, Record<string, DocOp>>;
  };
  const groups = new Map<string, string[]>();
  for (const [p, methods] of Object.entries(doc.paths)) {
    for (const [method, opItem] of Object.entries(methods)) {
      const tag = opItem.tags?.[0] ?? 'general';
      const auth = opItem.security
        ? '<span class="tag auth" title="Requires authentication">auth</span>'
        : '<span class="tag pub" title="Public">public</span>';
      const body = opItem.requestBody ? '<span class="tag body">body</span>' : '';
      const row =
        `<li><span class="m" style="color:${METHOD_COLOR[method] ?? '#aaa'}">${esc(method.toUpperCase())}</span>` +
        `<code>${esc(p)}</code><span class="s">${esc(opItem.summary)}</span>${auth}${body}</li>`;
      const list = groups.get(tag) ?? [];
      list.push(row);
      groups.set(tag, list);
    }
  }
  const sections = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([tag, rows]) => `<section><h2>${esc(tag)}</h2><ul>${rows.join('')}</ul></section>`)
    .join('');
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(doc.info.title)} — API reference</title><style>${DOC_STYLE}</style></head><body>` +
    `<header><h1>${esc(doc.info.title)}</h1>` +
    `<p class="v">v${esc(doc.info.version)} · OpenAPI 3.1 · base <code>${esc(doc.servers[0]!.url)}</code></p>` +
    `<p class="d">${esc(doc.info.description)}</p>` +
    `<p><a href="/api/v1/openapi.json">Raw OpenAPI JSON</a> · <a href="/map">Back to app</a></p></header>` +
    `<main>${sections}</main></body></html>`
  );
}
