import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { Modal } from '@/components/Modal';

export function PrivacyPage(): JSX.Element {
  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <h1>Privacy & data practices</h1>
      <p className="text-sm text-secondary" style={{ margin: 'var(--space-sm) 0 var(--space-lg)' }}>
        A transparency platform must be transparent about itself. This page is the plain-language, complete inventory.
      </p>
      <div className="col">
        <div className="card col">
          <h2>What we collect & why</h2>
          <dl className="kv">
            <dt>Email + name</dt>
            <dd>Sign-in, workspace invitations, and deadline reminders. A pseudonym is fine.</dd>
            <dt>Password</dt>
            <dd>Stored only as an scrypt hash — we cannot read it.</dd>
            <dt>Consent choices</dt>
            <dd>Recorded with timestamps so you can verify what you agreed to.</dd>
            <dt>Contributions</dt>
            <dd>Map records, evidence, disputes, comments — attributed to you until you delete your account.</dd>
            <dt>Security logs</dt>
            <dd>Sign-ins and data changes (with IP) in an append-only audit trail to protect data integrity.</dd>
          </dl>
          <p className="text-sm text-secondary">
            We do <strong>not</strong> collect advertising identifiers, run third-party trackers, sell data, or train AI
            models on your content.
          </p>
        </div>
        <div className="card col">
          <h2>Retention</h2>
          <dl className="kv">
            <dt>Account data</dt>
            <dd>While the account is active; anonymized within 30 days of deletion.</dd>
            <dt>Exports</dt>
            <dd>Generated files auto-delete after 72 hours.</dd>
            <dt>Audit logs</dt>
            <dd>2 years, then archived to cold storage and pruned.</dd>
            <dt>Offline caches</dt>
            <dd>On your device only; clearable in Settings; integrity-checked on restore.</dd>
          </dl>
          <p className="text-sm text-secondary">Retention is enforced by an automatic daily job — not by promises.</p>
        </div>
        <div className="card col">
          <h2>Your rights (GDPR / CCPA-ready)</h2>
          <ul className="text-sm" style={{ paddingLeft: 'var(--space-lg)' }}>
            <li>
              <strong>Access / portability</strong> — download everything from <Link to="/settings">Settings → Download my data</Link>.
            </li>
            <li>
              <strong>Deletion</strong> — one click in Settings; contributions are de-attributed, not silently rewritten.
            </li>
            <li>
              <strong>Rectification</strong> — edit your profile anytime; dispute any record about a place.
            </li>
            <li>
              <strong>No dark patterns</strong> — every consent is opt-in and revocable.
            </li>
          </ul>
        </div>
        <div className="card col">
          <h2>Community safety rules</h2>
          <p className="text-sm text-secondary">
            This platform documents <em>infrastructure</em>, not people. Submissions must come from public space and may
            not contain faces, license plates, home interiors, or personal information. Uploads are scanned for malware
            and PII; flagged files are held for human review and never published automatically.
          </p>
        </div>
      </div>
    </div>
  );
}

