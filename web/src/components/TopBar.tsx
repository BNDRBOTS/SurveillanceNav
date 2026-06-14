import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { parseCoordinates, type NotificationItem } from '@stn/shared';
import { get, post } from '@/lib/api';
import { useStore } from '@/lib/store';
import { logout } from '@/lib/auth';
import { fmtRelative } from '@/lib/format';
import { haptics } from '@/lib/haptics';
import { Icon } from './Icon';

function useClickOutside(onAway: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onAway();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onAway]);
  return ref;
}

export function Logo(): JSX.Element {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <circle cx="13" cy="13" r="11" stroke="var(--color-accent)" strokeWidth="2.4" />
      <circle cx="13" cy="13" r="4.6" fill="var(--color-accent)" />
      <path d="M13 2v4M13 20v4M2 13h4M20 13h4" stroke="var(--color-accent)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function NotificationsBell(): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  const queryClient = useQueryClient();
  const setUnread = useStore((s) => s.setUnread);
  const navigate = useNavigate();

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => get<{ items: NotificationItem[]; unread: number }>('/users/me/notifications'),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const unread = data?.unread ?? 0;
  useEffect(() => setUnread(unread), [unread, setUnread]);

  const markAllRead = async () => {
    await post('/users/me/notifications/read');
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  };

  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ''}`}
        aria-expanded={open}
        onClick={() => {
          haptics.light();
          setOpen((o) => !o);
        }}
      >
        <Icon name="bell" size={20} />
        {unread > 0 ? (
          <span
            className="pill"
            data-tone="accent"
            style={{ position: 'absolute', top: 2, right: 0, padding: '0 6px', minWidth: 18, justifyContent: 'center' }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="menu" style={{ right: 0, top: 'calc(100% + 6px)', width: 340 }} role="menu" aria-label="Notifications">
          <div className="row" style={{ padding: 'var(--space-xs) var(--space-sm)', justifyContent: 'space-between' }}>
            <strong className="text-sm">Notifications</strong>
            {unread > 0 ? (
              <button type="button" className="btn btn-sm btn-ghost" onClick={markAllRead}>
                Mark all read
              </button>
            ) : null}
          </div>
          {(data?.items ?? []).length === 0 ? (
            <p className="text-sm text-secondary" style={{ padding: 'var(--space-sm)' }}>
              Nothing yet. Dispute updates, FOIA deadlines, export completions and mentions land here.
            </p>
          ) : (
            (data?.items ?? []).slice(0, 12).map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => {
                  setOpen(false);
                  void post('/users/me/notifications/read', { ids: [n.id] }).then(() =>
                    queryClient.invalidateQueries({ queryKey: ['notifications'] }),
                  );
                  if (n.link) navigate(n.link);
                }}
                style={{ opacity: n.readAt ? 0.6 : 1, display: 'block' }}
              >
                <div className="col" style={{ gap: 2, alignItems: 'flex-start' }}>
                  <span className="text-sm" style={{ fontWeight: 600 }}>
                    {n.title}
                  </span>
                  <span className="text-xs text-secondary">{n.body.slice(0, 90)}</span>
                  <span className="text-xs text-secondary">{fmtRelative(n.createdAt)}</span>
                </div>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function WorkspaceSwitcher(): JSX.Element | null {
  const workspaces = useStore((s) => s.workspaces);
  const currentId = useStore((s) => s.currentWorkspaceId);
  const setCurrent = useStore((s) => s.setCurrentWorkspace);
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  const navigate = useNavigate();
  if (workspaces.length === 0) return null;
  const current = workspaces.find((w) => w.id === currentId) ?? workspaces[0]!;

  return (
    <div style={{ position: 'relative' }} ref={ref} className="hide-mobile">
      <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="text-secondary text-xs">Workspace</span> {current.name.length > 18 ? `${current.name.slice(0, 17)}…` : current.name} <Icon name="chevron-down" size={14} />
      </button>
      {open ? (
        <div className="menu" style={{ top: 'calc(100% + 6px)', left: 0 }} role="menu" aria-label="Switch workspace">
          {workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => {
                setCurrent(w.id);
                setOpen(false);
              }}
            >
              {w.id === current.id ? <Icon name="check" size={14} /> : null}
              {w.name}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              navigate('/workspaces');
            }}
          >
            <Icon name="plus" size={14} /> Manage workspaces…
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function TopBar(): JSX.Element {
  const user = useStore((s) => s.user);
  const online = useStore((s) => s.online);
  const outbox = useStore((s) => s.outboxCount);
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useClickOutside(() => setMenuOpen(false));
  const navigate = useNavigate();

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    const coords = parseCoordinates(q);
    if (coords) {
      navigate(`/map?lng=${coords.lng.toFixed(5)}&lat=${coords.lat.toFixed(5)}&z=15`);
    } else {
      navigate(`/map?q=${encodeURIComponent(q)}`);
    }
    setQuery('');
  };

  return (
    <header className="topbar">
      <Link to="/map" className="brand" aria-label="Lens of Light — home">
        <Logo />
        <span className="hide-mobile">Lens of Light</span>
      </Link>

      <form onSubmit={submitSearch} role="search" style={{ flex: 1, maxWidth: 440 }}>
        <input
          className="input"
          style={{ minHeight: 38 }}
          type="search"
          placeholder="Search places, addresses, or paste coordinates…"
          aria-label="Search places or coordinates"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </form>

      <span className="spacer" />

      {!online ? (
        <span className="pill" data-tone="warning" title="Offline — reads come from cache, submissions are queued">
          offline{outbox > 0 ? ` · ${outbox} queued` : ''}
        </span>
      ) : outbox > 0 ? (
        <span className="pill" data-tone="accent" title="Queued submissions are syncing">
          syncing {outbox}…
        </span>
      ) : null}

      {user ? (
        <>
          <Link to="/foia/new" className="btn btn-primary btn-sm hide-mobile">
            <Icon name="plus" size={16} /> New FOIA
          </Link>
          <WorkspaceSwitcher />
          <NotificationsBell />
          <div style={{ position: 'relative' }} ref={menuRef}>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label={`Account menu for ${user.name}`}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
              style={{ borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', fontWeight: 700 }}
            >
              {user.name.slice(0, 1).toUpperCase()}
            </button>
            {menuOpen ? (
              <div className="menu" style={{ right: 0, top: 'calc(100% + 6px)' }} role="menu" aria-label="Account">
                <div style={{ padding: 'var(--space-xs) var(--space-sm)' }}>
                  <div className="text-sm" style={{ fontWeight: 600 }}>
                    {user.name}
                  </div>
                  <div className="text-xs text-secondary">
                    {user.email} · {user.role}
                  </div>
                </div>
                <Link to="/settings" onClick={() => setMenuOpen(false)}>
                  Settings & privacy
                </Link>
                <Link to="/privacy" onClick={() => setMenuOpen(false)}>
                  Data we collect
                </Link>
                <button
                  type="button"
                  onClick={async () => {
                    setMenuOpen(false);
                    await logout();
                    navigate('/login');
                  }}
                >
                  Sign out
                </button>
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <Link to="/login" className="btn btn-primary btn-sm">
          Sign in
        </Link>
      )}
    </header>
  );
}
