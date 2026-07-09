import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FOIA_STATUSES,
  DISCLAIMER_VERSIONS,
  type FoiaDocument,
  type FoiaRequest,
  type FoiaStatute,
  type FoiaTemplate,
  type Jurisdiction,
  type Paginated,
} from '@stn/shared';
import { get, post, patch, del, uploadFile, ApiError } from '@/lib/api';
import { useStore } from '@/lib/store';
import { fmtDate, fmtBytes } from '@/lib/format';
import { DataTable } from '@/components/DataTable';
import { Icon } from '@/components/Icon';
import { StatusPill } from '@/components/Badges';
import { EmptyState, ErrorState, Skeleton } from '@/components/Feedback';
import { TextInput, TextArea, Select, FileDrop } from '@/components/Form';
import { ConfirmDialog, Modal } from '@/components/Modal';
import { useDebounce } from '@/lib/useDebounce';
import { useWalkthrough } from '@/lib/tours';

/* ------------------------------- list ------------------------------- */

export function FoiaListPage(): JSX.Element {
  useWalkthrough('foia');
  const user = useStore((s) => s.user);
  const workspaceId = useStore((s) => s.currentWorkspaceId);
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 150);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['foia', workspaceId, status, debouncedSearch],
    queryFn: () =>
      get<Paginated<FoiaRequest>>(
        `/foia?pageSize=100${workspaceId ? `&workspaceId=${workspaceId}` : ''}${status ? `&status=${status}` : ''}${debouncedSearch ? `&q=${encodeURIComponent(debouncedSearch)}` : ''}`,
      ),
    enabled: !!user, // the tracker is per-account; don't fire a doomed 401 for visitors
  });

  const overdue = (f: FoiaRequest) =>
    f.dueAt && ['sent', 'acknowledged'].includes(f.status) && new Date(f.dueAt).getTime() < Date.now();

  if (!user) {
    return (
      <div className="page">
        <div className="page-header">
          <div>
            <h1>FOIA tracker</h1>
            <p className="text-sm text-secondary">Public records requests with statutory deadlines, documents, and outcomes.</p>
          </div>
        </div>
        <EmptyState
          title="Sign in to track public-records requests"
          hint="The builder writes the request, cites the correct statute for the jurisdiction, and follows the legal response deadline for you."
          action={
            <Link to="/login" className="btn btn-primary">
              Sign in
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>FOIA tracker</h1>
          <p className="text-sm text-secondary">Public records requests with statutory deadlines, documents, and outcomes.</p>
        </div>
        <Link to="/foia/new" className="btn btn-primary">
          <Icon name="plus" size={16} /> New request
        </Link>
      </div>

      <div className="row-wrap" style={{ marginBottom: 'var(--space-md)' }}>
        <input className="input" style={{ maxWidth: 320 }} type="search" placeholder="Search subject or body…" aria-label="Search FOIA requests" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input" style={{ width: 'auto' }} aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {FOIA_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <Skeleton count={6} height={40} />
      ) : error ? (
        <ErrorState message={(error as Error).message} onRetry={() => void refetch()} />
      ) : (
        <DataTable
          ariaLabel="FOIA requests"
          rows={data?.items ?? []}
          rowKey={(f) => f.id}
          onRowClick={(f) => navigate(`/foia/${f.id}`)}
          emptyState={
            <EmptyState
              title="No requests yet"
              hint={debouncedSearch || status ? 'Try adjusting your filters.' : 'File your first public records request — templates cite the right statute automatically.'}
              action={
                <Link to="/foia/new" className="btn btn-primary">
                  Create a request
                </Link>
              }
            />
          }
          columns={[
            { key: 'subject', label: 'Subject', sortable: true, render: (f) => <strong className="text-sm">{f.subject}</strong>, sortValue: (f) => f.subject },
            { key: 'jurisdiction', label: 'Jurisdiction', render: (f) => f.jurisdictionName ?? '—' },
            { key: 'status', label: 'Status', sortable: true, sortValue: (f) => f.status, render: (f) => <StatusPill status={f.status} /> },
            {
              key: 'dueAt',
              label: 'Due',
              sortable: true,
              sortValue: (f) => f.dueAt ?? '',
              render: (f) =>
                f.dueAt ? (
                  <span className={overdue(f) ? 'text-danger' : undefined}>
                    {fmtDate(f.dueAt)}
                    {overdue(f) ? ' · overdue' : ''}
                  </span>
                ) : (
                  '—'
                ),
            },
            { key: 'documentCount', label: 'Docs', render: (f) => String(f.documentCount ?? 0) },
            { key: 'outcome', label: 'Outcome', render: (f) => (f.outcome ? <StatusPill status={f.outcome} /> : '—') },
          ]}
        />
      )}
    </div>
  );
}

