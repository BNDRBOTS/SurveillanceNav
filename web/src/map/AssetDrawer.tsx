import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  TECHNOLOGY_LABELS,
  type AssetEvidence,
  type AssetHistoryEntry,
  type CommentItem,
  type ConfidenceFactor,
  type Dispute,
  type SurveillanceAsset,
  type TechnologyType,
} from '@stn/shared';
import { get, post, uploadFile, ApiError, OfflineQueuedError } from '@/lib/api';
import { useStore } from '@/lib/store';
import { fmtDate, fmtDateTime, fmtBytes } from '@/lib/format';
import { ConfidenceBadge, StatusPill, VerificationBadge } from '@/components/Badges';
import { Modal } from '@/components/Modal';
import { TextArea, TextInput, FileDrop } from '@/components/Form';
import { Skeleton, ErrorState } from '@/components/Feedback';
import { haptics } from '@/lib/haptics';

type AssetDetail = SurveillanceAsset & {
  evidence: AssetEvidence[];
  history: AssetHistoryEntry[];
  disputes: Dispute[];
  related: Array<{ id: string; name: string; technologyType: TechnologyType; lng: number; lat: number }>;
  relatedPolicies: Array<{ id: string; title: string; effectiveDate: string }>;
  relatedFoia: Array<{ id: string; subject: string; status: string }>;
  confidenceFactors: ConfidenceFactor[];
};

interface AssetDrawerProps {
  assetId: string;
  onClose: () => void;
  onNavigateAsset: (id: string) => void;
}