export function TermsPage(): JSX.Element {
  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <h1>Terms &amp; acceptable use</h1>
      <p className="text-sm text-secondary" style={{ margin: 'var(--space-sm) 0 var(--space-lg)' }}>
        Plain-language terms for using Lens of Light. By creating an account or contributing, you agree to these.
      </p>
      <div className="col">
        <div className="card col">
          <h2>What this platform is for</h2>
          <p className="text-sm text-secondary">
            Lens of Light is a public-interest tool for mapping and understanding surveillance <em>infrastructure</em> —
            cameras, license plate readers, and similar systems in public space. Use it for journalism, research,
            advocacy, oversight, and personal awareness.
          </p>
        </div>
        <div className="card col">
          <h2>Acceptable use</h2>
          <ul className="text-sm" style={{ paddingLeft: 'var(--space-lg)' }}>
            <li>Document <strong>infrastructure, not people</strong> — no faces, license plates, home interiors, or personal information.</li>
            <li>No harassment, stalking, doxxing, or targeting of individuals, including equipment operators.</li>
            <li>Contribute only observations from <strong>public space</strong> that you have the right to share.</li>
            <li>Follow the law in your jurisdiction; never use the platform to facilitate harm or illegal activity.</li>
            <li>Don't scrape, overload, or attempt to defeat the service or its security controls.</li>
          </ul>
          <p className="text-sm text-secondary">Accounts that violate these may be suspended, and abusive content is removed.</p>
        </div>
        <div className="card col">
          <h2>Accuracy &amp; no warranty</h2>
          <p className="text-sm text-secondary">
            Data here is community-sourced and partly <strong>imported from open datasets</strong> (e.g. De-Flock /
            OpenStreetMap). It can be incomplete, out of date, or wrong, and confidence scores are estimates, not
            guarantees. The platform is provided <strong>&ldquo;as is,&rdquo; without warranties</strong> — verify
            anything important independently. Nothing here is legal advice.
          </p>
        </div>
        <div className="card col">
          <h2>Your contributions</h2>
          <p className="text-sm text-secondary">
            You keep ownership of what you submit. You confirm you have the right to share it and grant us a
            non-exclusive license to host, display, and distribute it as part of the public record (including in exports).
            Imported open data keeps its original license — OpenStreetMap-derived records are © OpenStreetMap contributors
            under the ODbL. Records stay attributed to you until you delete your account, after which they are
            de-attributed, not erased from the public record.
          </p>
        </div>
        <div className="card col">
          <h2>Liability</h2>
          <p className="text-sm text-secondary">
            Lens of Light is a transparency tool, not a substitute for your own judgment. To the maximum extent permitted
            by law, we are not liable for how the data is used or for damages arising from use of the platform.
          </p>
        </div>
        <div className="card col">
          <h2>Changes</h2>
          <p className="text-sm text-secondary">
            We may update these terms as the platform evolves; material changes will be noted in-app, and continued use
            means you accept them. To raise a concern, use the in-app report and dispute tools.
          </p>
        </div>
      </div>
    </div>
  );
}

export function NotFoundPage(): JSX.Element {
  return (
    <div className="auth-layout">
      <div className="card auth-card col" style={{ textAlign: 'center' }}>
        <h1>404</h1>
        <p className="text-sm text-secondary">That page doesn’t exist — maybe it was redacted.</p>
        <Link className="btn btn-primary" to="/map">
          Back to the map
        </Link>
      </div>
    </div>
  );
}

const TOUR_STEPS = [
  {
    title: 'Welcome to Lens of Light',
    body: 'Map, understand, and act on surveillance infrastructure. Everything you see carries provenance: sources, confidence scores, change history, and disputes.',
  },
  {
    title: 'The map is the front door',
    body: 'Filter by technology, status, source, and confidence. Tap any point for full provenance. Use Nearby for radius analysis and Views to save and share exact map states.',
  },
  {
    title: 'FOIA without the guesswork',
    body: 'The request builder cites the correct public-records statute for the jurisdiction and computes the legal response deadline when you mark a request sent. We remind you before it lapses.',
  },
  {
    title: 'Trust, verified',
    body: 'Confidence scores are explainable — tap any score to see exactly why. Disagree with a record? Dispute it with evidence; curators must respond, and the resolution is permanent public history.',
  },
  {
    title: 'Works offline',
    body: 'The basemap is bundled, data is cached with integrity checks, and submissions made offline are queued and synced automatically. Install the app from your browser menu for the full experience.',
  },
];

export function OnboardingPage(): JSX.Element {
  const [step, setStep] = useState(0);
  const navigate = useNavigate();
  const finish = () => {
    localStorage.setItem('stn.onboarded', 'true');
    navigate('/map');
  };
  const s = TOUR_STEPS[step]!;
  return (
    <Modal title={s.title} onClose={finish} dismissable>
      <p className="text-sm text-secondary" style={{ minHeight: 72 }}>
        {s.body}
      </p>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 'var(--space-md)' }}>
        <span className="text-xs text-secondary" aria-label={`Step ${step + 1} of ${TOUR_STEPS.length}`}>
          {step + 1} / {TOUR_STEPS.length}
        </span>
        <div className="row">
          <button type="button" className="btn btn-ghost btn-sm" onClick={finish}>
            Skip tour
          </button>
          {step > 0 ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStep(step - 1)}>
              Back
            </button>
          ) : null}
          <button type="button" className="btn btn-primary btn-sm" onClick={() => (step === TOUR_STEPS.length - 1 ? finish() : setStep(step + 1))}>
            {step === TOUR_STEPS.length - 1 ? 'Open the map' : 'Next'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
