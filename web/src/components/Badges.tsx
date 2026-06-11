import { useState } from 'react';
import { confidenceLabel, type ConfidenceFactor } from '@stn/shared';
import { Modal } from './Modal';

const TONE_BY_LABEL: Record<string, string> = {
  high: 'success',
  medium: 'accent',
  low: 'warning',
  unverified: 'danger',
};

/** Confidence score badge with tap-to-explain provenance breakdown. */
export function ConfidenceBadge({
  score,
  factors,
  compact,
}: {
  score: number;
  factors?: ConfidenceFactor[];
  compact?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const label = confidenceLabel(score);
  return (
    <>
      <button
        type="button"
        className="pill"
        data-tone={TONE_BY_LABEL[label]}
        onClick={factors && factors.length > 0 ? () => setOpen(true) : undefined}
        style={{ cursor: factors?.length ? 'pointer' : 'default', background: 'none' }}
        aria-label={`Confidence ${score} out of 100 (${label}). ${factors?.length ? 'Activate to see why.' : ''}`}
        title={factors?.length ? 'Why this score?' : undefined}
      >
        {score} {compact ? '' : `· ${label}`}
      </button>
      {open && factors ? (
        <Modal title={`Confidence: ${score}/100`} onClose={() => setOpen(false)}>
          <p className="text-sm text-secondary" style={{ marginBottom: 'var(--space-sm)' }}>
            Scores are computed from provenance signals and recomputed automatically when evidence, verification, or
            disputes change. Every factor is shown — nothing is hidden.
          </p>
          <div className="col" style={{ gap: 'var(--space-xs)' }}>
            {factors.map((f, i) => (
              <div key={i} className="row" style={{ alignItems: 'flex-start' }}>
                <span
                  className="pill"
                  data-tone={f.delta > 0 ? 'success' : f.delta < 0 ? 'danger' : 'muted'}
                  style={{ minWidth: 52, justifyContent: 'center' }}
                >
                  {f.delta > 0 ? `+${f.delta}` : f.delta}
                </span>
                <span className="text-sm">{f.note}</span>
              </div>
            ))}
          </div>
        </Modal>
      ) : null}
    </>
  );
}

const STATUS_TONES: Record<string, string> = {
  active: 'success',
  proposed: 'warning',
  retired: 'muted',
  removed: 'muted',
  unverified: 'danger',
  draft: 'muted',
  sent: 'accent',
  acknowledged: 'accent',
  response: 'success',
  appeal: 'warning',
  closed: 'muted',
  fulfilled: 'success',
  partial: 'warning',
  denied: 'danger',
  withdrawn: 'muted',
  open: 'warning',
  under_review: 'accent',
  accepted: 'success',
  rejected: 'danger',
  queued: 'muted',
  processing: 'accent',
  completed: 'success',
  failed: 'danger',
  expired: 'muted',
  needs_review: 'warning',
  approved: 'success',
  verified: 'success',
  pending: 'warning',
  clean: 'success',
  quarantined: 'danger',
  flagged: 'warning',
  suspended: 'danger',
  running: 'accent',
}

export function StatusPill({ status }: { status: string }): JSX.Element {
  return (
    <span className="pill" data-tone={STATUS_TONES[status] ?? 'muted'}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export function VerificationBadge({ status }: { status: string | null | undefined }): JSX.Element {
  if (status === 'verified') {
    return (
      <span className="pill" data-tone="success" title="This source passed registry verification">
        verified source
      </span>
    );
  }
  return (
    <span className="pill" data-tone={status === 'rejected' ? 'danger' : 'warning'} title="This record's source has not completed verification — treat with care">
      {status === 'rejected' ? 'source rejected' : 'unverified'}
    </span>
  );
}
