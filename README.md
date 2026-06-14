# Lens of Light — Surveillance Transparency Navigator (STN)

A production-grade, public-interest platform for mapping, understanding, and **acting on** surveillance
infrastructure: cameras, license plate readers, drones, gunshot detection, facial recognition deployments —
with verified provenance, FOIA workflows that cite the correct statute, procurement intelligence, policy
timelines, governed exports, and an operations console with full audit logging.

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
| **Map** | MapLibre GL with bundled offline vector basemap (zero tile dependency), optional OSM/Esri raster, Supercluster + server-side grid clustering at low zoom (scales to 100k+ points), heatmap, per-technology layers, radius analysis with real distances, jurisdiction comparison, shareable URL state & saved views with share tokens, click-to-add submissions |
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
- [docs/AUDIT.md](docs/AUDIT.md) — **internal audit report with verified results**

## License

AGPL-3.0 — transparency tooling should stay transparent.

## Deploying on Railway (GitHub → Railway)

1. **New Project → Deploy from GitHub repo** — Railway auto-detects the `Dockerfile`.
2. **Add a PostgreSQL database** (Railway plugin). Railway injects `DATABASE_URL` automatically.
   PostGIS isn't in Railway's default Postgres — that's fine: the app auto-detects and uses its
   built-in lat/lng fallback. (Optional: deploy the `postgis/postgis:16-3.4` image as a service instead.)
3. **Add Redis** (optional — the app runs without it; set `REDIS_URL` if you add it).
4. **Set these variables** on the app service:
   `NODE_ENV=production` · `COOKIE_SECURE=true` · `TRUST_PROXY=true` ·
   `PUBLIC_URL=https://<your-app>.up.railway.app` ·
   `JWT_SECRET` / `REFRESH_SECRET` / `DOWNLOAD_SECRET` (three different random strings —
   generate each with `openssl rand -base64 48` or any password generator, 40+ chars).
5. **Attach a Volume** mounted at `/data` and set `STORAGE_LOCAL_DIR=/data/storage`
   (Railway's filesystem is wiped on redeploy — the volume keeps uploads, exports, and backups).
   Or set `STORAGE_BACKEND=s3` with any S3/R2 credentials instead.
6. Deploy. Migrations run automatically on boot. Health check path: `/health/ready`.
7. Open the app and **sign up — the first account becomes admin** (you'll be walked through
   authenticator-app setup). Don't seed demo users in production.

## Navigation (v1.1) — camera-aware directions

The map's **➤ Directions** button (floating button on phones) gives A→B routing that **avoids known
cameras**: search any address (or tap the map / paste coordinates), and STN returns an avoidance
route next to the fastest route with an honest comparison — *"avoids 14 of 16 cameras · +4 min"* —
plus in-app turn-by-turn with voice guidance, camera-proximity alerts, off-route recalculation, and
a screen wake-lock. One tap hands the route to **Google Maps or Apple Maps**, pinned through the
avoidance via-points (no Google API key or billing account required).

Routing engines (first configured wins; all proxied server-side):

| Engine | Avoidance | Setup |
| --- | --- | --- |
| **Valhalla** (`VALHALLA_URL`) | guaranteed (hard exclusion) | self-host: `docker run -p 8002:8002 ghcr.io/valhalla/valhalla` with an OSM extract (see valhalla docs) |
| **OpenRouteService** (`ORS_API_KEY`) | guaranteed (polygon avoidance) | free API key at openrouteservice.org — 2 minutes |
| **OSRM** (`OSRM_URL`, default public demo) | best effort (lowest-exposure alternative, clearly labeled) | none — works out of the box for dev |

Address search uses Nominatim (configurable/self-hostable). Every failure degrades cleanly:
engines fall through the chain, geocoding outages suggest coordinate paste, and the UI never lies
about whether avoidance was guaranteed or best-effort.

## Stripe payments (v1.1) — Supporter plan

Fully wired, zero extra dependencies, hidden until configured. The civic core (map, navigation,
FOIA, disputes) stays free; Supporters raise export caps (10k → 50k rows) and fund the platform.

Setup (≈5 minutes in the Stripe Dashboard):
1. **Products → Add product** → name "STN Supporter", add a **recurring** price → copy the
   `price_…` id → set `STRIPE_PRICE_ID_PRO`.
2. **Developers → API keys** → copy the secret key → set `STRIPE_SECRET_KEY`.
3. **Developers → Webhooks → Add endpoint** → URL `https://<your-domain>/api/v1/billing/webhook`,
   events: `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted` → copy the signing secret → set `STRIPE_WEBHOOK_SECRET`.
4. Redeploy. Settings now shows "Become a Supporter" → Stripe Checkout → webhook flips the plan
   (signature-verified, idempotent) → "Manage billing" opens the Stripe customer portal.

On **Railway** add those three variables in step 4 of the deployment guide above.
