import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useStore } from '@/lib/store';
import { get, patch, post, del, ApiError } from '@/lib/api';
import { applySession, logout } from '@/lib/auth';
import { TextInput, PasswordInput } from '@/components/Form';
import { Icon } from '@/components/Icon';
import { ConfirmDialog } from '@/components/Modal';
import { clearDatasets } from '@/lib/offline';
import { useQuery } from '@tanstack/react-query';
import type { AuthTokens, UserPublic } from '@stn/shared';

export default function SettingsPage(): JSX.Element {
  const user = useStore((s) => s.user);
  const toast = useStore((s) => s.toast);
  const contrast = useStore((s) => s.contrast);
  const setContrast = useStore((s) => s.setContrast);
  const reducedMotion = useStore((s) => s.reducedMotion);
  const setReducedMotion = useStore((s) => s.setReducedMotion);
  const setUser = useStore((s) => s.setUser);
  const navigate = useNavigate();

  const [name, setName] = useState(user?.name ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [mfaSecret, setMfaSecret] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!user) {
    return (
      <div className="page">
        <p className="text-sm text-secondary">
          <Link to="/login">Sign in</Link> to manage your account. Appearance settings below apply to this device.
        </p>
        <AppearanceCard contrast={contrast} setContrast={setContrast} reducedMotion={reducedMotion} setReducedMotion={setReducedMotion} />
      </div>
    );
  }

  const saveProfile = async () => {
    setBusy(true);
    try {
      const updated = await patch<UserPublic>('/users/me', {
        ...(name !== user.name ? { name } : {}),
        ...(newPassword ? { currentPassword, newPassword } : {}),
      });
      setUser(updated);
      setCurrentPassword('');
      setNewPassword('');
      toast(newPassword ? 'Profile saved. Other sessions were signed out for safety.' : 'Profile saved.', 'success', 6000);
    } catch (err) {
      toast((err as ApiError).message, 'error', 7000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page" style={{ maxWidth: 880 }}>
      <div className="page-header">
        <h1>Settings & privacy</h1>
      </div>
      <div className="settings-grid">
        <div className="card col">
          <h2>Profile</h2>
          <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <TextInput label="Email" value={user.email} disabled hint="Email changes require account migration — contact an administrator" />
          <h3 className="text-sm text-secondary">Change password</h3>
          <PasswordInput label="Current password" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" />
          <PasswordInput label="New password" value={newPassword} onChange={setNewPassword} autoComplete="new-password" withMeter />
          <button type="button" className="btn btn-primary" onClick={saveProfile} disabled={busy} style={{ alignSelf: 'flex-start' }}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>

        <div className="card col">
          <h2>Multi-factor authentication</h2>
          {user.mfaEnabled ? (
            <p className="text-sm text-success"><Icon name="check" size={14} /> MFA is active on this account.</p>
          ) : mfaSecret ? (
            <>
              <p className="text-sm text-secondary">Add this secret to your authenticator app, then confirm a code:</p>
              <p className="mono card" style={{ wordBreak: 'break-all', userSelect: 'all', padding: 'var(--space-sm)' }}>
                {mfaSecret}
              </p>
              <div className="row-wrap" style={{ alignItems: 'flex-end' }}>
                <TextInput label="6-digit code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} inputMode="numeric" />
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ marginBottom: 'var(--space-md)' }}
                  disabled={mfaCode.length < 6}
                  onClick={async () => {
                    try {
                      const session = await post<AuthTokens>('/auth/mfa/verify', { code: mfaCode });
                      applySession(session);
                      setMfaSecret(null);
                      toast('MFA activated.', 'success');
                    } catch (err) {
                      toast((err as ApiError).message, 'error');
                    }
                  }}
                >
                  Verify
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-secondary">Protect your account with time-based one-time codes. Required for administrators.</p>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ alignSelf: 'flex-start' }}
                onClick={async () => {
                  try {
                    const res = await post<{ secret: string }>('/auth/mfa/enable');
                    setMfaSecret(res.secret);
                  } catch (err) {
                    toast((err as ApiError).message, 'error');
                  }
                }}
              >
                Enable MFA
              </button>
            </>
          )}
          <hr className="divider" />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ alignSelf: 'flex-start' }}
            onClick={async () => {
              await post('/auth/revoke-all');
              toast('All other sessions revoked. You stay signed in here until this token expires (≤15 min) and is refreshed.', 'success', 8000);
            }}
          >
            Sign out all devices
          </button>
        </div>

        <BillingCard isAdmin={user.role === 'admin'} />

        <AppearanceCard contrast={contrast} setContrast={setContrast} reducedMotion={reducedMotion} setReducedMotion={setReducedMotion} />

        <div className="card col">
          <h2>Your data</h2>
          <p className="text-sm text-secondary">
            Data minimization is the default: we store your email, name, consent choices, and your contributions.
            Full details on the <Link to="/privacy">privacy page</Link>.
          </p>
          <div className="row-wrap">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={async () => {
                try {
                  const data = await get<Record<string, unknown>>('/users/me/data');
                  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                  const a = document.createElement('a');
                  a.href = URL.createObjectURL(blob);
                  a.download = 'stn-my-data.json';
                  a.click();
                  URL.revokeObjectURL(a.href);
                  toast('Your data export has downloaded.', 'success');
                } catch (err) {
                  toast((err as ApiError).message, 'error');
                }
              }}
            >
              <Icon name="download" size={16} /> Download my data
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={async () => {
                await clearDatasets();
                toast('Local offline caches cleared.', 'success');
              }}
            >
              Clear offline caches
            </button>
            <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
              Delete my account
            </button>
          </div>
        </div>
      </div>

      {confirmDelete ? (
        <ConfirmDialog
          title="Delete your account?"
          message="Your account is deactivated immediately and anonymized within 30 days. Public contributions (map records, disputes) are preserved but de-attributed, per the privacy policy. This cannot be undone."
          confirmLabel="Delete my account"
          destructive
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            try {
              await del('/users/me');
              await logout();
              toast('Account deleted. Thank you for contributing to transparency.', 'success', 8000);
              navigate('/map');
            } catch (err) {
              toast((err as ApiError).message, 'error');
              setConfirmDelete(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function AppearanceCard({
  contrast,
  setContrast,
  reducedMotion,
  setReducedMotion,
}: {
  contrast: 'normal' | 'high';
  setContrast: (c: 'normal' | 'high') => void;
  reducedMotion: boolean;
  setReducedMotion: (r: boolean) => void;
}): JSX.Element {
  return (
    <div className="card col">
      <h2>Appearance & accessibility</h2>
      <label className="checkbox-row">
        <input type="checkbox" checked={contrast === 'high'} onChange={(e) => setContrast(e.target.checked ? 'high' : 'normal')} />
        <span>
          <strong className="text-sm">High-contrast mode</strong>
          <br />
          <span className="text-xs text-secondary">Pure black background, yellow accent, stronger borders (WCAG AAA-leaning)</span>
        </span>
      </label>
      <label className="checkbox-row">
        <input type="checkbox" checked={reducedMotion} onChange={(e) => setReducedMotion(e.target.checked)} />
        <span>
          <strong className="text-sm">Reduce motion</strong>
          <br />
          <span className="text-xs text-secondary">Disables animations and haptics (also honors your OS setting automatically)</span>
        </span>
      </label>
    </div>
  );
}


function BillingCard({ isAdmin }: { isAdmin: boolean }): JSX.Element | null {
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const { data, refetch } = useQuery({
    queryKey: ['billing-status'],
    queryFn: () => get<{ configured: boolean; plan: string; hasBillingProfile?: boolean }>('/billing/status'),
  });

  // returning from Stripe Checkout: poll briefly while the webhook lands
  const navigateBack = new URLSearchParams(window.location.search).get('billing');
  useEffect(() => {
    if (navigateBack === 'success') {
      toast('Payment received — activating your Supporter plan…', 'success', 6000);
      const t = setInterval(() => void refetch(), 2500);
      const stop = setTimeout(() => clearInterval(t), 20_000);
      return () => {
        clearInterval(t);
        clearTimeout(stop);
      };
    }
    if (navigateBack === 'cancelled') toast('Checkout cancelled — no charge was made.', 'info');
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigateBack]);

  if (!data) return null;
  if (!data.configured) {
    if (!isAdmin) return null; // nothing to show end users until keys exist
    return (
      <div className="card col">
        <h2>Supporter plan (Stripe)</h2>
        <p className="text-sm text-secondary">
          Payments aren’t configured yet. Set <code>STRIPE_SECRET_KEY</code>, <code>STRIPE_PRICE_ID_PRO</code> and{' '}
          <code>STRIPE_WEBHOOK_SECRET</code> — full steps are in the README. This card is only visible to admins.
        </p>
      </div>
    );
  }

  const go = async (path: '/billing/checkout' | '/billing/portal') => {
    setBusy(true);
    try {
      const res = await post<{ url: string }>(path);
      window.location.href = res.url;
    } catch (err) {
      toast((err as ApiError).message, 'error', 7000);
      setBusy(false);
    }
  };

  return (
    <div className="card col">
      <h2>Supporter plan</h2>
      {data.plan === 'pro' ? (
        <>
          <p className="text-sm">
            <span className="pill" data-tone="success">Supporter <Icon name="check" size={14} /></span>{' '}
            <span className="text-secondary">Thank you — you fund the servers and the FOIA fee pool.</span>
          </p>
          <p className="text-xs text-secondary">Perks: export caps raised to 50,000 rows, priority processing.</p>
          <button type="button" className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => void go('/billing/portal')}>
            {busy ? 'Opening…' : 'Manage billing'}
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-secondary">
            The map, navigation, FOIA tools and disputes are free for everyone — that’s the point. Supporters keep it
            running and unlock bigger exports (50,000 rows vs 10,000).
          </p>
          <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => void go('/billing/checkout')}>
            {busy ? 'Opening secure checkout…' : 'Become a Supporter'}
          </button>
          <p className="text-xs text-secondary">Card handled entirely by Stripe — we never see your number. Cancel anytime.</p>
        </>
      )}
    </div>
  );
}
