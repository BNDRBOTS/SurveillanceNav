import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import type { AdminMetrics, AuditLogEntry, Paginated, UserPublic } from '@stn/shared';
import { get, post, patch, put, del, ApiError } from '@/lib/api';
import { useStore } from '@/lib/store';
import { fmtDateTime, fmtNumber, fmtRelative } from '@/lib/format';
import { DataTable } from '@/components/DataTable';
import { StatusPill } from '@/components/Badges';
import { EmptyState, ErrorState, Skeleton } from '@/components/Feedback';
import { ConfirmDialog, Modal } from '@/components/Modal';
import { TextArea } from '@/components/Form';
import { useDebounce } from '@/lib/useDebounce';

const TABS = ['overview', 'users', 'curation', 'jobs', 'audit', 'settings'] as const;
type Tab = (typeof TABS)[number];

export default function AdminPage(): JSX.Element {
  const user = useStore((s) => s.user);
  const [tab, setTab] = useState<Tab>('overview');

  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'admin') {
    return (
      <div className="page">
        <EmptyState title="Admin access required" hint="Your role doesn't include the operations console. If this changed recently, sign out and back in." />
      </div>
    );
  }

  return (
    <div className="page" style={{ maxWidth: 1280 }}>
      <div className="page-header">
        <h1>Operations console</h1>
      </div>
      <div className="row-wrap" role="tablist" aria-label="Admin sections" style={{ marginBottom: 'var(--space-lg)' }}>
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`chip`} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === 'overview' ? <OverviewTab /> : null}
      {tab === 'users' ? <UsersTab /> : null}
      {tab === 'curation' ? <CurationTab /> : null}
      {tab === 'jobs' ? <JobsTab /> : null}
      {tab === 'audit' ? <AuditTab /> : null}
      {tab === 'settings' ? <SettingsTab /> : null}
    </div>
  );
}

/* ------------------------------ overview ------------------------------ */

