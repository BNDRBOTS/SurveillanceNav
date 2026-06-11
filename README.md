# Lens of Light — Surveillance Transparency Navigator (STN)

A production-grade, public-interest platform for mapping, understanding, and **acting on** surveillance
infrastructure: cameras, license plate readers, drones, gunshot detection, facial recognition deployments —
with verified provenance, FOIA workflows that cite the correct statute, procurement intelligence, policy
timelines, governed exports, and a fully audited operations console.

Built for journalists, researchers, civic organizations, municipalities, auditors, and citizens.

---

## Quick start

**Prerequisites:** Node 22+, PostgreSQL 14+ (PostGIS recommended, auto-detected), Redis optional.

```bash
make install              # npm workspaces install
cp .env.example .env      # defaults work for local dev
make migrate seed         # schema + reference data + demo dataset
make dev                  # API :4000 + web :5173 (proxied, same-origin)
```

Or the full stack in containers (PostGIS + Redis + MinIO + app):

```bash
docker compose up --build   # → http://localhost:4000
```

**Demo accounts** (dev seeds only): `admin@stn.local` / `editor@stn.local` / `viewer@stn.local`,
password `LensOfLight-demo-2026`. The admin account walks through real TOTP enrollment on first
login — MFA is enforced for administrators. The **first signup on an empty database becomes admin**.

`make seed-perf` generates a 100k+ asset dataset for scale testing.

## What's inside

| Area | Highlights |
| --- | --- |
| **Map** | MapLibre GL with bundled offline vector basemap (zero tile dependency), optional OSM/Esri raster, Supercluster + server-side grid clustering at low zoom (smooth at 100k+ points), heatmap, per-technology layers, radius analysis with real distances, jurisdiction comparison, shareable URL state & saved views with share tokens, click-to-add submissions |
| **Trust engine** | Source registry with verification states, explainable 0–100 confidence scores (tap any score for the factor breakdown), immutable diffed change history, evidence uploads (malware + PII scanned, quarantine queue), disputes with mandatory admin resolution, automatic duplicate detection → merge workflow |
| **FOIA** | Template library + composer that cites the governing public-records statute for all 50 states + DC + federal, computes the statutory response deadline when marked sent, deadline reminders (in-app + email), document repository with redaction annotations, outcome tagging |
| **Procurement** | Paste text or upload contract/RFP PDFs → async extraction of vendor, amounts, dates, technology terms with per-field evidence and confidence; human review queue; admin-gated publication |
| **Collaboration** | Workspaces with viewer/editor/admin roles (deny-by-default), email invites, @mention comments with notifications, workspace-shared map views |
| **Exports** | CSV (formula-injection safe), JSON, GeoJSON, KML, and PDF/HTML reports with vector map snapshots and methodology notes — generated async, short-TTL HMAC-signed downloads, automatic expiry |
| **Offline / PWA** | Installable; service worker with cache strategies per resource; IndexedDB outbox replays queued submissions with idempotency keys (conflict-safe); dataset caches are SHA-256 integrity-checked on restore |
| **Admin console** | Live metrics (p95 latency, error rate, cache hit ratio, DB/storage health), user management, curation queues (disputes/flags/merges/quarantine/PII), job queue with retry, 9 scheduled maintenance jobs with run-now/toggle, runtime settings + feature flags, audited rate-limit override, append-only audit log explorer |
| **Security** | scrypt passwords, 15-min HS256 JWTs + rotating refresh tokens with reuse detection (family revocation), TOTP MFA (required for admins), CSRF double-submit, strict CSP & full security-header suite, per-user+IP rate limiting with Retry-After, JSON-bomb guards, zero-width input sanitation, account lockout, append-only audit DB triggers |

## Architecture

```
shared/   zod schemas + domain types + confidence engine + FOIA statutes (single source of truth)
server/   Fastify 5 (TS strict) · PostgreSQL/PostGIS (lat/lng haversine fallback auto-detected)
          Redis cache w/ in-memory failover + circuit breaker · DB-backed job queue + scheduler
          local-FS or S3 (hand-rolled SigV4) storage · SMTP or JSONL-outbox mail
web/      Vite + React 18 (TS strict) · Zustand + TanStack Query · MapLibre GL + Supercluster
          token-driven CSS design system ("Void & Glow") · hand-written SW + IndexedDB offline layer
```

**Documented stack choices** (where the spec allowed alternatives):

- **Vite + React Router** over Next.js — same-origin SPA served by the API keeps cookies first-party,
  CSP tight, and the PWA simple; SSR adds nothing for an auth-gated map tool.
- **DB-backed job queue** over BullMQ — jobs must survive Redis loss and be admin-inspectable/retryable
  (a spec failsafe requirement); `FOR UPDATE SKIP LOCKED` gives safe multi-worker claims.
- **Token-driven hand-rolled CSS** over Tailwind — the design tokens are implemented literally as custom
  properties with zero runtime and a CI-enforced WCAG 2.2 contrast audit (`make contrast`).
- **Hand-rolled crypto primitives on node:crypto** (HS256 JWT, scrypt, RFC 6238 TOTP, SigV4, signed URLs)
  — zero supply-chain exposure for the security core; all covered by unit tests incl. RFC test vectors.
- **Postgres full-text** (generated tsvector columns + GIN) over Elasticsearch — one fewer stateful
  service; pg_trgm powers fuzzy duplicate detection.

## Scheduled auto-maintenance (all enabled by default)

`integrity_check` (duplicates/orphans) · `retention_enforcement` (GDPR purge + audit archive, emits a
compliance report) · `cache_warmup` · `backup_verify` (nightly pg_dump → storage, weekly restore test
into a scratch DB) · `scan_pending_files` · `confidence_recalc` · `export_cleanup` ·
`index_maintenance` (ANALYZE/VACUUM + bloat alerts) · `foia_deadline_check`.
Every run records status/duration; failures retry with exponential backoff and alert admins.

## Commands

`make dev | build | start | migrate | migrate-down | seed | seed-perf | test | typecheck | lint |
contrast | audit | compose` — see the Makefile. The API self-documents at **`/api/v1/openapi.json`**
(a contract test asserts every route is documented).

## Documentation

- [docs/API.md](docs/API.md) — API guide (auth, errors, rate limits, idempotency)
- [docs/SCHEMA.md](docs/SCHEMA.md) — data model & indexes
- [docs/SECURITY.md](docs/SECURITY.md) — threat model & controls
- [docs/PRIVACY.md](docs/PRIVACY.md) — data practices (also rendered in-app at `/privacy`)
- [docs/RUNBOOKS.md](docs/RUNBOOKS.md) — incident response & operations
- [docs/AUDIT.md](docs/AUDIT.md) — **full audit report with verified results**

## License

AGPL-3.0 — transparency tooling should stay transparent.