/* ------------------------------- builder ------------------------------- */

export function FoiaNewPage(): JSX.Element {
  const navigate = useNavigate();
  const toast = useStore((s) => s.toast);
  const workspaceId = useStore((s) => s.currentWorkspaceId);
  const [templateId, setTemplateId] = useState('');
  const [jurisdictionQuery, setJurisdictionQuery] = useState('');
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction | null>(null);
  const [requesterName, setRequesterName] = useState('');
  const [organization, setOrganization] = useState('');
  const [months, setMonths] = useState(24);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [statute, setStatute] = useState<FoiaStatute | null>(null);
  const [composing, setComposing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [legalGateOpen, setLegalGateOpen] = useState(false);
  const debouncedJq = useDebounce(jurisdictionQuery, 150);
  const queryClient = useQueryClient();

  const { data: acks } = useQuery({
    queryKey: ['acknowledgments'],
    queryFn: () => get<{ items: Array<{ key: string; version: number }> }>('/users/me/acknowledgments'),
    staleTime: Infinity,
  });
  const legalAcked = !!acks?.items.some((a) => a.key === 'foia-legal' && a.version >= DISCLAIMER_VERSIONS['foia-legal']);

  const { data: templates } = useQuery({
    queryKey: ['foia-templates'],
    queryFn: () => get<{ items: FoiaTemplate[] }>('/foia/templates'),
  });
  const { data: jurisdictions } = useQuery({
    queryKey: ['jurisdictions', debouncedJq],
    queryFn: () => get<{ items: Jurisdiction[] }>(`/jurisdictions?q=${encodeURIComponent(debouncedJq)}`),
    enabled: debouncedJq.length > 1 && !jurisdiction,
  });

  const compose = async () => {
    if (!templateId) {
      toast('Pick a template first.', 'warning');
      return;
    }
    setComposing(true);
    try {
      const res = await post<{ subject: string; body: string; statute: FoiaStatute | null }>('/foia/compose', {
        templateId,
        jurisdictionId: jurisdiction?.id,
        requesterName: requesterName || undefined,
        organization: organization || undefined,
        recordsWindowMonths: months,
      });
      setSubject(res.subject);
      setBody(res.body);
      setStatute(res.statute);
      toast(res.statute ? `Letter cites ${res.statute.lawName} (${res.statute.citation}).` : 'Letter composed — add a jurisdiction for an exact statute citation.', 'success', 6000);
    } catch (err) {
      toast((err as ApiError).message, 'error');
    } finally {
      setComposing(false);
    }
  };

  const performSave = async () => {
    setSaving(true);
    try {
      const created = await post<FoiaRequest>('/foia', {
        workspaceId,
        jurisdictionId: jurisdiction?.id ?? null,
        subject: subject.trim(),
        body: body.trim(),
      }, { queueable: true });
      toast('Draft saved. Mark it “sent” once you submit it to the agency — the statutory deadline is computed automatically.', 'success', 8000);
      navigate(`/foia/${created.id}`);
    } catch (err) {
      if ((err as Error).name === 'OfflineQueuedError') {
        toast('Offline — your draft is queued and will be created when you reconnect.', 'warning', 8000);
        navigate('/foia');
      } else {
        toast((err as ApiError).message, 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  const saveDraft = async () => {
    if (!workspaceId) {
      toast('Create or select a workspace first (top bar).', 'warning');
      return;
    }
    if (!subject.trim() || !body.trim()) {
      toast('Compose or write the request first.', 'warning');
      return;
    }
    // Legal-consequence acknowledgment: required once (per disclaimer
    // version) before any request is created. Server enforces it too.
    if (!legalAcked) {
      setLegalGateOpen(true);
      return;
    }
    await performSave();
  };

  return (
    <div className="page" style={{ maxWidth: 980 }}>
      <div className="page-header">
        <h1>New public records request</h1>
      </div>
      <div className="col">
        <div className="card col">
          <h2 className="text-sm" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-secondary)' }}>
            1 · Choose template & jurisdiction
          </h2>
          <Select label="Template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">Select a template…</option>
            {(templates?.items ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          <TextInput
            label="Jurisdiction / agency"
            value={jurisdiction ? jurisdiction.name : jurisdictionQuery}
            onChange={(e) => {
              setJurisdiction(null);
              setJurisdictionQuery(e.target.value);
            }}
            placeholder="Start typing a city, county, or state…"
            hint={jurisdiction ? 'statute will be cited automatically' : undefined}
          />
          {!jurisdiction && (jurisdictions?.items ?? []).length > 0 ? (
            <div className="col" style={{ gap: 2, marginTop: -8 }}>
              {(jurisdictions?.items ?? []).slice(0, 6).map((j) => (
                <button key={j.id} type="button" className="btn btn-sm btn-ghost" style={{ justifyContent: 'flex-start' }} onClick={() => setJurisdiction(j)}>
                  {j.name} <span className="text-xs text-secondary">({j.type})</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="row-wrap">
            <TextInput label="Your name (as signed)" value={requesterName} onChange={(e) => setRequesterName(e.target.value)} placeholder="Defaults to your account name" />
            <TextInput label="Organization (optional)" value={organization} onChange={(e) => setOrganization(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="months-range">Records window: past {months} months</label>
            <input id="months-range" type="range" min={3} max={84} step={3} value={months} onChange={(e) => setMonths(Number(e.target.value))} style={{ accentColor: 'var(--color-accent)', minHeight: 'var(--touch-target)' }} />
          </div>
          <button type="button" className="btn btn-primary" onClick={compose} disabled={composing || !templateId} style={{ alignSelf: 'flex-start' }}>
            {composing ? 'Composing…' : <><Icon name="edit" size={16} /> Compose letter</>}
          </button>
        </div>

        <div className="card col">
          <h2 className="text-sm" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-secondary)' }}>
            2 · Review & edit
          </h2>
          {statute ? (
            <div className="banner" data-tone="info" style={{ borderRadius: 'var(--radius-md)' }}>
              <Icon name="scale" size={14} /> {statute.lawName} ({statute.citation}) —{' '}
              {statute.responseDays
                ? `${statute.responseDays} ${statute.businessDays ? 'business' : 'calendar'} day response window`
                : 'reasonable-time response standard'}
              {statute.notes ? ` · ${statute.notes}` : ''}
            </div>
          ) : null}
          <TextInput label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Compose above or write your own" />
          <TextArea label="Request letter" value={body} onChange={(e) => setBody(e.target.value)} rows={16} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 'var(--font-size-sm)' }} />
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={saveDraft} disabled={saving}>
              {saving ? 'Saving…' : 'Save as draft'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(body);
                  toast('Letter copied — paste it into the agency portal or an email.', 'success');
                } catch {
                  toast('Copy failed — select the text manually.', 'warning');
                }
              }}
              disabled={!body}
            >
              Copy letter
            </button>
          </div>
        </div>
      </div>

      {legalGateOpen ? (
        <FoiaLegalGate
          onClose={() => setLegalGateOpen(false)}
          onAccepted={async () => {
            setLegalGateOpen(false);
            void queryClient.invalidateQueries({ queryKey: ['acknowledgments'] });
            await performSave();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Legal-consequence acknowledgment before the first request is created —
 * a public-records request is a real legal instrument sent under the
 * requester's name. Server-enforced (POST /foia rejects without it).
 */
function FoiaLegalGate({ onClose, onAccepted }: { onClose: () => void; onAccepted: () => Promise<void> }): JSX.Element {
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const accept = async () => {
    setBusy(true);
    try {
      await post('/users/me/acknowledgments', { key: 'foia-legal', version: DISCLAIMER_VERSIONS['foia-legal'] });
      await onAccepted();
    } catch (err) {
      toast((err as ApiError).message, 'error');
      setBusy(false);
    }
  };
  return (
    <Modal title="Before you file public-records requests" onClose={onClose} dismissable={false}>
      <div className="col" style={{ gap: 'var(--space-sm)' }}>
        <p className="text-sm">
          A public-records request is a <strong>real legal instrument</strong> submitted to a government agency
          under your name. Before your first one:
        </p>
        <ul className="text-sm" style={{ paddingLeft: 'var(--space-lg)', display: 'grid', gap: 6 }}>
          <li>Your request — and often your identity as the requester — may itself become a public record.</li>
          <li>Agencies may charge search, review, and duplication fees; you are responsible for fees you agree to.</li>
          <li>Knowingly false statements to a government agency can carry civil or criminal penalties.</li>
          <li>
            This platform drafts letters and computes statutory deadlines from tracked law, but it is not a law
            firm, this is not legal advice, and statute data can lag the law. Verify before relying on it.
          </li>
        </ul>
        <p className="text-xs text-secondary">
          Acknowledging records the current notice version on your account. You won’t be asked again unless the
          notice materially changes.
        </p>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 'var(--space-md)' }}>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
          Not now
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void accept()} disabled={busy}>
          {busy ? 'Recording…' : 'I understand — continue'}
        </button>
      </div>
    </Modal>
  );
}

/* ------------------------------- detail ------------------------------- */

type FoiaDetail = FoiaRequest & { documents: FoiaDocument[]; statute: FoiaStatute | null };

const NEXT_ACTIONS: Record<string, Array<{ to: string; label: string }>> = {
  draft: [{ to: 'sent', label: 'Mark as sent' }],
  sent: [
    { to: 'acknowledged', label: 'Agency acknowledged' },
    { to: 'response', label: 'Response received' },
  ],
  acknowledged: [
    { to: 'response', label: 'Response received' },
    { to: 'appeal', label: 'File appeal' },
  ],
  response: [
    { to: 'appeal', label: 'File appeal' },
    { to: 'closed', label: 'Close request' },
  ],
  appeal: [
    { to: 'response', label: 'Appeal response received' },
    { to: 'closed', label: 'Close request' },
  ],
  closed: [],
};

export function FoiaDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useStore((s) => s.toast);
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [foiaNumber, setFoiaNumber] = useState<string | null>(null);

  const { data: foia, isLoading, error, refetch } = useQuery({
    queryKey: ['foia-detail', id],
    queryFn: () => get<FoiaDetail>(`/foia/${id}`),
    enabled: !!id,
  });

  const transition = async (status: string) => {
    try {
      const updated = await patch<FoiaRequest>(`/foia/${id}`, { status });
      if (status === 'sent' && updated.dueAt) {
        toast(`Marked sent. Statutory response deadline: ${fmtDate(updated.dueAt)} — we'll remind you.`, 'success', 9000);
      }
      void queryClient.invalidateQueries({ queryKey: ['foia-detail', id] });
    } catch (err) {
      toast((err as ApiError).message, 'error', 7000);
    }
  };

  const setOutcome = async (outcome: string) => {
    try {
      await patch(`/foia/${id}`, { outcome: outcome || null });
      void queryClient.invalidateQueries({ queryKey: ['foia-detail', id] });
    } catch (err) {
      toast((err as ApiError).message, 'error');
    }
  };

  const uploadDoc = async (file: File) => {
    setUploading(true);
    try {
      const res = await uploadFile<{ ok: boolean; quarantined?: boolean; piiFlagged?: boolean; message?: string }>(`/foia/${id}/documents`, file);
      if (res.quarantined) toast(res.message ?? 'File quarantined.', 'warning', 9000);
      else if (res.piiFlagged) toast(res.message ?? 'Possible PII detected — review before sharing.', 'warning', 9000);
      else toast('Document attached.', 'success');
      void queryClient.invalidateQueries({ queryKey: ['foia-detail', id] });
    } catch (err) {
      toast((err as ApiError).message, 'error');
    } finally {
      setUploading(false);
    }
  };

  const memoBody = useMemo(() => foia?.body ?? '', [foia?.body]);

  if (isLoading) {
    return (
      <div className="page">
        <Skeleton count={8} height={24} />
      </div>
    );
  }
  if (error || !foia) {
    return (
      <div className="page">
        <ErrorState message={(error as Error | null)?.message ?? 'Request not found'} onRetry={() => void refetch()} />
      </div>
    );
  }

  const overdue = foia.dueAt && ['sent', 'acknowledged'].includes(foia.status) && new Date(foia.dueAt).getTime() < Date.now();

  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <div className="page-header">
        <div className="col" style={{ gap: 4 }}>
          <Link to="/foia" className="text-sm text-secondary">
            ← All requests
          </Link>
          <h1 style={{ fontSize: 'var(--font-size-lg)' }}>{foia.subject}</h1>
          <div className="row-wrap" style={{ gap: 6 }}>
            <StatusPill status={foia.status} />
            {foia.outcome ? <StatusPill status={foia.outcome} /> : null}
            {overdue ? (
              <span className="pill" data-tone="danger">
                response overdue
              </span>
            ) : null}
          </div>
        </div>
        <button type="button" className="btn btn-danger btn-sm" onClick={() => setConfirmDelete(true)}>
          Delete
        </button>
      </div>

      <div className="grid-2">
        <div className="col">
          <div className="card col">
            <h3>Status & deadlines</h3>
            <dl className="kv">
              <dt>Jurisdiction</dt>
              <dd>{foia.jurisdictionName ?? 'Not set'}</dd>
              <dt>Statute</dt>
              <dd>{foia.statute ? `${foia.statute.lawName} (${foia.statute.citation})` : 'Set a jurisdiction to resolve the statute'}</dd>
              <dt>Sent</dt>
              <dd>{fmtDate(foia.sentAt)}</dd>
              <dt>Response due</dt>
              <dd className={overdue ? 'text-danger' : undefined}>{fmtDate(foia.dueAt)}</dd>
              <dt>Tracking #</dt>
              <dd>
                <input
                  className="input"
                  style={{ minHeight: 34 }}
                  defaultValue={foia.foiaNumber ?? ''}
                  placeholder="Agency tracking number"
                  aria-label="Agency tracking number"
                  onBlur={async (e) => {
                    const v = e.target.value.trim();
                    if (v !== (foia.foiaNumber ?? '')) {
                      setFoiaNumber(v);
                      await patch(`/foia/${id}`, { foiaNumber: v || null });
                      toast('Tracking number saved.', 'success', 2500);
                    }
                  }}
                />
              </dd>
            </dl>
            {foiaNumber !== null ? <span className="visually-hidden" aria-live="polite">Tracking number saved</span> : null}
            <div className="row-wrap">
              {(NEXT_ACTIONS[foia.status] ?? []).map((a) => (
                <button key={a.to} type="button" className="btn btn-sm btn-primary" onClick={() => transition(a.to)}>
                  {a.label}
                </button>
              ))}
            </div>
            {['response', 'appeal', 'closed'].includes(foia.status) ? (
              <div className="field">
                <label htmlFor="outcome-select">Outcome</label>
                <select id="outcome-select" className="input" value={foia.outcome ?? ''} onChange={(e) => setOutcome(e.target.value)}>
                  <option value="">Not tagged</option>
                  <option value="fulfilled">Fulfilled</option>
                  <option value="partial">Partially fulfilled</option>
                  <option value="denied">Denied</option>
                  <option value="withdrawn">Withdrawn</option>
                </select>
              </div>
            ) : null}
          </div>

          <div className="card col">
            <h3>Documents ({foia.documents.length})</h3>
            <FileDrop onFile={uploadDoc} busy={uploading} label="Attach agency response or related document" />
            {foia.documents.map((d) => (
              <DocumentRow key={d.id} doc={d} foiaId={foia.id} onChanged={() => void queryClient.invalidateQueries({ queryKey: ['foia-detail', id] })} />
            ))}
          </div>
        </div>

        <div className="card col">
          <h3>Request letter</h3>
          <pre className="text-sm" style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: 'var(--color-bg-secondary)', padding: 'var(--space-sm)', borderRadius: 'var(--radius-md)', maxHeight: 520, overflow: 'auto' }}>
            {memoBody}
          </pre>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              await navigator.clipboard.writeText(foia.body);
              toast('Letter copied.', 'success', 2500);
            }}
          >
            Copy letter
          </button>
        </div>
      </div>

      {confirmDelete ? (
        <ConfirmDialog
          title="Delete this request?"
          message="The request and its tracking history will be removed for everyone in the workspace. Attached documents are deleted from storage. This cannot be undone."
          confirmLabel="Delete request"
          destructive
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            try {
              await del(`/foia/${id}`);
              toast('Request deleted.', 'success');
              navigate('/foia');
            } catch (err) {
              toast((err as ApiError).message, 'error');
              setConfirmDelete(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function DocumentRow({ doc, foiaId, onChanged }: { doc: FoiaDocument; foiaId: string; onChanged: () => void }): JSX.Element {
  const toast = useStore((s) => s.toast);
  const [notes, setNotes] = useState(
    typeof doc.redactions === 'object' && doc.redactions !== null ? JSON.stringify(doc.redactions) : '',
  );
  const [editing, setEditing] = useState(false);

  return (
    <div className="card col" style={{ padding: 'var(--space-sm)', gap: 6 }}>
      <div className="row">
        <Icon name="file-text" size={16} />
        <div className="col" style={{ gap: 0, flex: 1 }}>
          <span className="text-sm">{doc.fileName}</span>
          <span className="text-xs text-secondary">
            {fmtBytes(doc.sizeBytes)} · {fmtDate(doc.createdAt)}
          </span>
        </div>
        <StatusPill status={doc.piiStatus === 'flagged' ? 'flagged' : doc.scanStatus} />
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={async () => {
            await del(`/foia/${foiaId}/documents/${doc.id}`);
            toast('Document removed.', 'success', 2500);
            onChanged();
          }}
          aria-label={`Remove ${doc.fileName}`}
        >
          <Icon name="trash" size={16} />
        </button>
      </div>
      <button type="button" className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setEditing((e) => !e)} aria-expanded={editing}>
        {editing ? 'Hide redaction notes' : 'Redaction notes'}
      </button>
      {editing ? (
        <div className="col" style={{ gap: 6 }}>
          <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder='e.g. [{"page":3,"exemption":"b(6)","note":"officer names"}]' aria-label="Redaction annotations" />
          <button
            type="button"
            className="btn btn-sm btn-primary"
            style={{ alignSelf: 'flex-start' }}
            onClick={async () => {
              let parsed: unknown = notes;
              try {
                parsed = JSON.parse(notes);
              } catch {
                /* keep as free text */
              }
              await patch(`/foia/${foiaId}/documents/${doc.id}`, { redactions: parsed });
              toast('Redaction notes saved.', 'success', 2500);
              onChanged();
            }}
          >
            Save notes
          </button>
        </div>
      ) : null}
    </div>
  );
}
