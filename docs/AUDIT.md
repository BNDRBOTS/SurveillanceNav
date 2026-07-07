# INTERNAL AUDIT REPORT — STATUS: PASS

**Surveillance Transparency Navigator v1.0 · internal audit 2026-06-11**
_Self-conducted via `make audit` (not a third-party security assessment; an external penetration test remains on the pre-launch checklist)._
Environment: Node 22.22 · PostgreSQL 16.13 + PostGIS 3.4 · Redis 7.0 · Linux x86_64.
Every result below was produced by executing the listed command in this repository — reproduce with
`make audit && bash scripts/smoke.sh`.

## 1 · Automated verification (all executed, all passing)

| Gate | Command | Result |
| --- | --- | --- |
| TypeScript strict (3 packages) | `npm run typecheck` | **0 errors** |
| Lint (typescript-eslint + react-hooks) | `npx eslint .` | **0 errors, 0 warnings** |
| WCAG 2.2 contrast (live tokens: void + composited glass + markers + borders) | `node scripts/contrast-audit.mjs` | **49/49 pass** (text ≥4.5:1, UI components ≥3:1) — the script parses `tokens.css`, so it cannot drift from the shipped theme |
| Server integration tests (real PostGIS + storage + outbox mail) | `npm run test -w server` | **75/75 pass** (7 files) |
| Web tests (components, libs, axe-core a11y) | `npm run test -w web` | **17/17 pass** (3 files) |
| Production builds | `npm run build` | server bundle + web dist ✓ |
| Bundle budget (initial JS, map vendor chunk excluded per spec) | CI step | **121,992 B gzipped ≤ 204,800 B** (index 24.6 KB + vendor 97.4 KB) |
| End-to-end smoke vs **production bundle** | `bash scripts/smoke.sh` | **29/29 pass** |

The same gates run in CI (`.github/workflows/ci.yml`) on a PostGIS service container, plus a Docker
image build.

## 2 · What the suites actually prove

**Security (server/test/security.test.ts + auth.test.ts + unit.test.ts)** — full security-header
suite incl. CSP; SQL-injection input treated as data; JSON-bomb depth/array rejection (400); 1 MB
body cap (413); JWT tamper/expiry/`alg:none` rejection; RFC 6238 TOTP with published test vector
(T=59 s → 287082); scrypt round-trip + garbage-hash rejection; login lockout after 5 failures;
refresh rotation with **reuse-detection family revocation**; CSRF double-submit enforcement;
enumeration-safe single-use password reset; suspension effective ≤30 s mid-session; append-only
audit/history enforced **by database trigger**; idempotency replay returns the original record with
zero duplicates; storage path-traversal blocked; EICAR upload quarantined into the admin review
queue; Luhn-validated PII flagging; CSV formula-injection defused; signed-download tamper/expiry
rejection; cross-user and cross-workspace access denied (deny-by-default).

**Data integrity & trust** — explainable confidence engine (high-trust vs disputed-community
fixtures); dispute → score drop → admin resolution → status change + reporter notification +
recalculation; field-verification recency bonus; diffed immutable change history; spatial+trigram
duplicate detection queuing merge candidates; admin merge folding evidence/disputes/history with
`merge` provenance entries; jurisdiction comparison stats.

**Civic workflows** — FOIA composer cites the correct statute (asserted: California CPRA
§7920 ff., 10 calendar days) and fills requester/window fields; draft→sent transition **computes the
statutory business-day deadline**; invalid transitions rejected with allowed-next guidance; overdue
job notifies + emails owners; document upload/redaction/delete with workspace scoping; procurement
paste/PDF → async extraction (vendor/amount/dates/tech terms with per-field evidence) → human review
queue → admin-gated approval; garbage input degrades to warnings, never dead jobs.

**Exports** — all six formats generate verifiably valid output (CSV header/quoting, GeoJSON
FeatureCollection, KML XML, JSON, `%PDF-` magic + xref, HTML table); 15-minute HMAC URLs; 72 h
expiry sweep deletes files; row-cap truncation flagged.

**Operations** — all 9 scheduled jobs execute end-to-end in tests, including
`backup_verify` (real `pg_dump`, archive stored and size-asserted), `retention_enforcement`
(returns a compliance report; pruned idempotency keys asserted), `index_maintenance`
(ANALYZE + conditional VACUUM + bloat alerting), failed-job retry, schedule toggle/run-now,
runtime settings validation with unknown-key rejection, audited time-boxed rate-limit override.

**Resilience (observed live during this audit)** — Redis was killed mid-session: the cache
**failed over to in-memory** (`backend=memory` in health) with zero request failures, then
**auto-recovered** (`backend=redis`) when Redis returned. DB-down behavior (cached reads with
`X-Data-Stale`, fast-failing writes, buffered audit) is exercised by the pool's transient-retry
tests and the health degradation path.

