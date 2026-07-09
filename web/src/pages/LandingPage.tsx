import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import { useStore } from '@/lib/store';
import { Icon, type IconName } from '@/components/Icon';
import { FAQ } from '@/data/faq';

/**
 * The public front door at `/` — a marketing page for the product that never
 * says anything the product doesn't do. Signed-in visitors skip straight to
 * the map. Every claim below is backed by shipped behavior; when editing,
 * verify against the code before strengthening any sentence.
 */

interface PublicStats {
  documentedAssets: number;
  foiaRequests: number;
  procurementRecords: number;
  policiesTracked: number;
  statuteJurisdictions: number;
}

const CAPABILITIES: Array<{ icon: IconName; title: string; body: string }> = [
  {
    icon: 'map',
    title: 'A map with receipts',
    body: 'Every documented device carries its sources, photos and records, a confidence score you can tap to see explained, and a permanent change history. Clustering and a heat view keep city-scale patterns readable.',
  },
  {
    icon: 'mail',
    title: 'FOIA that cites the right law',
    body: 'The request builder fills in the correct public-records statute and required language for federal agencies, all 50 states, D.C., and the U.S. territories — then computes the legal response deadline and reminds you before it lapses.',
  },
  {
    icon: 'file-text',
    title: 'Follow the procurement money',
    body: 'Upload an RFP or contract and the parser extracts the vendor, amounts, and technology terms. Nothing publishes automatically — a person reviews every extraction before it becomes part of the record.',
  },
  {
    icon: 'scale',
    title: 'Policy, in context',
    body: 'Ordinances, moratoria, and oversight rules on a timeline per jurisdiction — comparable up to four side by side, and linked to the mapped devices they govern.',
  },
  {
    icon: 'download',
    title: 'Exports built to be cited',
    body: 'CSV for analysis, GeoJSON and KML for mapping tools, and finished PDF or HTML reports that include methodology and provenance notes. Downloads travel over signed links that expire after 72 hours.',
  },
  {
    icon: 'users',
    title: 'Workspaces for teams',
    body: 'Shared FOIA tracking, discussion, and saved map views with viewer, editor, and admin roles. Access is deny-by-default across workspaces.',
  },
];

const TRUST_POINTS: Array<{ icon: IconName; title: string; body: string }> = [
  {
    icon: 'eye',
    title: 'Provenance on everything',
    body: 'Records show where they came from — community documentation, labeled open datasets, or public records — and the confidence score explains itself rather than asking for trust.',
  },
  {
    icon: 'shield',
    title: 'History that cannot be rewritten',
    body: 'Changes append; they never overwrite. Disputes are public and answerable, and their resolutions become part of the record.',
  },
  {
    icon: 'check',
    title: 'Humans gate what publishes',
    body: 'Parsed procurement data, statute-change proposals from the weekly source recheck, and anything flagged for personal information all wait for human review before they reach the public record.',
  },
  {
    icon: 'link',
    title: 'Open data, credited',
    body: 'Imported observations from Will Freeman’s DeFlock and OpenStreetMap are clearly labeled and keep their ODbL license — in the app and in every export.',
  },
];

const SECURITY_POINTS: Array<{ title: string; body: string }> = [
  {
    title: 'Accounts worth trusting',
    body: 'Passwords are stored only as scrypt hashes. Two-factor authentication (TOTP) with one-time recovery codes is built in, and account recovery is designed so an outsider cannot learn whether an address is registered.',
  },
  {
    title: 'A hardened surface',
    body: 'Strict Content-Security-Policy, rate limits on sensitive routes, idempotent writes, and text inputs screened for personal information before they publish.',
  },
  {
    title: 'Your data stays yours',
    body: 'Data minimization by default: an email (a pseudonym is fine), a password hash, and your contributions. Download everything or delete your account from Settings — no email required, no waiting period.',
  },
  {
    title: 'Nothing to take on faith',
    body: 'The entire product is open source under AGPL-3.0. Run your own instance, audit the code, or verify that this page matches the software it describes.',
  },
];

function BndrMark(): JSX.Element {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="bndr-word" aria-label="BNDR">BNDR</span>;
  return <img src="/brand/bndr.png" alt="BNDR" className="bndr-logo" loading="lazy" onError={() => setFailed(true)} />;
}

function StatTile({ value, label }: { value: number; label: string }): JSX.Element {
  return (
    <div className="landing-stat">
      <strong>{value.toLocaleString()}</strong>
      <span>{label}</span>
    </div>
  );
}

