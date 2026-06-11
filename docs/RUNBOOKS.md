# STN Operations Runbooks

All checks live in the admin console (`/admin`) and `GET /health/ready`. Alerts arrive as admin
notifications (bell + email when SMTP configured).

## 1 · Database down / degraded

**Symptoms**: `/health/ready` → 503, `dbHealthy:false`, banner "temporary service degradation".
**Behavior while down**: reads serve from cache (`X-Data-Stale`), writes fail fast with retryable
errors, queue/scheduler pause, audit entries buffer in memory and flush on recovery.
**Actions**: check `pg_isready`; restore primary or fail over; the app reconnects automatically
(bounded backoff). Afterwards verify `audit buffer` drained (metrics) and run
`POST /admin/schedules/integrity_check/run`.

## 2 · Restore from backup

Nightly dumps land at `backups/stn-YYYY-MM-DD.dump` in object storage (restore-verified weekly).
```bash
pg_restore --no-owner -d "$DATABASE_URL" stn-YYYY-MM-DD.dump
npm run migrate -w server      # apply anything newer than the dump
```
Then: `POST /admin/recalculate-confidence` and a manual smoke (`make audit`).

## 3 · Redis loss

No action required — cache falls back to bounded in-memory LRU (circuit breaker reopens after 15 s
probes), rate limiting continues per-instance, jobs are DB-backed. Restore Redis for multi-node
deployments; verify `cacheBackend: redis` in metrics.

## 4 · Storage outage

Uploads fail with clear errors (drafts persist in DB); exports queue and retry with backoff;
`backup_verify` alerts. Restore the bucket/filesystem, then `POST /admin/jobs/:id/retry` any failed
export jobs (Jobs tab filters `failed`).

## 5 · Stuck or failing jobs

Jobs tab → inspect `last_error`. Stale `running` locks (crashed worker) auto-requeue after 10 min.
Retry via UI or `POST /admin/jobs/:id/retry`. Scheduled jobs can be disabled (toggle) during
incident windows — re-enable after.

## 6 · Abuse / spam wave

Curation tab → resolve flags, purge quarantine; suspend accounts (Users tab — sessions revoke ≤30 s).
Tighten limits live: `PUT /admin/settings` `rate_limits`. If limits misfire on legit traffic, use the
**audited override** (`/admin` Overview → "Override rate limits") — auto-expires.

## 7 · Cache purge

`PUT /admin/settings` with `cache_ttls` adjustments, or restart the instance (memory cache) +
`redis-cli FLUSHDB` (shared cache). Asset caches self-invalidate on every mutation.

## 8 · User data deletion request (GDPR/CCPA)

Self-service path is preferred (Settings → Delete). Operator path: Admin → Users → Delete (audited;
identical anonymization). Verify in audit logs: `admin.user_deleted` / `user.deleted_self`, then
confirm next `retention_enforcement` report counts the purge.

## 9 · Rollback a bad migration

```bash
cd server && npx tsx src/db/migrate.ts down 1   # transactional, recorded
```
Deploy the previous image; migrations are forward-only in CI so coordinate before re-applying.

## 10 · Incident response template

1. Declare in ops channel; assign IC. 2. Snapshot `/admin/metrics` + relevant audit-log slice.
3. Mitigate (runbooks above). 4. Customer comms if user-visible >15 min. 5. Post-incident: timeline,
root cause, action items; attach the audit-log export for the window.