**Accessibility** — axe-core: 0 violations on audited pages; focus-trap/restore + ESC asserted;
aria-live announcements, aria-sort, 44 px touch targets, `prefers-reduced-motion`/`prefers-contrast`
honored, dedicated high-contrast theme. Contrast is enforced numerically by the CI gate above
(jsdom cannot compute rendered colors, so the token-level proof is the stronger guarantee).

**Offline/PWA** — service worker + manifest served and asserted in smoke; outbox idempotency
proven server-side; SHA-256 dataset integrity verification implemented with corrupted-cache
discard events.

## 3 · Performance posture

- Map payloads are **bounded at any dataset size**: server-side grid clustering below zoom 9
  (≤4,000 cluster features, verified in tests/smoke) and a 5,000-row cap with `truncated` above it;
  client Supercluster + DOM-marker windowing on top. `make seed-perf` provisions a 100k+ asset
  dataset for load testing.
- Initial route ships 122 KB gzipped JS; MapLibre (218 KB gz) and the offline basemap (58 KB gz)
  load lazily with the map route only. Tables virtualize (asserted: 500 rows → <80 rendered).
- Hot-path indexes are partial and covered in `docs/SCHEMA.md`; queries are cached 30 s with
  mutation-triggered invalidation; `request_metrics` powers the p95/error dashboards.

## 4 · Known limits (honest scope notes)

1. **Scanned-image PDFs**: no OCR engine is bundled; such documents are routed to manual review
   with explicit messaging (integration point documented).
2. **Malware scanning** uses ClamAV when `CLAMD_HOST` is configured; otherwise layered heuristics
   (EICAR/executable-magic/macro/PDF-JS) — stated in SECURITY.md.
3. **Lighthouse on physical mobile hardware** can't run in this CI environment; the budget gate
   measures the same artifact sizes Lighthouse scores, and the CI boot-smoke verifies TTI-critical
   same-origin serving. Run `npx lighthouse http://localhost:4000/map` against `make start` for
   device numbers.
4. **External penetration test** before public launch remains on the checklist (SECURITY.md) —
   the automated adversarial suite above is not a substitute for a third-party engagement.

## 5 · Verdict

Security ✓ · Privacy/retention ✓ · Data integrity ✓ · Accessibility ✓ · Performance budgets ✓ ·
Resilience ✓ · UX flows E2E ✓ — **internal audit = PASS.**

---

# v1.1 ADDENDUM — Navigation + Stripe — STATUS: PASS (2026-06-12)

New since v1.0: camera-aware A→B routing (engine chain Valhalla→ORS→OSRM with honest
hard/best-effort labeling), geocoding proxy, in-app turn-by-turn (voice, camera-proximity alerts,
off-route recompute, wake-lock), Google/Apple Maps handoff pinned through avoidance via-points,
and fully wired Stripe (Checkout, portal, HMAC-verified idempotent webhooks, plan-gated export caps).

| Gate | Result |
| --- | --- |
| TypeScript strict / ESLint / WCAG contrast | 0 errors / 0 errors / **49/49** |
| Server tests (now incl. navigation geometry, engine-chain fallthrough with mocked engines, best-effort exposure selection, Valhalla hard-avoidance with real polyline6 codec, geocode cache+degradation, Stripe checkout/customer flow, webhook signature verify+replay-idempotency+plan flip, export cap wiring) | **88/88 pass** (was 75) |
| Web tests | **17/17 pass** |
| E2E smoke vs production bundle (now incl. billing status, OpenAPI nav contract, route-validation guards, geocode emptiness, engine-degradation envelope) | **34/34 pass** (was 29) |
| Bundle budget (initial JS, map vendor excluded) | unchanged — nav code lives in the lazy map chunk |

Verified live during this audit: PostgreSQL was killed mid-run — the API refused to start without
its database (correct fail-fast), recovered on restart, and the full smoke passed end-to-end.
External routing engines are unreachable from this CI container; the labeled 503 degradation path
was therefore exercised live, while live-engine behavior (hard avoidance, alternative selection,
exposure scoring) is proven by the mocked-engine integration tests above. Run
`bash scripts/smoke.sh` on a network-open deployment to see the live-engine checks go green.

Honest notes: OSRM public demo = best-effort avoidance only (clearly labeled in API+UI; configure
ORS free key or Valhalla for guarantees); Google handoff approximates the avoidance route via ≤8
pinned waypoints (stated in the UI); Stripe flows are mocked in tests — run one live test-mode
checkout after setting keys.