function OverviewTab(): JSX.Element {
  const { data: m, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-metrics'],
    queryFn: () => get<AdminMetrics>('/admin/metrics'),
    refetchInterval: 15_000,
  });
  const toast = useStore((s) => s.toast);

  if (isLoading) return <Skeleton count={6} height={48} />;
  if (error || !m) return <ErrorState message={(error as Error | null)?.message ?? 'failed'} onRetry={() => void refetch()} />;

  return (
    <div className="col">
      <div className="grid-3">
        <div className="card stat-card">
          <span className="text-sm text-secondary">Requests (last hour)</span>
          <span className="stat-value">{fmtNumber(m.requestsLastHour)}</span>
          <span className="text-xs text-secondary">p95 latency {m.p95LatencyMs}ms</span>
        </div>
        <div className="card stat-card">
          <span className="text-sm text-secondary">Error rate</span>
          <span className="stat-value" style={{ color: m.errorRateLastHour > 0.02 ? 'var(--color-danger)' : 'var(--color-success)' }}>
            {(m.errorRateLastHour * 100).toFixed(2)}%
          </span>
          <span className="text-xs text-secondary">5xx responses / requests</span>
        </div>
        <div className="card stat-card">
          <span className="text-sm text-secondary">Infrastructure</span>
          <span className="row-wrap" style={{ gap: 6 }}>
            <StatusPill status={m.dbHealthy ? 'active' : 'failed'} />
            <span className="pill" data-tone={m.cacheBackend === 'redis' ? 'success' : 'warning'}>
              cache: {m.cacheBackend}
            </span>
            <span className="pill" data-tone={m.storage.ok ? 'success' : 'danger'}>
              storage: {m.storage.backend}
            </span>
          </span>
          <span className="text-xs text-secondary">cache hit ratio {(m.cacheHitRatio * 100).toFixed(0)}%</span>
        </div>
        <div className="card stat-card">
          <span className="text-sm text-secondary">Job queue</span>
          <span className="stat-value">{m.jobs.queued + m.jobs.running}</span>
          <span className="text-xs text-secondary">
            {m.jobs.queued} queued · {m.jobs.running} running · {m.jobs.failedLast24h} failed (24h)
          </span>
        </div>
        <div className="card stat-card">
          <span className="text-sm text-secondary">Data</span>
          <span className="stat-value">{fmtNumber(m.counts.assets ?? 0)}</span>
          <span className="text-xs text-secondary">
            assets · {fmtNumber(m.counts.foia ?? 0)} FOIA · {fmtNumber(m.counts.procurements ?? 0)} procurements · {fmtNumber(m.counts.policies ?? 0)} policies
          </span>
        </div>
        <div className="card stat-card">
          <span className="text-sm text-secondary">Needs attention</span>
          <span className="stat-value" style={{ color: 'var(--color-warning)' }}>
            {(m.counts.openDisputes ?? 0) + (m.counts.openFlags ?? 0) + (m.counts.mergeCandidates ?? 0) + (m.counts.quarantined ?? 0) + (m.counts.piiFlagged ?? 0)}
          </span>
          <span className="text-xs text-secondary">
            {m.counts.openDisputes} disputes · {m.counts.openFlags} flags · {m.counts.mergeCandidates} merges · {m.counts.quarantined} quarantined · {m.counts.piiFlagged} PII
          </span>
        </div>
      </div>

      <div className="card col">
        <h2>Scheduled maintenance</h2>
        <DataTable
          ariaLabel="Scheduled jobs"
          rows={m.scheduledJobs}
          rowKey={(s) => s.name}
          columns={[
            { key: 'name', label: 'Job', render: (s) => <code className="text-sm">{s.name}</code> },
            { key: 'interval', label: 'Every', render: (s) => `${Math.round(s.intervalSec / 60)} min` },
            { key: 'last', label: 'Last run', render: (s) => (s.lastRunAt ? fmtRelative(s.lastRunAt) : 'never') },
            {
              key: 'status',
              label: 'Status',
              render: (s) => (s.lastStatus ? <StatusPill status={s.lastStatus === 'ok' ? 'completed' : 'failed'} /> : <span className="text-xs text-secondary">—</span>),
            },
            { key: 'duration', label: 'Duration', render: (s) => (s.lastDurationMs !== null ? `${s.lastDurationMs}ms` : '—') },
            {
              key: 'enabled',
              label: 'Enabled',
              render: (s) => (
                <div className="row" style={{ gap: 6 }}>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={async () => {
                      await post(`/admin/schedules/${s.name}/toggle`);
                      void refetch();
                    }}
                    aria-pressed={s.enabled}
                  >
                    {s.enabled ? 'On' : 'Off'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={async () => {
                      try {
                        await post(`/admin/schedules/${s.name}/run`);
                        toast(`${s.name} completed.`, 'success');
                      } catch (err) {
                        toast((err as ApiError).message, 'error', 8000);
                      }
                      void refetch();
                    }}
                  >
                    Run now
                  </button>
                </div>
              ),
            },
          ]}
        />
        <div className="row-wrap">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              const res = await post<{ report: Record<string, number> }>('/admin/retention/run');
              toast(`Retention complete: ${JSON.stringify(res.report)}`, 'success', 9000);
            }}
          >
            Run retention now
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              await post('/admin/recalculate-confidence');
              toast('Confidence recalculation queued for all assets.', 'success');
            }}
          >
            Recalculate confidence
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              const res = await post<{ overrideUntil: string; message: string }>('/admin/rate-limit-override', { minutes: 15 });
              toast(res.message, 'warning', 8000);
            }}
          >
            Override rate limits (15 min, audited)
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ users ------------------------------ */

