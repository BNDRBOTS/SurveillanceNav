import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Paginated, Procurement } from '@stn/shared';
import { get, post, patch, uploadFile, ApiError } from '@/lib/api';
import { useStore } from '@/lib/store';
import { fmtMoney } from '@/lib/format';
import { DataTable } from '@/components/DataTable';
import { StatusPill, ConfidenceBadge } from '@/components/Badges';
import { EmptyState, ErrorState, Skeleton } from '@/components/Feedback';
import { Modal } from '@/components/Modal';
import { Icon } from '@/components/Icon';
import { TextArea, TextInput, FileDrop } from '@/components/Form';
import { useDebounce } from '@/lib/useDebounce';

export default function ProcurementPage(): JSX.Element {
  const user = useStore((s) => s.user);
  const [parseOpen, setParseOpen] = useState(false);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [reviewFilter, setReviewFilter] = useState('');
  const debounced = useDebounce(search, 150);
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['procurements', debounced, reviewFilter],
    queryFn: () =>
      get<Paginated<Procurement>>(
        `/procurements?pageSize=100${debounced ? `&q=${encodeURIComponent(debounced)}` : ''}${reviewFilter ? `&reviewStatus=${reviewFilter}` : ''}`,
      ),
  });

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Procurement intelligence</h1>
          <p className="text-sm text-secondary">Contracts and RFPs parsed into structured data — every extraction goes through human review.</p>
        </div>
        {user && user.role !== 'viewer' ? (
          <button type="button" className="btn btn-primary" onClick={() => setParseOpen(true)}>
            ＋ Parse document
          </button>
        ) : null}
      </div>

      <div className="row-wrap" style={{ marginBottom: 'var(--space-md)' }}>
        <input className="input" style={{ maxWidth: 320 }} type="search" placeholder="Search title or vendor…" aria-label="Search procurements" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input" style={{ width: 'auto' }} aria-label="Review status" value={reviewFilter} onChange={(e) => setReviewFilter(e.target.value)}>
          <option value="">All review states</option>
          <option value="needs_review">Needs review</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      {isLoading ? (
        <Skeleton count={6} height={40} />
      ) : error ? (
        <ErrorState message={(error as Error).message} onRetry={() => void refetch()} />
      ) : (
        <DataTable
          ariaLabel="Procurements"
          rows={data?.items ?? []}
          rowKey={(p) => p.id}
          onRowClick={(p) => setReviewId(p.id)}
          emptyState={
            <EmptyState
              title="No procurement records"
              hint="Paste contract text or upload an RFP PDF — vendor, amounts, dates and technology terms are extracted automatically."
              action={
                user && user.role !== 'viewer' ? (
                  <button type="button" className="btn btn-primary" onClick={() => setParseOpen(true)}>
                    Parse a document
                  </button>
                ) : undefined
              }
            />
          }
          columns={[
            { key: 'title', label: 'Title', sortable: true, sortValue: (p) => p.title, render: (p) => <strong className="text-sm">{p.title}</strong> },
            { key: 'vendor', label: 'Vendor', sortable: true, sortValue: (p) => p.vendor ?? '', render: (p) => p.vendor ?? '—' },
            { key: 'jurisdiction', label: 'Jurisdiction', render: (p) => p.jurisdictionName ?? '—' },
            { key: 'amount', label: 'Amount', sortable: true, sortValue: (p) => p.amount ?? 0, render: (p) => fmtMoney(p.amount) },
            { key: 'terms', label: 'Technologies', render: (p) => p.technologyTerms.slice(0, 3).join(', ') || '—' },
            { key: 'confidence', label: 'Confidence', sortable: true, sortValue: (p) => p.confidenceScore, render: (p) => <ConfidenceBadge score={p.confidenceScore} compact /> },
            { key: 'review', label: 'Review', render: (p) => <StatusPill status={p.reviewStatus} /> },
          ]}
        />
      )}

      {parseOpen ? (
        <ParseModal
          onClose={() => setParseOpen(false)}
          onParsed={(procurementId) => {
            setParseOpen(false);
            void queryClient.invalidateQueries({ queryKey: ['procurements'] });
            setReviewId(procurementId);
          }}
        />
      ) : null}
      {reviewId ? (
        <ReviewDrawer
          procurementId={reviewId}
          onClose={() => {
            setReviewId(null);
            void queryClient.invalidateQueries({ queryKey: ['procurements'] });
          }}
        />
      ) : null}
    </div>
  );
}