export function AssetDrawer({ assetId, onClose, onNavigateAsset }: AssetDrawerProps): JSX.Element {
  const queryClient = useQueryClient();
  const toast = useStore((s) => s.toast);
  const user = useStore((s) => s.user);
  const workspaceId = useStore((s) => s.currentWorkspaceId);
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [flagOpen, setFlagOpen] = useState(false);
  const [tab, setTab] = useState<'overview' | 'evidence' | 'history' | 'discussion'>('overview');
  const [uploading, setUploading] = useState(false);

  const { data: asset, isLoading, error, refetch } = useQuery({
    queryKey: ['asset', assetId],
    queryFn: () => get<AssetDetail>(`/assets/${assetId}`),
  });

  const { data: comments } = useQuery({
    queryKey: ['comments', assetId, workspaceId],
    queryFn: () => get<{ items: CommentItem[] }>(`/assets/${assetId}/comments?workspaceId=${workspaceId}`),
    enabled: !!user && !!workspaceId && tab === 'discussion',
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['asset', assetId] });
  };

  const uploadEvidence = async (file: File) => {
    setUploading(true);
    try {
      const res = await uploadFile<{ ok: boolean; quarantined?: boolean; piiFlagged?: boolean; message?: string }>(
        `/assets/${assetId}/evidence`,
        file,
      );
      if (res.quarantined) {
        toast(res.message ?? 'File quarantined by the safety scan.', 'warning', 9000);
      } else if (res.piiFlagged) {
        toast(res.message ?? 'Possible personal information detected — queued for review.', 'warning', 9000);
        haptics.medium();
      } else {
        toast('Evidence uploaded — confidence score updated.', 'success');
        haptics.success();
      }
      invalidate();
    } catch (err) {
      toast((err as ApiError).message, 'error', 8000);
    } finally {
      setUploading(false);
    }
  };

  const markVerified = async () => {
    try {
      const res = await post<{ confidenceScore: number }>(`/assets/${assetId}/verify`);
      toast(`Marked verified — confidence now ${res.confidenceScore}.`, 'success');
      invalidate();
    } catch (err) {
      toast((err as ApiError).message, 'error');
    }
  };

  return (
    <aside className="drawer" aria-label="Asset details">
      {isLoading ? (
        <div className="drawer-body">
          <Skeleton count={6} height={18} />
        </div>
      ) : error || !asset ? (
        <div className="drawer-body">
          <ErrorState message={(error as Error | null)?.message ?? 'Asset not found'} onRetry={() => void refetch()} />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      ) : (
        <>
          <div className="drawer-header">
            <div className="col" style={{ gap: 4 }}>
              <h2 style={{ fontSize: 'var(--font-size-lg)' }}>{asset.name}</h2>
              <div className="row-wrap" style={{ gap: 6 }}>
                <StatusPill status={asset.status} />
                <ConfidenceBadge score={asset.confidenceScore} factors={asset.confidenceFactors} />
                <VerificationBadge status={asset.sourceVerification} />
                {(asset.openDisputes ?? 0) > 0 ? (
                  <span className="pill" data-tone="danger">
                    {asset.openDisputes} open dispute{asset.openDisputes === 1 ? '' : 's'}
                  </span>
                ) : null}
              </div>
            </div>
            <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close details">
              ✕
            </button>
          </div>

          <div className="row" style={{ padding: '0 var(--space-md)', gap: 4, borderBottom: '1px solid var(--color-border)' }} role="tablist">
            {(['overview', 'evidence', 'history', 'discussion'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className="btn btn-sm btn-ghost"
                style={tab === t ? { color: 'var(--color-accent)', borderBottom: '2px solid var(--color-accent)', borderRadius: 0 } : { borderRadius: 0 }}
                onClick={() => setTab(t)}
              >
                {t === 'overview' ? 'Overview' : t === 'evidence' ? `Evidence (${asset.evidence.length})` : t === 'history' ? 'History' : 'Discussion'}
              </button>
            ))}
          </div>

          <div className="drawer-body col">
            {tab === 'overview' ? (
              <>
                <dl className="kv">
                  <dt>Technology</dt>
                  <dd>{TECHNOLOGY_LABELS[asset.technologyType]}</dd>
                  <dt>Vendor</dt>
                  <dd>{asset.vendor ?? 'Unknown'}</dd>
                  <dt>Jurisdiction</dt>
                  <dd>{asset.jurisdictionName ?? 'Unassigned'}</dd>
                  <dt>Deployed</dt>
                  <dd>{fmtDate(asset.deploymentDate)}</dd>
                  {asset.retirementDate ? (
                    <>
                      <dt>Retired</dt>
                      <dd>{fmtDate(asset.retirementDate)}</dd>
                    </>
                  ) : null}
                  <dt>Source</dt>
                  <dd>
                    {asset.sourceName ?? 'No source on record'}
                    {asset.sourceType ? <span className="text-secondary"> ({asset.sourceType})</span> : null}
                  </dd>
                  <dt>Last verified</dt>
                  <dd>{asset.lastVerifiedAt ? fmtDateTime(asset.lastVerifiedAt) : 'Never field-verified'}</dd>
                  <dt>Coordinates</dt>
                  <dd className="mono">
                    {asset.lat.toFixed(5)}, {asset.lng.toFixed(5)}
                  </dd>
                </dl>

                {Object.keys(asset.properties ?? {}).filter((k) => k !== 'seeded').length > 0 ? (
                  <details>
                    <summary className="text-sm text-secondary" style={{ cursor: 'pointer' }}>
                      Additional properties
                    </summary>
                    <dl className="kv" style={{ marginTop: 'var(--space-xs)' }}>
                      {Object.entries(asset.properties)
                        .filter(([k]) => k !== 'seeded')
                        .map(([k, v]) => (
                          <span key={k} style={{ display: 'contents' }}>
                            <dt>{k}</dt>
                            <dd>{String(v)}</dd>
                          </span>
                        ))}
                    </dl>
                  </details>
                ) : null}

                <div className="row-wrap">
                  {user ? (
                    <>
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => setDisputeOpen(true)}>
                        Dispute record
                      </button>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFlagOpen(true)}>
                        ⚑ Flag
                      </button>
                      {user.role !== 'viewer' ? (
                        <button type="button" className="btn btn-sm btn-ghost" onClick={markVerified}>
                          ✓ Mark verified
                        </button>
                      ) : null}
                    </>
                  ) : (
                    <p className="text-xs text-secondary">
                      <Link to="/login">Sign in</Link> to dispute, flag, or contribute evidence.
                    </p>
                  )}
                </div>

                {asset.disputes.length > 0 ? (
                  <section>
                    <h3 className="text-sm">Disputes</h3>
                    {asset.disputes.map((d) => (
                      <div key={d.id} className="card" style={{ padding: 'var(--space-sm)', marginTop: 'var(--space-xs)' }}>
                        <div className="row">
                          <StatusPill status={d.status} />
                          <span className="text-xs text-secondary">{fmtDate(d.createdAt)}</span>
                        </div>
                        <p className="text-sm" style={{ marginTop: 4 }}>
                          {d.reason}
                        </p>
                        {d.resolution ? <p className="text-xs text-secondary">Resolution: {d.resolution}</p> : null}
                      </div>
                    ))}
                  </section>
                ) : null}

                {asset.related.length > 0 ? (
                  <section>
                    <h3 className="text-sm">Nearby in this jurisdiction</h3>
                    <div className="col" style={{ gap: 4, marginTop: 'var(--space-xs)' }}>
                      {asset.related.map((r) => (
                        <button key={r.id} type="button" className="btn btn-sm btn-ghost" style={{ justifyContent: 'flex-start' }} onClick={() => onNavigateAsset(r.id)}>
                          {TECHNOLOGY_LABELS[r.technologyType]} · {r.name}
                        </button>
                      ))}
                    </div>
                  </section>
                ) : null}

                {asset.relatedPolicies.length > 0 ? (
                  <section>
                    <h3 className="text-sm">Related policies</h3>
                    <ul className="text-sm" style={{ paddingLeft: 'var(--space-lg)', marginTop: 'var(--space-xs)' }}>
                      {asset.relatedPolicies.map((p) => (
                        <li key={p.id}>
                          <Link to={`/policies?jurisdiction=${asset.jurisdictionId}`}>{p.title}</Link>{' '}
                          <span className="text-xs text-secondary">({fmtDate(p.effectiveDate)})</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                {asset.relatedFoia.length > 0 ? (
                  <section>
                    <h3 className="text-sm">Related FOIA requests</h3>
                    <ul className="text-sm" style={{ paddingLeft: 'var(--space-lg)', marginTop: 'var(--space-xs)' }}>
                      {asset.relatedFoia.map((f) => (
                        <li key={f.id}>
                          <Link to={`/foia/${f.id}`}>{f.subject}</Link> <StatusPill status={f.status} />
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </>
            ) : null}

            {tab === 'evidence' ? (
              <>
                {user ? (
                  <FileDrop onFile={uploadEvidence} busy={uploading} label="Add evidence (photo, document)" />
                ) : (
                  <p className="text-sm text-secondary">Sign in to contribute evidence.</p>
                )}
                {asset.evidence.length === 0 ? (
                  <p className="text-sm text-secondary">No evidence on file yet. Evidence raises the record’s confidence score.</p>
                ) : (
                  asset.evidence.map((e) => (
                    <div key={e.id} className="card row" style={{ padding: 'var(--space-sm)' }}>
                      <span aria-hidden="true">{e.fileType.startsWith('image/') ? '🖼' : '📄'}</span>
                      <div className="col" style={{ gap: 2, flex: 1 }}>
                        <span className="text-sm">{e.fileName}</span>
                        <span className="text-xs text-secondary">
                          {fmtBytes(e.sizeBytes)} · {fmtDate(e.createdAt)}
                        </span>
                      </div>
                      <StatusPill status={e.piiStatus === 'flagged' ? 'flagged' : e.scanStatus} />
                    </div>
                  ))
                )}
              </>
            ) : null}

            {tab === 'history' ? (
              asset.history.length === 0 ? (
                <p className="text-sm text-secondary">No recorded changes.</p>
              ) : (
                <div className="timeline">
                  {asset.history.map((h) => (
                    <div key={h.id} className="timeline-item">
                      <div className="text-sm" style={{ fontWeight: 600 }}>
                        {h.action.replace(/_/g, ' ')}
                        <span className="text-xs text-secondary" style={{ fontWeight: 400 }}>
                          {' '}
                          · {h.userName ?? 'system'} · {fmtDateTime(h.createdAt)}
                        </span>
                      </div>
                      {h.diff ? (
                        <dl className="kv text-xs" style={{ marginTop: 4 }}>
                          {Object.entries(h.diff).map(([field, change]) => (
                            <span key={field} style={{ display: 'contents' }}>
                              <dt>{field}</dt>
                              <dd>
                                <s className="text-secondary">{String(change.from ?? '—')}</s> → {String(change.to ?? '—')}
                              </dd>
                            </span>
                          ))}
                        </dl>
                      ) : null}
                    </div>
                  ))}
                </div>
              )
            ) : null}

            {tab === 'discussion' ? (
              <Discussion assetId={assetId} comments={comments?.items ?? []} onPosted={() => void queryClient.invalidateQueries({ queryKey: ['comments', assetId, workspaceId] })} />
            ) : null}
          </div>
        </>
      )}

      {disputeOpen ? <DisputeModal assetId={assetId} onClose={() => setDisputeOpen(false)} onDone={invalidate} /> : null}
      {flagOpen ? <FlagModal assetId={assetId} onClose={() => setFlagOpen(false)} /> : null}
    </aside>
  );
}

function Discussion({
  assetId,
  comments,
  onPosted,
}: {
  assetId: string;
  comments: CommentItem[];
  onPosted: () => void;
}): JSX.Element {
  const user = useStore((s) => s.user);
  const workspaceId = useStore((s) => s.currentWorkspaceId);
  const toast = useStore((s) => s.toast);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  if (!user || !workspaceId) {
    return <p className="text-sm text-secondary">Discussion is workspace-scoped — sign in and select a workspace.</p>;
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      await post(`/assets/${assetId}/comments`, { workspaceId, body: body.trim() });
      setBody('');
      onPosted();
    } catch (err) {
      toast((err as ApiError).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {comments.length === 0 ? (
        <p className="text-sm text-secondary">No comments yet. Mention teammates with @name or @email.</p>
      ) : (
        comments.map((c) => (
          <div key={c.id} className="card" style={{ padding: 'var(--space-sm)' }}>
            <div className="text-xs text-secondary">
              {c.userName} · {fmtDateTime(c.createdAt)}
            </div>
            <p className="text-sm" style={{ marginTop: 2 }}>
              {c.body}
            </p>
          </div>
        ))
      )}
      <form onSubmit={submit} className="col" style={{ gap: 'var(--space-xs)' }}>
        <textarea
          className="input"
          rows={2}
          placeholder="Add a comment… (@mention to notify)"
          aria-label="Comment"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <button className="btn btn-primary btn-sm" disabled={busy || !body.trim()} style={{ alignSelf: 'flex-end' }}>
          {busy ? 'Posting…' : 'Post comment'}
        </button>
      </form>
    </>
  );
}

function DisputeModal({ assetId, onClose, onDone }: { assetId: string; onClose: () => void; onDone: () => void }): JSX.Element {
  const toast = useStore((s) => s.toast);
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async () => {
    const errs: Record<string, string> = {};
    if (!reason.trim()) errs.reason = 'Briefly state what is wrong';
    if (evidence.trim().length < 20) errs.evidence = 'Describe your evidence (at least 20 characters) so a curator can act on it';
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    try {
      const res = await post<{ message: string }>(`/assets/${assetId}/dispute`, {
        reason: reason.trim(),
        evidence: evidence.trim(),
        ...(evidenceUrl.trim() ? { evidenceUrl: evidenceUrl.trim() } : {}),
      }, { queueable: true });
      toast(res.message, 'success', 7000);
      haptics.medium();
      onDone();
      onClose();
    } catch (err) {
      if (err instanceof OfflineQueuedError) {
        toast(err.message, 'warning', 8000);
        onClose();
      } else {
        toast((err as ApiError).message, 'error', 8000);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Dispute this record"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? 'Submitting…' : 'Submit dispute'}
          </button>
        </>
      }
    >
      <p className="text-sm text-secondary" style={{ marginBottom: 'var(--space-sm)' }}>
        Disputes immediately lower the record’s confidence score and notify curators. Your dispute and its resolution
        become part of the record’s permanent provenance trail.
      </p>
      <TextInput label="What's wrong?" value={reason} onChange={(e) => setReason(e.target.value)} error={errors.reason} placeholder="e.g. Camera was removed in May 2026" />
      <TextArea label="Your evidence" value={evidence} onChange={(e) => setEvidence(e.target.value)} error={errors.evidence} rows={4} placeholder="What did you observe, when, and how can it be checked?" />
      <TextInput label="Evidence link (optional)" value={evidenceUrl} onChange={(e) => setEvidenceUrl(e.target.value)} placeholder="https://…" type="url" />
    </Modal>
  );
}

function FlagModal({ assetId, onClose }: { assetId: string; onClose: () => void }): JSX.Element {
  const toast = useStore((s) => s.toast);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!reason.trim()) return;
    setBusy(true);
    try {
      const res = await post<{ message: string }>(`/assets/${assetId}/flag`, { reason: reason.trim() }, { queueable: true });
      toast(res.message, 'success');
      onClose();
    } catch (err) {
      if (err instanceof OfflineQueuedError) {
        toast(err.message, 'warning', 8000);
        onClose();
      } else {
        toast((err as ApiError).message, 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Flag for review"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !reason.trim()}>
            {busy ? 'Sending…' : 'Flag record'}
          </button>
        </>
      }
    >
      <p className="text-sm text-secondary" style={{ marginBottom: 'var(--space-sm)' }}>
        Use a flag for quick attention (wrong category, spam, sensitive content). Use a dispute when you have evidence
        the record is factually wrong.
      </p>
      <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
    </Modal>
  );
}