function UsersTab(): JSX.Element {
  const toast = useStore((s) => s.toast);
  const me = useStore((s) => s.user);
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search, 150);
  const [confirmDelete, setConfirmDelete] = useState<UserPublic | null>(null);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-users', debounced],
    queryFn: () => get<Paginated<UserPublic>>(`/admin/users${debounced ? `?q=${encodeURIComponent(debounced)}` : ''}`),
  });

  const update = async (id: string, fields: Record<string, string>) => {
    try {
      await patch(`/admin/users/${id}`, fields);
      toast('User updated.', 'success', 2500);
      void refetch();
    } catch (err) {
      toast((err as ApiError).message, 'error', 6000);
    }
  };

  return (
    <div className="col">
      <input className="input" style={{ maxWidth: 320 }} type="search" placeholder="Search users…" aria-label="Search users" value={search} onChange={(e) => setSearch(e.target.value)} />
      {isLoading ? (
        <Skeleton count={5} height={40} />
      ) : error ? (
        <ErrorState message={(error as Error).message} onRetry={() => void refetch()} />
      ) : (
        <DataTable
          ariaLabel="Users"
          rows={data?.items ?? []}
          rowKey={(u) => u.id}
          columns={[
            {
              key: 'name',
              label: 'User',
              sortable: true,
              sortValue: (u) => u.name,
              render: (u) => (
                <div className="col" style={{ gap: 0 }}>
                  <span className="text-sm">{u.name}</span>
                  <span className="text-xs text-secondary">{u.email}</span>
                </div>
              ),
            },
            {
              key: 'role',
              label: 'Role',
              render: (u) => (
                <select className="input" style={{ minHeight: 34, width: 'auto' }} value={u.role} aria-label={`Role for ${u.email}`} disabled={u.id === me?.id} onChange={(e) => update(u.id, { role: e.target.value })}>
                  <option value="viewer">viewer</option>
                  <option value="editor">editor</option>
                  <option value="admin">admin</option>
                </select>
              ),
            },
            { key: 'mfa', label: 'MFA', render: (u) => (u.mfaEnabled ? <StatusPill status="verified" /> : <span className="text-xs text-secondary">off</span>) },
            { key: 'status', label: 'Status', render: (u) => <StatusPill status={u.status} /> },
            { key: 'lastLogin', label: 'Last login', sortable: true, sortValue: (u) => u.lastLoginAt ?? '', render: (u) => (u.lastLoginAt ? fmtRelative(u.lastLoginAt) : 'never') },
            {
              key: 'actions',
              label: '',
              render: (u) =>
                u.id === me?.id ? (
                  <span className="text-xs text-secondary">you</span>
                ) : (
                  <div className="row" style={{ gap: 6 }}>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => update(u.id, { status: u.status === 'suspended' ? 'active' : 'suspended' })}>
                      {u.status === 'suspended' ? 'Reinstate' : 'Suspend'}
                    </button>
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => setConfirmDelete(u)}>
                      Delete
                    </button>
                  </div>
                ),
            },
          ]}
        />
      )}
      {confirmDelete ? (
        <ConfirmDialog
          title={`Delete ${confirmDelete.email}?`}
          message="The account is anonymized and sessions revoked. Their public contributions are preserved but de-attributed. This is audited and cannot be undone."
          confirmLabel="Delete user"
          destructive
          onCancel={() => setConfirmDelete(null)}
          onConfirm={async () => {
            try {
              await del(`/admin/users/${confirmDelete.id}`);
              toast('User deleted.', 'success');
            } catch (err) {
              toast((err as ApiError).message, 'error');
            }
            setConfirmDelete(null);
            void refetch();
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------ curation ------------------------------ */

interface CurationData {
  disputes: Array<{ id: string; assetId: string; assetName: string; userName: string | null; reason: string; evidence: string; evidenceUrl: string | null; createdAt: string }>;
  flags: Array<{ id: string; assetId: string; assetName: string; reason: string; createdAt: string }>;
  mergeCandidates: Array<{ id: string; assetA: string; nameA: string; assetB: string; nameB: string; score: number; reasons: string[]; createdAt: string }>;
  quarantinedFiles: Array<{ id: string; kind: string; fileName: string; createdAt: string }>;
  piiReview: Array<{ id: string; kind: string; fileName: string; createdAt: string }>;
  errorReports: Array<{ id: string; kind: string; message: string; detail: Record<string, unknown>; appVersion: string | null; userAgent: string | null; createdAt: string }>;
}

function CurationTab(): JSX.Element {
  const toast = useStore((s) => s.toast);
  const queryClient = useQueryClient();
  const [resolveDispute, setResolveDispute] = useState<CurationData['disputes'][number] | null>(null);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-curation'],
    queryFn: () => get<CurationData>('/admin/curation'),
  });

  const act = async (fn: () => Promise<unknown>, success: string) => {
    try {
      await fn();
      toast(success, 'success', 3000);
      void refetch();
      void queryClient.invalidateQueries({ queryKey: ['admin-metrics'] });
    } catch (err) {
      toast((err as ApiError).message, 'error', 7000);
    }
  };

  if (isLoading) return <Skeleton count={6} height={48} />;
  if (error || !data) return <ErrorState message={(error as Error | null)?.message ?? 'failed'} onRetry={() => void refetch()} />;

  return (
    <div className="col">
      <div className="card col">
        <h2>Disputes ({data.disputes.length})</h2>
        {data.disputes.length === 0 ? (
          <p className="text-sm text-secondary">No open disputes.</p>
        ) : (
          data.disputes.map((d) => (
            <div key={d.id} className="card col" style={{ padding: 'var(--space-sm)', gap: 6 }}>
              <div className="row-wrap">
                <strong className="text-sm">{d.assetName}</strong>
                <span className="text-xs text-secondary">
                  by {d.userName ?? 'anonymous'} · {fmtRelative(d.createdAt)}
                </span>
              </div>
              <p className="text-sm">{d.reason}</p>
              <p className="text-xs text-secondary">Evidence: {d.evidence}</p>
              {d.evidenceUrl ? (
                <a className="text-xs" href={d.evidenceUrl} target="_blank" rel="noreferrer">
                  Evidence link ↗
                </a>
              ) : null}
              <button type="button" className="btn btn-sm btn-primary" style={{ alignSelf: 'flex-start' }} onClick={() => setResolveDispute(d)}>
                Resolve…
              </button>
            </div>
          ))
        )}
      </div>

      <div className="card col">
        <h2>Flags ({data.flags.length})</h2>
        {data.flags.length === 0 ? (
          <p className="text-sm text-secondary">No open flags.</p>
        ) : (
          data.flags.map((f) => (
            <div key={f.id} className="row-wrap" style={{ justifyContent: 'space-between' }}>
              <div className="col" style={{ gap: 0, flex: 1, minWidth: 220 }}>
                <strong className="text-sm">{f.assetName}</strong>
                <span className="text-xs text-secondary">{f.reason}</span>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => act(() => post(`/admin/flags/${f.id}/resolve`, { action: 'resolve' }), 'Flag resolved.')}>
                  Resolve
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => act(() => post(`/admin/flags/${f.id}/resolve`, { action: 'dismiss' }), 'Flag dismissed.')}>
                  Dismiss
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="card col">
        <h2>Possible duplicates ({data.mergeCandidates.length})</h2>
        {data.mergeCandidates.length === 0 ? (
          <p className="text-sm text-secondary">The integrity sweep found no merge candidates.</p>
        ) : (
          data.mergeCandidates.map((mc) => (
            <div key={mc.id} className="card col" style={{ padding: 'var(--space-sm)', gap: 6 }}>
              <div className="row-wrap">
                <span className="pill" data-tone="warning">
                  {(mc.score * 100).toFixed(0)}% match
                </span>
                <span className="text-xs text-secondary">{(mc.reasons ?? []).join(' · ')}</span>
              </div>
              <p className="text-sm">
                A: <strong>{mc.nameA}</strong>
                <br />
                B: <strong>{mc.nameB}</strong>
              </p>
              <div className="row-wrap">
                <button type="button" className="btn btn-sm btn-primary" onClick={() => act(() => post('/admin/merge-assets', { keepId: mc.assetA, mergeIds: [mc.assetB] }), 'Merged into A.')}>
                  Keep A, merge B in
                </button>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => act(() => post('/admin/merge-assets', { keepId: mc.assetB, mergeIds: [mc.assetA] }), 'Merged into B.')}>
                  Keep B, merge A in
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => act(() => post(`/admin/merge-candidates/${mc.id}/dismiss`), 'Dismissed — not duplicates.')}>
                  Not duplicates
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="grid-2">
        <div className="card col">
          <h2>Quarantine ({data.quarantinedFiles.length})</h2>
          {data.quarantinedFiles.length === 0 ? (
            <p className="text-sm text-secondary">No quarantined uploads.</p>
          ) : (
            data.quarantinedFiles.map((q) => (
              <div key={q.id} className="row-wrap" style={{ justifyContent: 'space-between' }}>
                <span className="text-sm">
                  {q.fileName} <span className="text-xs text-secondary">({q.kind})</span>
                </span>
                <div className="row" style={{ gap: 6 }}>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => act(() => post(`/admin/quarantine/${q.kind}/${q.id}`, { action: 'release' }), 'Released (false positive).')}>
                    Release
                  </button>
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => act(() => post(`/admin/quarantine/${q.kind}/${q.id}`, { action: 'purge' }), 'Purged.')}>
                    Purge
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="card col">
          <h2>PII review ({data.piiReview.length})</h2>
          {data.piiReview.length === 0 ? (
            <p className="text-sm text-secondary">No files flagged for personal information.</p>
          ) : (
            data.piiReview.map((p) => (
              <div key={p.id} className="row-wrap" style={{ justifyContent: 'space-between' }}>
                <span className="text-sm">
                  {p.fileName} <span className="text-xs text-secondary">({p.kind})</span>
                </span>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => act(() => post(`/admin/pii/${p.kind}/${p.id}/clear`), 'PII flag cleared after review.')}>
                  Reviewed — clear flag
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="card col">
        <h2>Error reports ({data.errorReports.length})</h2>
        {data.errorReports.length === 0 ? (
          <p className="text-sm text-secondary">No open error reports.</p>
        ) : (
          data.errorReports.map((r) => (
            <div key={r.id} className="card col" style={{ padding: 'var(--space-sm)', gap: 6 }}>
              <div className="row-wrap">
                <span className="pill" data-tone={r.kind === 'client_error' || r.kind === 'map_style' ? 'danger' : 'warning'}>{r.kind.replace('_', ' ')}</span>
                <span className="text-xs text-secondary">{fmtRelative(r.createdAt)}{r.appVersion ? ` · v${r.appVersion}` : ''}</span>
              </div>
              <p className="text-sm">{r.message}</p>
              {r.userAgent ? <p className="text-xs text-secondary">{r.userAgent}</p> : null}
              <details>
                <summary className="text-xs text-secondary" style={{ cursor: 'pointer' }}>Diagnostics</summary>
                <code className="text-xs" style={{ display: 'block', whiteSpace: 'pre-wrap', marginTop: 4 }}>{JSON.stringify(r.detail, null, 2)}</code>
              </details>
              <div className="row">
                <button type="button" className="btn btn-sm" onClick={() => act(() => post(`/admin/error-reports/${r.id}/resolve`, { action: 'resolved' }), 'Report resolved.')}>
                  Resolved
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => act(() => post(`/admin/error-reports/${r.id}/resolve`, { action: 'dismissed' }), 'Report dismissed.')}>
                  Dismiss
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <StatuteReviewCard act={act} />

      {resolveDispute ? (
        <ResolveDisputeModal
          dispute={resolveDispute}
          onClose={() => setResolveDispute(null)}
          onDone={() => {
            setResolveDispute(null);
            void refetch();
          }}
        />
      ) : null}
    </div>
  );
}

function ResolveDisputeModal({
  dispute,
  onClose,
  onDone,
}: {
  dispute: { id: string; assetName: string; reason: string };
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const toast = useStore((s) => s.toast);
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);

  const resolve = async (status: 'accepted' | 'rejected') => {
    if (resolution.trim().length < 10) {
      toast('Write a resolution note — it is shown to the reporter and stored in the provenance trail.', 'warning');
      return;
    }
    setBusy(true);
    try {
      await post(`/admin/disputes/${dispute.id}/resolve`, { status, resolution: resolution.trim() });
      toast(`Dispute ${status}. The reporter has been notified and confidence recalculated.`, 'success', 6000);
      onDone();
    } catch (err) {
      toast((err as ApiError).message, 'error', 7000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Resolve dispute — ${dispute.assetName}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={() => resolve('rejected')} disabled={busy}>
            Reject dispute
          </button>
          <button type="button" className="btn btn-primary" onClick={() => resolve('accepted')} disabled={busy}>
            Accept (record is wrong)
          </button>
        </>
      }
    >
      <p className="text-sm text-secondary">Claim: {dispute.reason}</p>
      <TextArea label="Resolution note (visible to the reporter)" value={resolution} onChange={(e) => setResolution(e.target.value)} rows={4} placeholder="What did you verify, and what action was taken?" />
    </Modal>
  );
}

/* ------------------------------ jobs ------------------------------ */

interface JobRow {
  id: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
}

function JobsTab(): JSX.Element {
  const toast = useStore((s) => s.toast);
  const [statusFilter, setStatusFilter] = useState('');
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-jobs', statusFilter],
    queryFn: () => get<{ items: JobRow[] }>(`/admin/jobs${statusFilter ? `?status=${statusFilter}` : ''}`),
    refetchInterval: 10_000,
  });

  return (
    <div className="col">
      <select className="input" style={{ width: 'auto' }} aria-label="Filter jobs by status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
        <option value="">All jobs</option>
        <option value="queued">Queued</option>
        <option value="running">Running</option>
        <option value="completed">Completed</option>
        <option value="failed">Failed</option>
      </select>
      {isLoading ? (
        <Skeleton count={5} height={40} />
      ) : error ? (
        <ErrorState message={(error as Error).message} onRetry={() => void refetch()} />
      ) : (
        <DataTable
          ariaLabel="Background jobs"
          rows={data?.items ?? []}
          rowKey={(j) => j.id}
          emptyState={<EmptyState title="No jobs match" hint="Background work (exports, parsing, maintenance) appears here." />}
          columns={[
            { key: 'type', label: 'Type', render: (j) => <code className="text-sm">{j.type}</code> },
            { key: 'status', label: 'Status', render: (j) => <StatusPill status={j.status} /> },
            { key: 'attempts', label: 'Attempts', render: (j) => `${j.attempts}/${j.maxAttempts}` },
            { key: 'created', label: 'Created', render: (j) => fmtRelative(j.createdAt) },
            { key: 'error', label: 'Last error', render: (j) => (j.lastError ? <span className="text-xs text-danger">{j.lastError.slice(0, 80)}</span> : '—') },
            {
              key: 'actions',
              label: '',
              render: (j) =>
                j.status === 'failed' ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={async () => {
                      try {
                        await post(`/admin/jobs/${j.id}/retry`);
                        toast('Job requeued.', 'success', 2500);
                        void refetch();
                      } catch (err) {
                        toast((err as ApiError).message, 'error');
                      }
                    }}
                  >
                    Retry
                  </button>
                ) : null,
            },
          ]}
        />
      )}
    </div>
  );
}

/* ------------------------------ audit ------------------------------ */

function AuditTab(): JSX.Element {
  const [action, setAction] = useState('');
  const debounced = useDebounce(action, 150);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-audit', debounced],
    queryFn: () => get<Paginated<AuditLogEntry>>(`/admin/audit-logs?pageSize=100${debounced ? `&action=${encodeURIComponent(debounced)}` : ''}`),
  });

  return (
    <div className="col">
      <input className="input" style={{ maxWidth: 320 }} type="search" placeholder="Filter by action (e.g. asset.deleted)…" aria-label="Filter audit log" value={action} onChange={(e) => setAction(e.target.value)} />
      {isLoading ? (
        <Skeleton count={8} height={32} />
      ) : error ? (
        <ErrorState message={(error as Error).message} onRetry={() => void refetch()} />
      ) : (
        <DataTable
          ariaLabel="Audit log (append-only)"
          rows={data?.items ?? []}
          rowKey={(l) => String(l.id)}
          columns={[
            { key: 'createdAt', label: 'When', render: (l) => <span className="text-xs">{fmtDateTime(l.createdAt)}</span> },
            { key: 'actor', label: 'Actor', render: (l) => <span className="text-xs">{l.actorEmail ?? 'system'}</span> },
            { key: 'action', label: 'Action', render: (l) => <code className="text-xs">{l.action}</code> },
            { key: 'resource', label: 'Resource', render: (l) => <span className="text-xs">{l.resource}{l.resourceId ? ` ${l.resourceId.slice(0, 8)}…` : ''}</span> },
            { key: 'ip', label: 'IP', render: (l) => <span className="text-xs text-secondary">{l.ip ?? '—'}</span> },
            {
              key: 'meta',
              label: 'Metadata',
              render: (l) => (
                <span className="text-xs text-secondary" title={JSON.stringify(l.metadata)}>
                  {JSON.stringify(l.metadata).slice(0, 60)}
                </span>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}

/* ------------------------------ settings ------------------------------ */

function SettingsTab(): JSX.Element {
  const toast = useStore((s) => s.toast);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => get<{ settings: Record<string, unknown> }>('/admin/settings'),
  });
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  if (isLoading) return <Skeleton count={5} height={48} />;
  if (error || !data) return <ErrorState message={(error as Error | null)?.message ?? 'failed'} onRetry={() => void refetch()} />;

  const editable = ['feature_flags', 'rate_limits', 'cache_ttls', 'retention'];

  return (
    <div className="col">
      <p className="text-sm text-secondary">
        Runtime configuration. Changes apply within ~15 seconds, are validated server-side, and every update is audited.
      </p>
      {editable.map((key) => {
        const value = drafts[key] ?? JSON.stringify(data.settings[key], null, 2);
        return (
          <div key={key} className="card col">
            <h2>
              <code>{key}</code>
            </h2>
            <textarea className="input mono" rows={5} value={value} aria-label={`Settings JSON for ${key}`} onChange={(e) => setDrafts({ ...drafts, [key]: e.target.value })} />
            <button
              type="button"
              className="btn btn-primary btn-sm"
              style={{ alignSelf: 'flex-start' }}
              onClick={async () => {
                try {
                  const parsed = JSON.parse(value);
                  await put('/admin/settings', { key, value: parsed });
                  toast(`${key} updated.`, 'success');
                  setDrafts((d) => {
                    const next = { ...d };
                    delete next[key];
                    return next;
                  });
                  void refetch();
                } catch (err) {
                  toast(err instanceof SyntaxError ? 'Invalid JSON — fix the syntax and try again.' : (err as ApiError).message, 'error', 7000);
                }
              }}
            >
              Save {key}
            </button>
          </div>
        );
      })}
    </div>
  );
}


/* --------------------------- statute review --------------------------- */

interface StatuteAdminData {
  active: Array<{ id: string; key: string; state: string; lawName: string; citation: string; responseDays: number | null; businessDays: boolean; version: number; checkedAt: string | null; checkedBy: string | null }>;
  proposals: Array<{
    id: string; key: string; state: string; lawName: string; citation: string;
    responseDays: number | null; businessDays: boolean;
    proposedChanges: Record<string, unknown>; sourceExcerpt: string | null; llmModel: string | null; createdAt: string;
    currentLawName: string | null; currentCitation: string | null; currentResponseDays: number | null; currentBusinessDays: boolean | null;
  }>;
  llmConfigured: boolean;
}

function StatuteReviewCard({ act }: { act: (fn: () => Promise<unknown>, success: string) => Promise<void> }): JSX.Element {
  const { data, refetch } = useQuery({
    queryKey: ['admin-statutes'],
    queryFn: () => get<StatuteAdminData>('/admin/statutes'),
  });
  if (!data) return <div className="card col"><h2>Statute review</h2><Skeleton count={2} height={20} /></div>;
  const fmtDays = (d: number | null, b: boolean) => (d === null ? 'no fixed deadline' : `${d} ${b ? 'business' : 'calendar'} days`);
  return (
    <div className="card col">
      <h2>Statute review ({data.proposals.length})</h2>
      <p className="text-xs text-secondary">
        {data.active.length} jurisdictions tracked · weekly source recheck ·{' '}
        {data.llmConfigured ? 'LLM extraction active' : 'LLM extraction not configured (heuristic drift detection only) — set LEGAL_LLM_API_URL/KEY/MODEL to enable'}
      </p>
      {data.proposals.length === 0 ? (
        <p className="text-sm text-secondary">No pending statute change proposals.</p>
      ) : (
        data.proposals.map((p) => (
          <div key={p.id} className="card col" style={{ padding: 'var(--space-sm)', gap: 6 }}>
            <div className="row-wrap">
              <strong className="text-sm">{p.state}</strong>
              {p.llmModel ? <span className="pill" data-tone="accent">{p.llmModel}</span> : <span className="pill" data-tone="muted">heuristic</span>}
              <span className="text-xs text-secondary">{fmtRelative(p.createdAt)}</span>
            </div>
            <dl className="kv">
              <dt>Law</dt>
              <dd>{p.currentLawName !== p.lawName ? <><s className="text-secondary">{p.currentLawName}</s> → <strong>{p.lawName}</strong></> : p.lawName}</dd>
              <dt>Citation</dt>
              <dd>{p.currentCitation !== p.citation ? <><s className="text-secondary">{p.currentCitation}</s> → <strong>{p.citation}</strong></> : p.citation}</dd>
              <dt>Deadline</dt>
              <dd>
                {p.currentResponseDays !== p.responseDays || p.currentBusinessDays !== p.businessDays ? (
                  <>
                    <s className="text-secondary">{fmtDays(p.currentResponseDays, p.currentBusinessDays ?? true)}</s> →{' '}
                    <strong>{fmtDays(p.responseDays, p.businessDays)}</strong>
                  </>
                ) : (
                  fmtDays(p.responseDays, p.businessDays)
                )}
              </dd>
            </dl>
            {(p.proposedChanges as { note?: string }).note ? (
              <p className="text-xs text-warning">{String((p.proposedChanges as { note?: string }).note)}</p>
            ) : null}
            {p.sourceExcerpt ? (
              <details>
                <summary className="text-xs text-secondary" style={{ cursor: 'pointer' }}>Source excerpt</summary>
                <blockquote className="text-xs" style={{ margin: '4px 0 0', paddingLeft: 'var(--space-sm)', borderLeft: '2px solid var(--color-border-strong)' }}>
                  {p.sourceExcerpt}
                </blockquote>
              </details>
            ) : null}
            <div className="row">
              <button type="button" className="btn btn-sm" onClick={() => act(async () => { await post(`/admin/statutes/${p.id}/approve`); await refetch(); }, 'Statute updated — new version is live.')}>
                Approve
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => act(async () => { await post(`/admin/statutes/${p.id}/reject`); await refetch(); }, 'Proposal rejected — current statute stays.')}>
                Reject
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
