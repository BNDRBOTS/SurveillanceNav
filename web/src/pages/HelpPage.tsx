import { Link, useNavigate } from 'react-router-dom';
import { TOURS } from '@/lib/tours';
import { Icon, type IconName } from '@/components/Icon';

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

const FAQ: Array<{ q: string; a: JSX.Element | string }> = [
  {
    q: 'Where does the map data come from?',
    a: (
      <>
        Three places: community members documenting devices from public space, imported open datasets (De-Flock /
        OpenStreetMap, clearly labeled and ODbL-licensed), and public records — procurement documents and FOIA
        responses. Every record shows its sources, and the confidence score tells you how well-corroborated it is.
        Tap any score to see exactly why it is what it is.
      </>
    ),
  },
  {
    q: 'A record about my street is wrong. How do I fix it?',
    a: (
      <>
        Open the record on the <Link to="/map">map</Link> and use <strong>Dispute</strong>. Attach whatever you can —
        a photo of the empty pole, a decommission notice. Curators are required to respond, and the resolution becomes
        permanent public history on that record.
      </>
    ),
  },
  {
    q: 'Is camera avoidance guaranteed?',
    a: (
      <>
        Honesty matters here: it depends on the routing engine available, and the label on your route tells you which
        you got. <strong>Guaranteed</strong> means the engine hard-excluded known camera zones.{' '}
        <strong>Best effort</strong> means the route was steered away where possible but not strictly. And it only
        covers cameras <em>we know about</em> — an empty database means an uncovered street, not a safe one.
      </>
    ),
  },
  {
    q: 'Does it work offline?',
    a: (
      <>
        Yes. The basemap is bundled with the app, data you have seen is cached with integrity checks, and anything you
        submit while offline is queued and synced automatically when you reconnect. Install it from your browser menu
        (&ldquo;Add to Home Screen&rdquo;) for the full experience.
      </>
    ),
  },
  {
    q: 'What do you collect about me?',
    a: (
      <>
        As little as a working account needs: email (a pseudonym is fine), a password we only store as a hash, and your
        contributions. No trackers, no ad IDs, no selling data, no AI training on your content. The complete inventory
        is on the <Link to="/privacy">privacy page</Link>, and you can download or delete everything from{' '}
        <Link to="/settings">Settings</Link>.
      </>
    ),
  },
  {
    q: 'Can I use this data in my reporting?',
    a: (
      <>
        That is what it is for. Use <Link to="/reports">Reports &amp; exports</Link> to pull CSV for analysis, GeoJSON
        for your graphics desk, or a finished PDF/HTML report with methodology and provenance notes you can cite.
        Imported open data keeps its original license — exports label it.
      </>
    ),
  },
];

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
