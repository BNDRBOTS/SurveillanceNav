import { Link, useNavigate } from 'react-router-dom';
import { TOURS } from '@/lib/tours';
import { Icon, type IconName } from '@/components/Icon';
import { FAQ } from '@/data/faq';

/**
 * The Help section: plain-language guide to every feature, with a
 * "Start walkthrough" launcher for each page's guided tour and answers to
 * the questions the public actually asks. Written for journalists,
 * organizers, and neighbors — not engineers.
 */

const TOUR_ICONS: Record<string, IconName> = {
  map: 'map',
  foia: 'mail',
  procurement: 'file-text',
  policies: 'scale',
  reports: 'download',
  workspaces: 'users',
  settings: 'shield',
};


export default function HelpPage(): JSX.Element {
  const navigate = useNavigate();
  return (
    <div className="page" style={{ maxWidth: 1080 }}>
      <div className="page-header">
        <div>
          <h1>Help &amp; walkthroughs</h1>
          <p className="text-sm text-secondary">
            Every feature, explained in plain language — with a guided tour you can replay any time.
          </p>
        </div>
      </div>

      <h2 style={{ marginBottom: 'var(--space-md)' }}>Guided tours</h2>
      <div className="grid-2" style={{ marginBottom: 'var(--space-xl)' }}>
        {Object.values(TOURS).map((tour) => (
          <div key={tour.key} className="card col" style={{ gap: 'var(--space-xs)' }}>
            <div className="row">
              <Icon name={TOUR_ICONS[tour.key] ?? 'compass'} size={22} />
              <h3>{tour.label}</h3>
            </div>
            <p className="text-sm text-secondary" style={{ flex: 1 }}>
              {tour.blurb}
            </p>
            <button
              type="button"
              className="btn btn-sm"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => navigate(`${tour.path}?tour=1`)}
            >
              <Icon name="play" size={14} /> Start walkthrough
            </button>
          </div>
        ))}
      </div>

      <h2 style={{ marginBottom: 'var(--space-md)' }}>Common questions</h2>
      <div className="col" style={{ marginBottom: 'var(--space-xl)' }}>
        {FAQ.map((item) => (
          <div key={item.q} className="card col" style={{ gap: 'var(--space-xxs)' }}>
            <h3>{item.q}</h3>
            <p className="text-sm text-secondary">{item.a}</p>
          </div>
        ))}
      </div>

      <div className="card col">
        <div className="row">
          <Icon name="life-buoy" size={22} />
          <h2>Still stuck?</h2>
        </div>
        <p className="text-sm text-secondary">
          The <Link to="/support">Support page</Link> lists ways to reach the project and how to fund the work. For a
          wrong map record, the fastest path is the Dispute tool on the record itself — it creates a public,
          answerable request rather than an email that can be lost.
        </p>
      </div>
    </div>
  );
}
