import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DISCLAIMER_VERSIONS } from '@stn/shared';
import { get, post } from '@/lib/api';
import { useStore } from '@/lib/store';
import { Modal } from './Modal';

/**
 * Mandatory first-entry disclaimer: shown once before any use of the data
 * product (and again only when the disclaimer version is bumped). Anonymous
 * acceptance lives on the device; signed-in acceptance is recorded
 * server-side with version + timestamp. Legal/auth pages stay reachable so
 * people can read what they're agreeing to.
 */

const EXEMPT_PATHS = new Set(['/', '/login', '/signup', '/reset-password', '/privacy', '/terms', '/support', '/invite']);

const LS_KEY = 'stn.ack.entry';

interface AckList {
  items: Array<{ key: string; version: number; acceptedAt: string }>;
}

export function EntryGate(): JSX.Element | null {
  const location = useLocation();
  const user = useStore((s) => s.user);
  const authReady = useStore((s) => s.authReady);
  const queryClient = useQueryClient();
  const [localVersion, setLocalVersion] = useState<number>(() => Number(localStorage.getItem(LS_KEY) ?? 0));
  const [busy, setBusy] = useState(false);

  const { data: acks } = useQuery({
    queryKey: ['acknowledgments'],
    queryFn: () => get<AckList>('/users/me/acknowledgments'),
    enabled: !!user,
    staleTime: Infinity,
  });

  // A signed-in user whose server record already carries the current version
  // shouldn't be re-gated on a new device — mirror it locally.
  const serverAccepted = !!acks?.items.some((a) => a.key === 'entry' && a.version >= DISCLAIMER_VERSIONS.entry);
  useEffect(() => {
    if (serverAccepted && localVersion < DISCLAIMER_VERSIONS.entry) {
      localStorage.setItem(LS_KEY, String(DISCLAIMER_VERSIONS.entry));
      setLocalVersion(DISCLAIMER_VERSIONS.entry);
    }
  }, [serverAccepted, localVersion]);

  if (!authReady) return null;
  if (EXEMPT_PATHS.has(location.pathname)) return null;
  if (localVersion >= DISCLAIMER_VERSIONS.entry || serverAccepted) return null;
  if (user && !acks) return null; // ack list still loading — don't flash the gate

  const accept = async () => {
    setBusy(true);
    try {
      if (user) {
        await post('/users/me/acknowledgments', { key: 'entry', version: DISCLAIMER_VERSIONS.entry });
        void queryClient.invalidateQueries({ queryKey: ['acknowledgments'] });
      }
    } catch {
      // server refusal (stale version) forces a reload path; local ack still
      // withheld so the gate returns with fresh copy
      setBusy(false);
      return;
    }
    localStorage.setItem(LS_KEY, String(DISCLAIMER_VERSIONS.entry));
    setLocalVersion(DISCLAIMER_VERSIONS.entry);
    setBusy(false);
  };

  return (
    <Modal title="Before you use this tool" onClose={() => undefined} dismissable={false} hideClose large>
      <div className="col" style={{ gap: 'var(--space-sm)' }}>
        <p className="text-sm">
          <strong>What this is.</strong> Lens of Light documents surveillance <em>infrastructure</em> — cameras,
          license plate readers, and similar systems observable from public space — for journalism, research,
          advocacy, and civic oversight. It documents equipment, never people.
        </p>
        <p className="text-sm">
          <strong>Independence.</strong> This project is not affiliated with, endorsed by, or sponsored by Flock
          Safety or any surveillance vendor, government agency, or law-enforcement body. Product and company names
          appear only to identify the equipment being documented (nominative use).
        </p>
        <p className="text-sm">
          <strong>Acceptable use.</strong> You are responsible for how you use this tool and for complying with the
          laws of your jurisdiction. It may not be used to harass or target people (including equipment operators),
          to vandalize or interfere with equipment, to obstruct law enforcement, or to further any unlawful act.
          Violations forfeit access.
        </p>
        <p className="text-sm">
          <strong>Accuracy.</strong> Records are community-sourced and partly imported from open datasets
          (De-Flock / OpenStreetMap, ODbL). Cameras move, retire, and get missed: data may be incomplete, outdated,
          or wrong, and is provided <em>as is</em>, without warranty. Confidence scores are estimates. Nothing here
          is legal advice — verify independently before relying on it.
        </p>
        <p className="text-xs text-secondary">
          Full terms: <Link to="/terms">Terms of use</Link> · <Link to="/privacy">Privacy &amp; data practices</Link>.
          Acknowledging records the current disclaimer version{user ? ' on your account' : ' on this device'}.
        </p>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 'var(--space-md)' }}>
        <button type="button" className="btn btn-primary" onClick={() => void accept()} disabled={busy}>
          {busy ? 'Recording…' : 'I understand and accept'}
        </button>
      </div>
    </Modal>
  );
}
