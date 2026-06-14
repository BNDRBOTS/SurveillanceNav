import type { AuthTokens, UserPublic, Workspace } from '@stn/shared';
import { api, post, get, setAccessToken, setUnauthorizedHandler, refreshSession } from './api';
import { flushOutbox, outboxCount } from './offline';
import { useStore } from './store';
import { haptics } from './haptics';

/** Session orchestration: bootstrap, login/signup/logout, offline sync. */

async function loadWorkspaces(): Promise<void> {
  try {
    const res = await get<{ items: Workspace[] }>('/workspaces');
    useStore.getState().setWorkspaces(res.items);
  } catch {
    /* non-fatal */
  }
}

export function applySession(tokens: AuthTokens): void {
  setAccessToken(tokens.accessToken);
  useStore.getState().setUser(tokens.user, tokens.mfaSetupRequired ?? false);
  void loadWorkspaces();
  void syncOutbox();
}

export async function bootstrapSession(): Promise<void> {
  // Ensure the CSRF cookie exists, then try to restore via refresh cookie.
  try {
    await fetch('/api/v1/auth/csrf', { credentials: 'include' });
  } catch {
    /* offline boot is fine */
  }
  const refreshed = await refreshSession();
  if (refreshed) {
    try {
      const user = await get<UserPublic>('/users/me');
      useStore.getState().setUser(user, false);
      void loadWorkspaces();
      void syncOutbox();
      return;
    } catch {
      /* fall through */
    }
  }
  useStore.getState().setAuthReady();
}

export async function login(email: string, password: string, totp?: string): Promise<AuthTokens> {
  const tokens = await post<AuthTokens>('/auth/login', { email, password, ...(totp ? { totp } : {}) });
  applySession(tokens);
  haptics.light();
  return tokens;
}

export async function signup(input: {
  email: string;
  name: string;
  password: string;
  researchContact: boolean;
}): Promise<AuthTokens> {
  const tokens = await post<AuthTokens>('/auth/signup', {
    email: input.email,
    name: input.name,
    password: input.password,
    consent: { terms: true, privacy: true, researchContact: input.researchContact },
  });
  applySession(tokens);
  return tokens;
}

export async function logout(): Promise<void> {
  try {
    await post('/auth/logout');
  } catch {
    /* clearing local state regardless */
  }
  setAccessToken(null);
  useStore.getState().setUser(null);
  useStore.getState().setWorkspaces([]);
}

/** Replay queued offline submissions; toast the outcome. */
export async function syncOutbox(): Promise<void> {
  const store = useStore.getState();
  const count = await outboxCount();
  store.setOutboxCount(count);
  if (count === 0 || !navigator.onLine) return;
  const result = await flushOutbox(async (path, body, idempotencyKey) => {
    await api(path, { method: 'POST', body, idempotencyKey });
  });
  store.setOutboxCount(await outboxCount());
  if (result.sent > 0) {
    store.toast(`Synced ${result.sent} queued submission${result.sent === 1 ? '' : 's'}`, 'success');
    haptics.success();
  }
  if (result.dropped > 0) {
    store.toast(`${result.dropped} queued submission(s) were rejected by the server and removed — check your drafts.`, 'warning', 9000);
  }
}

export function installSessionListeners(): void {
  setUnauthorizedHandler(() => {
    setAccessToken(null);
    useStore.getState().setUser(null);
    useStore.getState().toast('Session expired — sign in again to continue. Your drafts are preserved.', 'warning', 8000);
  });

  window.addEventListener('stn:session-refreshed', ((e: CustomEvent<AuthTokens>) => {
    useStore.getState().setUser(e.detail.user, e.detail.mfaSetupRequired ?? false);
  }) as EventListener);

  window.addEventListener('online', () => {
    useStore.getState().setOnline(true);
    useStore.getState().toast('Back online — syncing…', 'success', 3000);
    void syncOutbox();
  });
  window.addEventListener('offline', () => {
    useStore.getState().setOnline(false);
    useStore.getState().toast('You are offline. Submissions will be queued and synced automatically.', 'warning', 6000);
  });
  window.addEventListener('stn:outbox-changed', () => {
    void outboxCount().then((n) => useStore.getState().setOutboxCount(n));
  });
  window.addEventListener('stn:outbox-dropped', ((e: CustomEvent<{ path: string; reason: string }>) => {
    useStore.getState().toast(`A queued submission could not be synced: ${e.detail.reason}`, 'error', 10_000);
  }) as EventListener);
  window.addEventListener('stn:data-stale', () => useStore.getState().setDataStale(true));
  window.addEventListener('stn:cache-corrupt', () => {
    useStore.getState().toast('A cached dataset failed its integrity check and was discarded.', 'warning', 7000);
  });
}
