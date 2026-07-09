import { Link } from 'react-router-dom';
import { useStore } from '@/lib/store';
import { submitErrorReport } from '@/lib/errorReport';

/**
 * Persistent responsibility notice — the compact companion to the entry
 * disclaimer. Rides under statute-bearing surfaces and at the foot of the
 * side navigation: the user owns how they use the tool, testing is ongoing,
 * and problems have a one-tap report path (kind depends on the surface).
 */
export function LegalNotice({
  kind = 'content',
  context,
  style,
}: {
  kind?: 'statute' | 'content';
  context?: string;
  style?: React.CSSProperties;
}): JSX.Element {
  const toast = useStore((s) => s.toast);

  const report = async () => {
    try {
      const confirmation = await submitErrorReport({
        kind,
        message: kind === 'statute' ? 'User flagged statute/deadline information' : 'User flagged content on this page',
        detail: context ? { context } : {},
      });
      toast(confirmation, 'success', 6000);
    } catch {
      toast('Could not submit the report — check your connection and try again.', 'warning', 6000);
    }
  };

  return (
    <p className="text-xs text-secondary legal-notice" style={style}>
      {kind === 'statute'
        ? 'Citations and deadlines are informational, not legal advice — verify before relying on them. '
        : 'You are responsible for how you use this tool. It is tested rigorously and continuously — '}
      <button type="button" className="legal-notice-link" onClick={() => void report()}>
        report an issue
      </button>{' '}
      · <Link to="/terms">terms</Link>
    </p>
  );
}