export default function LandingPage(): JSX.Element {
  const user = useStore((s) => s.user);
  const authReady = useStore((s) => s.authReady);

  const { data: stats } = useQuery({
    queryKey: ['public-stats'],
    queryFn: () => get<PublicStats>('/stats'),
    staleTime: 300_000,
  });

  useEffect(() => {
    document.title = 'Lens of Light — See the cameras. Cite the law. Follow the money.';
    return () => {
      document.title = 'Lens of Light — Surveillance Transparency Navigator';
    };
  }, []);

  if (authReady && user) return <Navigate to="/map" replace />;

  return (
    <div className="landing">
      <header className="landing-nav">
        <Link to="/" className="landing-brand">
          <Icon name="eye" tone="gold" size={22} glow />
          <span>Lens of Light</span>
        </Link>
        <nav className="landing-nav-links" aria-label="Landing sections">
          <a href="#capabilities">Capabilities</a>
          <a href="#trust">Method</a>
          <a href="#security">Security</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div className="row" style={{ gap: 'var(--space-xs)' }}>
          <Link to="/login" className="btn btn-sm btn-ghost">Sign in</Link>
          <Link to="/map" className="btn btn-sm btn-primary">Open the map</Link>
        </div>
      </header>

      <section className="landing-hero">
        <p className="kicker">Public-interest surveillance transparency</p>
        <h1>
          See the cameras. Cite the law. <em>Follow the money.</em>
        </h1>
        <p className="landing-sub">
          Lens of Light maps documented surveillance infrastructure, writes public-records requests that cite the
          correct statute for every U.S. jurisdiction, and connects the procurement paper trail — with provenance on
          every record and a confidence score that explains itself.
        </p>
        <div className="row landing-cta">
          <Link to="/map" className="btn btn-primary btn-lg">
            <Icon name="map" size={18} /> Open the live map
          </Link>
          <Link to="/signup" className="btn btn-lg">
            Create a free account
          </Link>
        </div>
        <p className="text-xs text-secondary landing-trustline">
          Browsing needs no account · Open source (AGPL-3.0) · No ad trackers
        </p>

        {stats ? (
          <div className="landing-stats" aria-label="Live platform statistics">
            <StatTile value={stats.documentedAssets} label="Documented devices" />
            <StatTile value={stats.statuteJurisdictions} label="Jurisdictions with statute coverage" />
            <StatTile value={stats.foiaRequests} label="Records requests tracked" />
            <StatTile value={stats.procurementRecords} label="Procurement records" />
            <StatTile value={stats.policiesTracked} label="Policies tracked" />
          </div>
        ) : null}

        <div className="landing-shot-frame">
          <img
            src="/marketing/map-hero.jpg"
            alt="The Lens of Light map: clustered surveillance devices across the United States with the technology legend and map tools visible"
            className="landing-shot"
            loading="lazy"
            onError={(e) => {
              (e.target as HTMLImageElement).closest('.landing-shot-frame')?.remove();
            }}
          />
        </div>
      </section>

      <section className="landing-section" id="capabilities">
        <h2>Built end-to-end for the investigation</h2>
        <p className="landing-section-sub">
          From the device on the pole to the contract that paid for it and the ordinance that governs it.
        </p>
        <div className="landing-grid">
          {CAPABILITIES.map((c) => (
            <div key={c.title} className="card col landing-cap">
              <Icon name={c.icon} size={26} />
              <h3>{c.title}</h3>
              <p className="text-sm text-secondary">{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section" id="trust">
        <h2>Method before claims</h2>
        <p className="landing-section-sub">
          A transparency tool has to earn the standard it holds others to.
        </p>
        <div className="landing-grid landing-grid-2">
          {TRUST_POINTS.map((t) => (
            <div key={t.title} className="card col landing-cap">
              <Icon name={t.icon} size={24} tone={t.icon === 'check' ? 'jade' : undefined} />
              <h3>{t.title}</h3>
              <p className="text-sm text-secondary">{t.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section" id="security">
        <h2>Security &amp; privacy, specifically</h2>
        <p className="landing-section-sub">
          Not adjectives — mechanisms. Each of these is verifiable in the source.
        </p>
        <div className="landing-grid landing-grid-2">
          {SECURITY_POINTS.map((s) => (
            <div key={s.title} className="card col landing-cap">
              <h3>{s.title}</h3>
              <p className="text-sm text-secondary">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section" id="faq">
        <h2>Common questions</h2>
        <div className="col" style={{ gap: 'var(--space-sm)' }}>
          {FAQ.map((item) => (
            <div key={item.q} className="card col" style={{ gap: 'var(--space-xxs)' }}>
              <h3>{item.q}</h3>
              <p className="text-sm text-secondary">{item.a}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-final">
        <h2>Built for consequential work</h2>
        <p className="landing-section-sub">
          Journalists, researchers, organizers, and neighbors use the same tools here. Start with the map — no account
          needed — and sign up when you want to contribute or track requests.
        </p>
        <div className="row landing-cta" style={{ justifyContent: 'center' }}>
          <Link to="/map" className="btn btn-primary btn-lg">
            <Icon name="map" size={18} /> Open the live map
          </Link>
          <Link to="/help" className="btn btn-lg">See how it works</Link>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-footer-brand">
          <BndrMark />
          <p className="text-xs text-secondary">
            An independent public-interest tool by BNDR. Not affiliated with, endorsed by, or connected to any
            surveillance vendor; vendor and product names appear only to identify equipment.
          </p>
        </div>
        <nav className="landing-footer-links" aria-label="Footer">
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
          <Link to="/support">Support</Link>
          <Link to="/help">Help</Link>
          <a href="/docs" target="_blank" rel="noreferrer">API reference</a>
        </nav>
        <p className="text-xs text-secondary landing-footer-credits">
          Open source under AGPL-3.0. Imported open data:{' '}
          <a href="https://deflock.me" target="_blank" rel="noopener noreferrer">DeFlock</a> and{' '}
          <a href="https://www.openstreetmap.org" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>{' '}
          contributors (ODbL). Statute citations are informational, not legal advice.
        </p>
      </footer>
    </div>
  );
}