function ParseModal({ onClose, onParsed }: { onClose: () => void; onParsed: (id: string) => void }): JSX.Element {
  const toast = useStore((s) => s.toast);
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [phase, setPhase] = useState<'input' | 'parsing'>('input');
  const [jobId, setJobId] = useState<string | null>(null);
  const [procurementId, setProcurementId] = useState<string | null>(null);

  useEffect(() => {
    if (phase !== 'parsing' || !jobId) return;
    let cancelled = false;
    const poll = async () => {
      for (let i = 0; i < 60 && !cancelled; i += 1) {
        try {
          const job = await get<{ status: string; error: string | null }>(`/procurement/jobs/${jobId}`);
          if (job.status === 'completed') {
            toast('Parsing complete — review the extracted fields.', 'success');
            onParsed(procurementId!);
            return;
          }
          if (job.status === 'failed') {
            toast(`Parsing failed: ${job.error ?? 'unknown error'}. The document is saved — review it manually.`, 'warning', 9000);
            onParsed(procurementId!);
            return;
          }
        } catch {
          /* transient poll error — keep trying */
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
      if (!cancelled) {
        toast('Parsing is taking longer than expected — it will appear in the review queue when done.', 'warning', 8000);
        onClose();
      }
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [phase, jobId, procurementId, onParsed, onClose, toast]);

  const submitText = async () => {
    try {
      const res = await post<{ procurementId: string; jobId: string }>('/procurement/parse', {
        text,
        title: title || undefined,
      });
      setProcurementId(res.procurementId);
      setJobId(res.jobId);
      setPhase('parsing');
    } catch (err) {
      toast((err as ApiError).message, 'error', 7000);
    }
  };

  const submitFile = async (file: File) => {
    setPhase('parsing');
    try {
      const res = await uploadFile<{ procurementId: string; jobId: string; quarantined?: boolean; message?: string }>(
        '/procurement/parse',
        file,
      );
      if (res.quarantined) {
        toast(res.message ?? 'File quarantined by the safety scan.', 'warning', 8000);
        onClose();
        return;
      }
      setProcurementId(res.procurementId);
      setJobId(res.jobId);
    } catch (err) {
      toast((err as ApiError).message, 'error', 7000);
      setPhase('input');
    }
  };

  return (
    <Modal title="Parse procurement document" onClose={onClose} large dismissable={phase !== 'parsing'}>
      {phase === 'parsing' ? (
        <div className="empty">
          <div className="skeleton" style={{ width: '60%', height: 10 }} />
          <h3>Extracting vendor, amounts, dates & technology terms…</h3>
          <p className="text-sm text-secondary">PDFs with no machine-readable text are routed to manual review instead of failing.</p>
        </div>
      ) : (
        <div className="col">
          <FileDrop onFile={submitFile} accept=".pdf,.txt" label="Upload an RFP / contract PDF" />
          <div className="row" aria-hidden="true">
            <hr className="divider" style={{ flex: 1 }} />
            <span className="text-xs text-secondary">or paste text</span>
            <hr className="divider" style={{ flex: 1 }} />
          </div>
          <TextInput label="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. ALPR services agreement FY26" />
          <TextArea label="Contract / RFP text" value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder="Paste at least a paragraph…" />
          <button type="button" className="btn btn-primary" onClick={submitText} disabled={text.trim().length < 20} style={{ alignSelf: 'flex-end' }}>
            Parse text
          </button>
        </div>
      )}
    </Modal>
  );
}

function ReviewDrawer({ procurementId, onClose }: { procurementId: string; onClose: () => void }): JSX.Element {
  const toast = useStore((s) => s.toast);
  const user = useStore((s) => s.user);
  const queryClient = useQueryClient();
  const { data: proc, isLoading, error, refetch } = useQuery({
    queryKey: ['procurement', procurementId],
    queryFn: () => get<Procurement & { rawTextExcerpt?: string }>(`/procurements/${procurementId}`),
  });
  const [vendor, setVendor] = useState<string | null>(null);
  const [amount, setAmount] = useState<string | null>(null);

  const save = async (fields: Record<string, unknown>) => {
    try {
      await patch(`/procurements/${procurementId}`, fields);
      void refetch();
      void queryClient.invalidateQueries({ queryKey: ['procurements'] });
      toast('Saved.', 'success', 2500);
    } catch (err) {
      toast((err as ApiError).message, 'error', 6000);
    }
  };

  const normalized = (proc?.normalized ?? {}) as {
    vendorEvidence?: string;
    amountEvidence?: string;
    warnings?: string[];
    fieldConfidence?: Record<string, number>;
    parseError?: string;
  };

  return (
    <aside className="drawer" aria-label="Procurement review">
      <div className="drawer-header">
        <h2 style={{ fontSize: 'var(--font-size-lg)' }}>Review extraction</h2>
        <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close review">
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="drawer-body col">
        {isLoading ? (
          <Skeleton count={6} />
        ) : error || !proc ? (
          <ErrorState message={(error as Error | null)?.message ?? 'Not found'} onRetry={() => void refetch()} />
        ) : (
          <>
            <div className="row-wrap">
              <StatusPill status={proc.reviewStatus} />
              <ConfidenceBadge score={proc.confidenceScore} compact />
            </div>
            {normalized.parseError ? <div className="banner" data-tone="warning" style={{ borderRadius: 'var(--radius-md)' }}>{normalized.parseError}</div> : null}
            {(normalized.warnings ?? []).map((w, i) => (
              <div key={i} className="banner" data-tone="warning" style={{ borderRadius: 'var(--radius-md)' }}>
                {w}
              </div>
            ))}

            <h3 className="text-sm">{proc.title}</h3>

            <TextInput
              label={`Vendor ${normalized.fieldConfidence?.vendor ? `(extracted, ${normalized.fieldConfidence.vendor}% confident)` : ''}`}
              value={vendor ?? proc.vendor ?? ''}
              onChange={(e) => setVendor(e.target.value)}
              onBlur={() => vendor !== null && save({ vendor: vendor || null })}
              hint={normalized.vendorEvidence ? `Evidence: “…${normalized.vendorEvidence}…”` : undefined}
            />
            <TextInput
              label={`Amount (USD) ${normalized.fieldConfidence?.amount ? `(extracted, ${normalized.fieldConfidence.amount}% confident)` : ''}`}
              value={amount ?? (proc.amount !== null ? String(proc.amount) : '')}
              onChange={(e) => setAmount(e.target.value)}
              onBlur={() => {
                if (amount === null) return;
                const n = Number(amount.replace(/[$,\s]/g, ''));
                if (Number.isFinite(n)) save({ amount: n });
                else toast('Enter a valid number for the amount.', 'warning');
              }}
              inputMode="decimal"
              hint={normalized.amountEvidence ? `Evidence: “…${normalized.amountEvidence}…”` : undefined}
            />
            <div className="row">
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="proc-start">Start date</label>
                <input id="proc-start" type="date" className="input" defaultValue={proc.startDate ?? ''} onBlur={(e) => e.target.value !== (proc.startDate ?? '') && save({ startDate: e.target.value || null })} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="proc-end">End date</label>
                <input id="proc-end" type="date" className="input" defaultValue={proc.endDate ?? ''} onBlur={(e) => e.target.value !== (proc.endDate ?? '') && save({ endDate: e.target.value || null })} />
              </div>
            </div>
            <div>
              <span className="text-sm text-secondary">Technology terms</span>
              <div className="row-wrap" style={{ marginTop: 6 }}>
                {proc.technologyTerms.length === 0 ? <span className="text-sm">none detected</span> : proc.technologyTerms.map((t) => (
                  <span key={t} className="pill" data-tone="accent">
                    {t}
                  </span>
                ))}
              </div>
            </div>
            {proc.rawTextExcerpt ? (
              <details>
                <summary className="text-sm text-secondary" style={{ cursor: 'pointer' }}>
                  Source text excerpt
                </summary>
                <p className="text-xs text-secondary" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
                  {proc.rawTextExcerpt}
                </p>
              </details>
            ) : null}

            <div className="row-wrap">
              {user?.role === 'admin' && proc.reviewStatus !== 'approved' ? (
                <button type="button" className="btn btn-primary" onClick={() => save({ reviewStatus: 'approved' })}>
                  <Icon name="check" size={16} /> Approve & publish
                </button>
              ) : null}
              {proc.reviewStatus !== 'rejected' ? (
                <button type="button" className="btn btn-danger" onClick={() => save({ reviewStatus: 'rejected' })}>
                  Reject
                </button>
              ) : null}
              {user?.role !== 'admin' ? (
                <p className="text-xs text-secondary">Publishing requires an administrator — corrections are saved instantly.</p>
              ) : null}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
