import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Jurisdiction, Paginated, Policy } from '@stn/shared';
import { get, post, ApiError } from '@/lib/api';
import { useStore } from '@/lib/store';
import { fmtDate } from '@/lib/format';
import { EmptyState, ErrorState, Skeleton } from '@/components/Feedback';
import { Modal } from '@/components/Modal';
import { TextInput, TextArea } from '@/components/Form';
import { Icon } from '@/components/Icon';
import { useDebounce } from '@/lib/useDebounce';

export default function PoliciesPage(): JSX.Element {
  const user = useStore((s) => s.user);
  const [search, setSearch] = useState('');
  const [compare, setCompare] = useState<Jurisdiction[]>([]);
  const [jurisdictionQuery, setJurisdictionQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const debouncedSearch = useDebounce(search, 150);
  const debouncedJq = useDebounce(jurisdictionQuery, 150);
  const queryClient = useQueryClient();

  const comparing = compare.length > 0;
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['policies', debouncedSearch, compare.map((c) => c.id).join(',')],
    queryFn: () =>
      comparing
        ? get<{ items: Policy[] }>(`/policies/timeline?jurisdictions=${compare.map((c) => c.id).join(',')}`)
        : get<Paginated<Policy>>(`/policies?pageSize=100${debouncedSearch ? `&q=${encodeURIComponent(debouncedSearch)}` : ''}`),
  });

  const { data: jurisdictionMatches } = useQuery({
    queryKey: ['jurisdictions', debouncedJq],
    queryFn: () => get<{ items: Jurisdiction[] }>(`/jurisdictions?q=${encodeURIComponent(debouncedJq)}`),
    enabled: debouncedJq.length > 1,
  });

  const items: Policy[] = data ? ('items' in data ? data.items : []) : [];
  const grouped = comparing
    ? compare.map((j) => ({ jurisdiction: j, policies: items.filter((p) => p.jurisdictionId === j.id) }))
    : null;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Policy timelines</h1>
          <p className="text-sm text-secondary">How surveillance governance evolves, jurisdiction by jurisdiction. Compare up to 4 side by side.</p>
        </div>
        {user && user.role !== 'viewer' ? (
          <button type="button" className="btn btn-primary" onClick={() => setAddOpen(true)}>
            <Icon name="plus" size={16} /> Add policy
          </button>
        ) : null}
      </div>

      <div className="row-wrap" style={{ marginBottom: 'var(--space-md)' }}>
        <input className="input" style={{ maxWidth: 300 }} type="search" placeholder="Search policy text…" aria-label="Search policies" value={search} onChange={(e) => setSearch(e.target.value)} disabled={comparing} />
        <div style={{ position: 'relative' }}>
          <input className="input" style={{ maxWidth: 280 }} type="search" placeholder="Add jurisdiction to compare…" aria-label="Add jurisdiction to comparison" value={jurisdictionQuery} onChange={(e) => setJurisdictionQuery(e.target.value)} />
          {debouncedJq.length > 1 && (jurisdictionMatches?.items ?? []).length > 0 ? (
            <div className="menu" style={{ top: '100%', left: 0 }}>
              {(jurisdictionMatches?.items ?? []).slice(0, 6).map((j) => (
                <button
                  key={j.id}
                  type="button"
                  onClick={() => {
                    if (compare.length < 4 && !compare.some((c) => c.id === j.id)) setCompare([...compare, j]);
                    setJurisdictionQuery('');
                  }}
                >
                  {j.name} <span className="text-xs text-secondary">({j.type})</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {compare.map((j) => (
          <button key={j.id} type="button" className="chip" aria-pressed="true" onClick={() => setCompare(compare.filter((c) => c.id !== j.id))}>
            {j.name} <Icon name="x" size={14} />
          </button>
        ))}
      </div>

      {isLoading ? (
        <Skeleton count={6} height={36} />
      ) : error ? (
        <ErrorState message={(error as Error).message} onRetry={() => void refetch()} />
      ) : comparing && grouped ? (
        <div className="grid-2">
          {grouped.map(({ jurisdiction, policies }) => (
            <div key={jurisdiction.id} className="card">
              <h2 style={{ marginBottom: 'var(--space-md)' }}>{jurisdiction.name}</h2>
              {policies.length === 0 ? (
                <p className="text-sm text-secondary">No recorded policies — a transparency gap worth investigating.</p>
              ) : (
                <div className="timeline">
                  {policies.map((p) => (
                    <PolicyItem key={p.id} policy={p} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState title="No policies found" hint="Try a different search, or add the first policy for a jurisdiction." />
      ) : (
        <div className="timeline">
          {items.map((p) => (
            <PolicyItem key={p.id} policy={p} showJurisdiction />
          ))}
        </div>
      )}

      {addOpen ? (
        <AddPolicyModal
          onClose={() => setAddOpen(false)}
          onCreated={() => {
            setAddOpen(false);
            void queryClient.invalidateQueries({ queryKey: ['policies'] });
          }}
        />
      ) : null}
    </div>
  );
}

function PolicyItem({ policy, showJurisdiction }: { policy: Policy; showJurisdiction?: boolean }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="timeline-item">
      <div className="text-xs text-secondary">{fmtDate(policy.effectiveDate)}</div>
      <h3 className="text-sm" style={{ marginTop: 2 }}>
        {policy.title}
        {showJurisdiction && policy.jurisdictionName ? <span className="text-secondary"> — {policy.jurisdictionName}</span> : null}
      </h3>
      <p className="text-sm text-secondary" style={{ marginTop: 4 }}>
        {expanded ? policy.content : `${policy.content.slice(0, 220)}${policy.content.length > 220 ? '…' : ''}`}
      </p>
      <div className="row" style={{ marginTop: 4 }}>
        {policy.content.length > 220 ? (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
            {expanded ? 'Show less' : 'Read more'}
          </button>
        ) : null}
        {policy.sourceUrl ? (
          <a className="btn btn-sm btn-ghost" href={policy.sourceUrl} target="_blank" rel="noreferrer">
            Source ↗
          </a>
        ) : null}
      </div>
    </div>
  );
}

function AddPolicyModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }): JSX.Element {
  const toast = useStore((s) => s.toast);
  const [title, setTitle] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [content, setContent] = useState('');
  const [jurisdictionQuery, setJurisdictionQuery] = useState('');
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction | null>(null);
  const [busy, setBusy] = useState(false);
  const debouncedJq = useDebounce(jurisdictionQuery, 150);

  const { data: matches } = useQuery({
    queryKey: ['jurisdictions', debouncedJq],
    queryFn: () => get<{ items: Jurisdiction[] }>(`/jurisdictions?q=${encodeURIComponent(debouncedJq)}`),
    enabled: debouncedJq.length > 1 && !jurisdiction,
  });

  const submit = async () => {
    if (!jurisdiction || !title.trim() || !effectiveDate || content.trim().length < 20) {
      toast('Fill in jurisdiction, title, effective date, and a meaningful summary.', 'warning');
      return;
    }
    setBusy(true);
    try {
      await post('/policies', {
        jurisdictionId: jurisdiction.id,
        title: title.trim(),
        effectiveDate,
        sourceUrl: sourceUrl.trim() || null,
        content: content.trim(),
      });
      toast('Policy added to the timeline.', 'success');
      onCreated();
    } catch (err) {
      toast((err as ApiError).message, 'error', 7000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add policy"
      onClose={onClose}
      large
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Add policy'}
          </button>
        </>
      }
    >
      <TextInput label="Jurisdiction" value={jurisdiction ? jurisdiction.name : jurisdictionQuery} onChange={(e) => { setJurisdiction(null); setJurisdictionQuery(e.target.value); }} hint={jurisdiction ? 'selected' : 'Required'} />
      {!jurisdiction && (matches?.items ?? []).length > 0 ? (
        <div className="col" style={{ gap: 2, marginTop: -8, marginBottom: 'var(--space-sm)' }}>
          {(matches?.items ?? []).slice(0, 5).map((j) => (
            <button key={j.id} type="button" className="btn btn-sm btn-ghost" style={{ justifyContent: 'flex-start' }} onClick={() => setJurisdiction(j)}>
              {j.name} <span className="text-xs text-secondary">({j.type})</span>
            </button>
          ))}
        </div>
      ) : null}
      <TextInput label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Surveillance Technology Oversight Ordinance" />
      <div className="field">
        <label htmlFor="policy-date">Effective date</label>
        <input id="policy-date" type="date" className="input" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
      </div>
      <TextInput label="Source URL" type="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="Link to the ordinance/legislation text" />
      <TextArea label="Summary" value={content} onChange={(e) => setContent(e.target.value)} rows={6} placeholder="What does this policy require, prohibit, or enable?" />
    </Modal>
  );
}
