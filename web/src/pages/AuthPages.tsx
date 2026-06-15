import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { login, signup, applySession } from '@/lib/auth';
import { ApiError, post } from '@/lib/api';
import { useStore } from '@/lib/store';
import { TextInput, PasswordInput } from '@/components/Form';
import { Logo } from '@/components/TopBar';
import type { AuthTokens } from '@stn/shared';

export function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  const toast = useStore((s) => s.toast);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await login(email.trim(), password, needsTotp ? totp : undefined);
      if (session.mfaSetupRequired) {
        navigate('/mfa-setup');
      } else {
        toast(`Welcome back, ${session.user.name.split(' ')[0]}.`, 'success');
        navigate('/map');
      }
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.code === 'mfa_required') {
        setNeedsTotp(true);
        setError(null);
      } else {
        setError(apiErr.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-layout">
      <form className="card auth-card col" onSubmit={submit} aria-label="Sign in">
        <div className="row" style={{ justifyContent: 'center', marginBottom: 'var(--space-xs)' }}>
          <Logo />
          <h1 style={{ fontSize: 'var(--font-size-lg)' }}>Lens of Light</h1>
        </div>
        <p className="text-sm text-secondary" style={{ textAlign: 'center', marginBottom: 'var(--space-sm)' }}>
          Surveillance Transparency Navigator
        </p>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <TextInput label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        <PasswordInput label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
        {needsTotp ? (
          <TextInput
            label="Authenticator code"
            value={totp}
            onChange={(e) => setTotp(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6-digit code"
            hint="Codes rotate every 30 seconds"
            autoFocus
          />
        ) : null}
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Signing in…' : needsTotp ? 'Verify & sign in' : 'Sign in'}
        </button>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Link to="/reset-password" className="text-sm">
            Forgot password?
          </Link>
          <Link to="/signup" className="text-sm">
            Create account
          </Link>
        </div>
        <p className="text-xs text-secondary" style={{ textAlign: 'center' }}>
          You can <Link to="/map">browse the public map</Link> without an account.
        </p>
      </form>
    </div>
  );
}

export function SignupPage(): JSX.Element {
  const navigate = useNavigate();
  const toast = useStore((s) => s.toast);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [terms, setTerms] = useState(false);
  const [research, setResearch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Enter your name (or a pseudonym)';
    if (!terms) errs.terms = 'Required to create an account';
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const session = await signup({ email: email.trim(), name: name.trim(), password, researchContact: research });
      toast('Account created — welcome aboard.', 'success');
      navigate(session.mfaSetupRequired ? '/mfa-setup' : '/onboarding');
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.details && Array.isArray(apiErr.details)) {
        const mapped: Record<string, string> = {};
        for (const d of apiErr.details as Array<{ path: string; message: string }>) {
          mapped[d.path.split('.')[0] ?? d.path] = d.message;
        }
        setFieldErrors(mapped);
      }
      setError(apiErr.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-layout">
      <form className="card auth-card col" onSubmit={submit} aria-label="Create account">
        <h1 style={{ fontSize: 'var(--font-size-lg)' }}>Create your account</h1>
        <p className="text-sm text-secondary">Track FOIA requests, collaborate in workspaces, and contribute verified data.</p>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} error={fieldErrors.name} autoComplete="name" hint="A pseudonym is fine — we practice data minimization" />
        <TextInput label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={fieldErrors.email} autoComplete="email" required />
        <PasswordInput label="Password" value={password} onChange={setPassword} error={fieldErrors.password} autoComplete="new-password" withMeter />
        <label className="checkbox-row">
          <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} aria-invalid={!!fieldErrors.terms} />
          <span className="text-sm">
            I accept the <Link to="/privacy">privacy policy</Link> and <Link to="/terms">terms of use</Link>: public-interest use, no harassment, no doxxing.
            {fieldErrors.terms ? <span className="field-error"> {fieldErrors.terms}</span> : null}
          </span>
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={research} onChange={(e) => setResearch(e.target.checked)} />
          <span className="text-sm text-secondary">Researchers may contact me about my public contributions (optional)</span>
        </label>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
        <p className="text-sm" style={{ textAlign: 'center' }}>
          Already registered? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}

export function ResetPasswordPage(): JSX.Element {
  const [params] = useSearchParams();
  const token = params.get('token');
  const navigate = useNavigate();
  const toast = useStore((s) => s.toast);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/reset-password', { email: email.trim() });
      setSent(true);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const completeReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/reset-password', { token, password });
      toast('Password updated — sign in with your new password.', 'success');
      navigate('/login');
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-layout">
      <form className="card auth-card col" onSubmit={token ? completeReset : requestReset} aria-label="Reset password">
        <h1 style={{ fontSize: 'var(--font-size-lg)' }}>{token ? 'Choose a new password' : 'Reset your password'}</h1>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        {token ? (
          <>
            <PasswordInput label="New password" value={password} onChange={setPassword} autoComplete="new-password" withMeter />
            <button className="btn btn-primary" disabled={busy}>
              {busy ? 'Updating…' : 'Update password'}
            </button>
          </>
        ) : sent ? (
          <p className="text-sm text-secondary" role="status">
            If that email has an account, a reset link is on its way. It expires in 1 hour.
          </p>
        ) : (
          <>
            <TextInput label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
            <button className="btn btn-primary" disabled={busy}>
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
          </>
        )}
        <Link to="/login" className="text-sm" style={{ textAlign: 'center' }}>
          Back to sign in
        </Link>
      </form>
    </div>
  );
}

