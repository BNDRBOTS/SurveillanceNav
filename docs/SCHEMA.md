# STN Data Model

Migrations: `server/migrations/*.up.sql|*.down.sql` — versioned, transactional, recorded in
`schema_migrations`. `0002_postgis` is auto-skipped (and recorded as skipped) on servers without the
extension; the app then uses lat/lng + haversine SQL transparently.

## Entity map

```
users ─┬─ refresh_tokens / password_resets / notifications
       ├─ workspace_members ── workspaces ── workspace_invites
       │                          └─ foia_requests ── foia_documents
       ├─ surveillance_assets ─┬─ asset_evidence
       │      │                ├─ asset_history   (append-only, diffed)
       │      │                ├─ asset_sources   (corroboration M:N)
       │      │                ├─ disputes / flags / comments
       │      │                └─ merge_candidates
       │      ├─ jurisdictions (self-referencing tree: country→state→county/city/agency)
       │      └─ sources       (registry + verification_status)
       ├─ procurements / policies   (per-jurisdiction, FTS columns)
       ├─ exports                   (async jobs + signed files)
       └─ layer_presets             (shareable map views)
audit_logs (append-only) · jobs / job_schedules · app_settings · idempotency_keys · request_metrics
foia_templates
```

## Integrity guarantees

- **Append-only enforcement in the database**: `audit_logs` and `asset_history` have BEFORE
  UPDATE/DELETE triggers raising exceptions. The retention job may prune `audit_logs` only after
  archiving to object storage and setting the transaction-local GUC `stn.allow_audit_prune`.
- **Soft deletes** (`deleted_at`) on user-facing entities; merges fold evidence/disputes/comments
  into the kept asset and log a `merge` history entry.
- **Generated columns**: assets/policies/procurements maintain `tsvector` FTS columns; with PostGIS,
  `surveillance_assets.geo_point` is a generated `geography(Point,4326)` and jurisdiction geometry
  syncs from its GeoJSON via trigger (malformed geometry never blocks writes).

## Index strategy

- Spatial: GIST on `geo_point` and jurisdiction `geom` (PostGIS) + btree `(lat,lng)` fallback.
- Filters: btree on `jurisdiction_id`, `technology_type`, `vendor`, `status`, `deployment_date`,
  `confidence_score` — all partial `WHERE deleted_at IS NULL`.
- Search: GIN on FTS columns; `pg_trgm` GIN on names for fuzzy duplicate detection.
- Queue: partial index on `jobs(status, run_at, priority) WHERE status='queued'`;
  claims use `FOR UPDATE SKIP LOCKED`.
- Uniques: `lower(email)` (active users), `lower(name)+type` jurisdictions, source names,
  refresh/invite/reset token hashes, idempotency `(key, user_id)`.

Counts, the confidence formula, and enums live in `shared/src/constants.ts` /
`shared/src/confidence.ts` — the one source of truth for server and web.
