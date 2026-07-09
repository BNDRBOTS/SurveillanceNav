import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { UserPublic, Workspace } from '@stn/shared';

export interface Toast {
  id: number;
  tone: 'info' | 'success' | 'warning' | 'error';
  message: string;
  ttlMs: number;
  /** Optional one-tap action rendered as a button on the toast. */
  action?: { label: string; run: () => void };
}

export interface WalkthroughStep {
  title: string;
  body: string;
}

export interface WalkthroughState {
  key: string;
  steps: WalkthroughStep[];
  index: number;
}

interface UiState {
  user: UserPublic | null;
  mfaSetupRequired: boolean;
  authReady: boolean;
  workspaces: Workspace[];
  currentWorkspaceId: string | null;
  toasts: Toast[];
  online: boolean;
  outboxCount: number;
  dataStale: boolean;
  contrast: 'normal' | 'high';
  reducedMotion: boolean;
  unreadNotifications: number;
  walkthrough: WalkthroughState | null;

  setUser(user: UserPublic | null, mfaSetupRequired?: boolean): void;
  setAuthReady(): void;
  setWorkspaces(ws: Workspace[]): void;
  setCurrentWorkspace(id: string | null): void;
  toast(message: string, tone?: Toast['tone'], ttlMs?: number, action?: Toast['action']): void;
  dismissToast(id: number): void;
  setOnline(online: boolean): void;
  setOutboxCount(n: number): void;
  setDataStale(stale: boolean): void;
  setContrast(c: 'normal' | 'high'): void;
  setReducedMotion(r: boolean): void;
  setUnread(n: number): void;
  startWalkthrough(key: string, steps: WalkthroughStep[]): void;
  advanceWalkthrough(delta?: number): void;
  endWalkthrough(key?: string): void;
}

let toastSeq = 1;

export const useStore = create<UiState>()(
  immer((set) => ({
    user: null,
    mfaSetupRequired: false,
    authReady: false,
    workspaces: [],
    currentWorkspaceId: localStorage.getItem('stn.workspace'),
    toasts: [],
    online: navigator.onLine,
    outboxCount: 0,
    dataStale: false,
    contrast: (localStorage.getItem('stn.contrast') as 'normal' | 'high') ?? 'normal',
    reducedMotion: localStorage.getItem('stn.reducedMotion') === 'true',
    unreadNotifications: 0,
    walkthrough: null,

    setUser: (user, mfaSetupRequired = false) =>
      set((s) => {
        s.user = user;
        s.mfaSetupRequired = mfaSetupRequired;
        s.authReady = true;
      }),
    setAuthReady: () =>
      set((s) => {
        s.authReady = true;
      }),
    setWorkspaces: (ws) =>
      set((s) => {
        s.workspaces = ws;
        if (ws.length > 0 && !ws.some((w) => w.id === s.currentWorkspaceId)) {
          s.currentWorkspaceId = ws[0]!.id;
          localStorage.setItem('stn.workspace', ws[0]!.id);
        }
      }),
    setCurrentWorkspace: (id) =>
      set((s) => {
        s.currentWorkspaceId = id;
        if (id) localStorage.setItem('stn.workspace', id);
      }),
    toast: (message, tone = 'info', ttlMs = 5000, action?: Toast['action']) =>
      set((s) => {
        // collapse duplicates so retry storms don't stack toasts
        if (s.toasts.some((t) => t.message === message)) return;
        s.toasts.push({ id: toastSeq++, tone, message, ttlMs, ...(action ? { action } : {}) });
        if (s.toasts.length > 4) s.toasts.shift();
      }),
    dismissToast: (id) =>
      set((s) => {
        s.toasts = s.toasts.filter((t) => t.id !== id);
      }),
    setOnline: (online) =>
      set((s) => {
        s.online = online;
      }),
    setOutboxCount: (n) =>
      set((s) => {
        s.outboxCount = n;
      }),
    setDataStale: (stale) =>
      set((s) => {
        s.dataStale = stale;
      }),
    setContrast: (c) =>
      set((s) => {
        s.contrast = c;
        localStorage.setItem('stn.contrast', c);
        document.documentElement.dataset.contrast = c;
      }),
    setReducedMotion: (r) =>
      set((s) => {
        s.reducedMotion = r;
        localStorage.setItem('stn.reducedMotion', String(r));
        document.documentElement.dataset.motion = r ? 'reduced' : 'normal';
      }),
    setUnread: (n) =>
      set((s) => {
        s.unreadNotifications = n;
      }),
    startWalkthrough: (key: string, steps: WalkthroughStep[]) =>
      set((s) => {
        if (steps.length === 0) return;
        s.walkthrough = { key, steps, index: 0 };
      }),
    advanceWalkthrough: (delta: number = 1) =>
      set((s) => {
        if (!s.walkthrough) return;
        const next = s.walkthrough.index + delta;
        if (next < 0) return;
        if (next >= s.walkthrough.steps.length) s.walkthrough = null;
        else s.walkthrough.index = next;
      }),
    endWalkthrough: (key?: string) =>
      set((s) => {
        if (key !== undefined && s.walkthrough?.key !== key) return;
        s.walkthrough = null;
      }),
  })),
);

export function applyPersistedAppearance(): void {
  const { contrast, reducedMotion } = useStore.getState();
  document.documentElement.dataset.contrast = contrast;
  document.documentElement.dataset.motion = reducedMotion ? 'reduced' : 'normal';
}
