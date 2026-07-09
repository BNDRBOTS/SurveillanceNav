import { Component, useEffect, useState, type ReactNode } from 'react';
import { useStore, type Toast } from '@/lib/store';
import { announce } from '@/lib/announcer';
import { Icon } from '@/components/Icon';
import { CoachMark } from '@/components/CoachMark';

/* ------------------------------- toasts ------------------------------- */

function ToastItem({ toast }: { toast: Toast }): JSX.Element {
  const dismiss = useStore((s) => s.dismissToast);
  useEffect(() => {
    announce(toast.message);
    if (toast.ttlMs <= 0) return;
    const t = setTimeout(() => dismiss(toast.id), toast.ttlMs);
    return () => clearTimeout(t);
  }, [toast, dismiss]);
  return (
    <div className="toast" data-tone={toast.tone} role={toast.tone === 'error' ? 'alert' : 'status'}>
      <span style={{ flex: 1 }}>{toast.message}</span>
      {toast.action ? (
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => {
            toast.action!.run();
            dismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button type="button" onClick={() => dismiss(toast.id)} aria-label="Dismiss notification">
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}

/* --------------------------- walkthroughs ----------------------------- */

/**
 * Chooses the renderer for the active walkthrough step. On desktop, a step
 * with an `anchor` whose `[data-tour]` target is mounted gets the floating
 * coach-mark pointing at it; everything else (mobile, anchorless steps,
 * missing targets) falls back to the bottom card. The target lookup retries
 * over a few frames because tours start on page mount, often before the
 * anchored element has rendered.
 */
function WalkthroughHost(): JSX.Element | null {
  const wt = useStore((s) => s.walkthrough);
  const anchor = wt ? wt.steps[wt.index]?.anchor : undefined;
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 840);

  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth <= 840);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!anchor || narrow) {
      setTarget(null);
      return;
    }
    let raf = 0;
    let tries = 0;
    let cancelled = false;
    const look = (): void => {
      if (cancelled) return;
      const el = document.querySelector<HTMLElement>(`[data-tour="${anchor}"]`);
      if (el) {
        setTarget(el);
        return;
      }
      if (++tries < 24) raf = requestAnimationFrame(look);
      else setTarget(null);
    };
    setTarget(null);
    look();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [anchor, narrow, wt?.key, wt?.index]);

  if (!wt) return null;
  if (anchor && !narrow && target?.isConnected) return <CoachMark wt={wt} target={target} />;
  return <WalkthroughCard />;
}

/** Toast-styled guided tour card: step counter, Back/Next, skippable. */
function WalkthroughCard(): JSX.Element | null {
  const wt = useStore((s) => s.walkthrough);
  const advance = useStore((s) => s.advanceWalkthrough);
  const end = useStore((s) => s.endWalkthrough);
  useEffect(() => {
    if (wt) announce(`${wt.steps[wt.index]!.title}. ${wt.steps[wt.index]!.body}`);
  }, [wt]);
  if (!wt) return null;
  const step = wt.steps[wt.index]!;
  const last = wt.index === wt.steps.length - 1;
  return (
    <div className="toast walkthrough" role="status">
      <div className="col" style={{ gap: 'var(--space-xxs)', flex: 1 }}>
        <span className="kicker">
          Walkthrough · {wt.index + 1} / {wt.steps.length}
        </span>
        <strong>{step.title}</strong>
        <p className="text-sm text-secondary" style={{ margin: 0 }}>
          {step.body}
        </p>
        <div className="row" style={{ marginTop: 'var(--space-xs)', justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => end()}>
            Skip tour
          </button>
          {wt.index > 0 ? (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => advance(-1)}>
              Back
            </button>
          ) : null}
          <button type="button" className="btn btn-sm btn-primary" onClick={() => advance(1)}>
            {last ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
      <button type="button" onClick={() => end()} aria-label="Dismiss walkthrough">
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}

export function Toasts(): JSX.Element {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      <WalkthroughHost />
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}

/* ----------------------------- skeletons ------------------------------ */

export function Skeleton({ height = 16, width, count = 1 }: { height?: number; width?: string; count?: number }): JSX.Element {
  return (
    <div className="col" aria-hidden="true" style={{ gap: 'var(--space-xs)' }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" style={{ height, width: width ?? `${88 - ((i * 17) % 30)}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="empty">
      <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.8-3.8" strokeLinecap="round" />
      </svg>
      <h3>{title}</h3>
      {hint ? <p className="text-sm">{hint}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }): JSX.Element {
  return (
    <div className="empty" role="alert">
      <h3>Something didn’t load</h3>
      <p className="text-sm">{message}</p>
      {onRetry ? (
        <button type="button" className="btn btn-primary" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

/* --------------------------- error boundary --------------------------- */

interface BoundaryState {
  error: Error | null;
  reportState: 'idle' | 'sending' | 'done' | 'failed';
}

export class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { error: null, reportState: 'idle' };

  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    console.error('UI error boundary caught:', error);
  }

  private sendReport = async (): Promise<void> => {
    this.setState({ reportState: 'sending' });
    try {
      const { submitErrorReport } = await import('@/lib/errorReport');
      await submitErrorReport({
        kind: 'client_error',
        message: this.state.error?.message ?? 'Unknown UI error',
        detail: { errorChain: [String(this.state.error?.stack ?? '').slice(0, 300)] },
      });
      this.setState({ reportState: 'done' });
    } catch {
      this.setState({ reportState: 'failed' });
    }
  };

  override render(): ReactNode {
    if (this.state.error) {
      const { reportState } = this.state;
      return (
        <div className="auth-layout">
          <div className="card auth-card col" role="alert">
            <h2>Something went wrong</h2>
            <p className="text-sm text-secondary">
              The interface hit an unexpected error. Your data is safe — drafts and queued submissions are preserved
              locally.
            </p>
            <code className="text-xs text-secondary">{this.state.error.message}</code>
            <div className="row-wrap">
              <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
                Reload
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => this.setState({ error: null, reportState: 'idle' })}>
                Try to continue
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void this.sendReport()}
                disabled={reportState === 'sending' || reportState === 'done'}
              >
                {reportState === 'idle' && 'Send error report'}
                {reportState === 'sending' && 'Sending…'}
                {reportState === 'done' && 'Report sent'}
                {reportState === 'failed' && 'Retry report'}
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