export function MfaSetupPage(): JSX.Element {
  const navigate = useNavigate();
  const toast = useStore((s) => s.toast);
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const begin = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ secret: string; otpauthUrl: string }>('/auth/mfa/enable');
      setSecret(res.secret);
      setOtpauthUrl(res.otpauthUrl);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await post<AuthTokens>('/auth/mfa/verify', { code });
      applySession(session);
      toast('Multi-factor authentication is on. Your admin access is now fully enabled.', 'success', 7000);
      navigate('/map');
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-layout">
      <div className="card auth-card col">
        <h1 style={{ fontSize: 'var(--font-size-lg)' }}>Protect your admin account</h1>
        <p className="text-sm text-secondary">
          Administrator accounts require multi-factor authentication. Add Lens of Light to any TOTP authenticator app
          (Aegis, Google Authenticator, 1Password…).
        </p>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        {!secret ? (
          <button type="button" className="btn btn-primary" onClick={begin} disabled={busy}>
            {busy ? 'Preparing…' : 'Begin setup'}
          </button>
        ) : (
          <form onSubmit={verify} className="col">
            <div className="card" style={{ background: 'var(--color-bg-secondary)' }}>
              <p className="text-xs text-secondary">Enter this secret in your authenticator app:</p>
              <p className="mono" style={{ wordBreak: 'break-all', userSelect: 'all' }}>
                {secret}
              </p>
              {otpauthUrl ? (
                <a className="text-xs" href={otpauthUrl}>
                  Or open directly in your authenticator
                </a>
              ) : null}
            </div>
            <TextInput label="Enter the 6-digit code to confirm" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" />
            <button className="btn btn-primary" disabled={busy || code.length < 6}>
              {busy ? 'Verifying…' : 'Activate MFA'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export function InvitePage(): JSX.Element {
  const [params] = useSearchParams();
  const token = params.get('token');
  const navigate = useNavigate();
  const user = useStore((s) => s.user);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ workspaceId: string }>('/workspaces/accept-invite', { token });
      toast('Invitation accepted — welcome to the workspace.', 'success');
      navigate(`/workspaces/${res.workspaceId}`);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-layout">
      <div className="card auth-card col">
        <h1 style={{ fontSize: 'var(--font-size-lg)' }}>Workspace invitation</h1>
        {!token ? (
          <p className="text-sm text-danger">This invite link is malformed — ask the sender for a fresh one.</p>
        ) : !user ? (
          <>
            <p className="text-sm text-secondary">Sign in or create an account with the invited email address, then return to this link.</p>
            <div className="row">
              <Link className="btn btn-primary" to={`/login?next=${encodeURIComponent(`/invite?token=${token}`)}`}>
                Sign in
              </Link>
              <Link className="btn btn-ghost" to="/signup">
                Create account
              </Link>
            </div>
          </>
        ) : (
          <>
            {error ? (
              <p className="field-error" role="alert">
                {error}
              </p>
            ) : null}
            <button type="button" className="btn btn-primary" onClick={accept} disabled={busy}>
              {busy ? 'Joining…' : 'Accept invitation'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
