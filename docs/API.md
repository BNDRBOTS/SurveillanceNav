# STN API Guide

Base URL: **`/api/v1`** · Machine-readable spec: **`GET /api/v1/openapi.json`** (OpenAPI 3.1).
A contract test (`server/test/security.test.ts`) fails CI if any registered route is undocumented.

## Authentication

- `POST /auth/signup` → access token (15 min, HS256) + httpOnly rotating refresh cookie (30 d, `SameSite=Strict`, path-scoped to `/api/v1/auth`).
- Send `Authorization: Bearer <accessToken>` on API calls.
- `POST /auth/refresh` rotates the refresh token; requires the `x-csrf-token` header matching the `stn_csrf` cookie (double-submit). **Reusing a rotated token revokes the whole session family** (theft response).
- TOTP MFA: `POST /auth/mfa/enable` → secret/otpauth URL → `POST /auth/mfa/verify`. Admin accounts receive a restricted `mfa_setup` token until enrollment completes.
- Account lockout: 5 failed logins → 15-minute lock. Password resets are single-use, 1-hour expiry, enumeration-safe.

## Error envelope (every non-2xx)

```json
{ "error": { "code": "rate_limited", "message": "…", "details": [], "retryAfterSec": 30 } }
```

Codes: `bad_request` `unauthorized` `mfa_required` `forbidden` `not_found` `conflict`
`payload_too_large` `validation_failed` (422, with per-field `details`) `rate_limited` (429)
`service_unavailable` (503) `internal_error` (500, correlation-id reference, never a stack trace).

## Rate limits

300 req/min per user (or IP when anonymous); 10 req/min on `auth/login|signup|reset-password`.
Every response carries `X-RateLimit-Limit/Remaining/Reset`; 429s include `Retry-After`. Admins can
apply a time-boxed audited override (`POST /admin/rate-limit-override`) and tune limits at runtime
(`PUT /admin/settings` key `rate_limits`).

## Idempotency (offline-safe writes)

Any `POST` may send `Idempotency-Key: <uuid>`. Replays return the original response with
`X-Idempotent-Replay: true` — the client outbox uses this to make reconnect retries conflict-safe.
Keys are pruned after 48 h.

## Asset queries (the map contract)

`GET /assets?format=geojson&bbox=minLng,minLat,maxLng,maxLat&zoom=Z&…filters`

- `zoom < 9` with a bbox → **server-side grid clusters**: features with
  `properties: { cluster: true, count, techBreakdown }` (≤4000 features, any dataset size).
- `zoom ≥ 9` → raw features, capped at 5000 with `truncated: true` + `total`.
- Filters: `technologyType[]`, `status[]`, `sourceType[]`, `verification`, `minConfidence`,
  `vendor`, `deployedAfter/Before`, `q` (full-text), `jurisdictionId`,
  or `nearLng/nearLat/radiusMeters`.
- `GET /assets/nearby?lng&lat&radiusMeters` → distance-sorted with `distanceMeters`
  (PostGIS `ST_DWithin`, haversine fallback advertised via `engine`).
- `GET /assets/compare?jurisdictions=a,b[,c,d]` → side-by-side technology/policy/procurement stats.

Results are cached 30 s; during DB degradation cached responses are served with `X-Data-Stale: true`.

## Uploads

Multipart, field `file`, ≤50 MB, allowlist: PDF/PNG/JPEG/WebP/AVIF/CSV/TXT with magic-byte
verification. Every upload runs the scan pipeline (ClamAV when `CLAMD_HOST` is set, built-in
heuristics otherwise, plus Luhn-validated PII detection). Failing files → `202 { quarantined: true }`
and an admin review queue; PII hits are flagged for human review, never auto-published.

## Exports

`POST /exports { resource, format, params }` → `202` + job id; poll `GET /exports/:id`.
Completed exports expose a **15-minute HMAC-signed** `downloadUrl` (no auth header needed, works in
new tabs) and expire after 72 h. Row cap 50 000 → `truncated: true` partial results with a warning.
FOIA exports require workspace membership.
