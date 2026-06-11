import { Component, useEffect, type ReactNode } from 'react';
import { useStore, type Toast } from '@/lib/store';
import { announce } from '@/lib/announcer';

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
      <button type="button" onClick={() => dismiss(toast.id)} aria-label="Dismiss notification">
        ✕
      </button>
    </div>
  );
}

export function Toasts(): JSX.Element {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
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
}

export class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    console.error('UI error boundary caught:', error);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="auth-layout">
          <div className="card auth-card col" role="alert">
            <h2>Something went wrong</h2>
            <p className="text-sm text-secondary">
              The interface hit an unexpected error. Your data is safe — drafts and queued submissions are preserved
              locally.
            </p>
            <code className="text-xs text-secondary">{this.state.error.message}</code>
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
                Reload
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => this.setState({ error: null })}>
                Try to continue
              </button>
              <a
                className="btn btn-ghost"
                href={`mailto:support@stn.local?subject=STN%20error%20report&body=${encodeURIComponent(this.state.error.message)}`}
              >
                Report
              </a>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
