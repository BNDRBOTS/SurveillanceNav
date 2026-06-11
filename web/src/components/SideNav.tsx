import { NavLink } from 'react-router-dom';
import { useStore } from '@/lib/store';

const NAV_ITEMS = [
  { to: '/map', label: 'Map', icon: '🗺', exact: false },
  { to: '/foia', label: 'FOIA', icon: '📨', exact: false },
  { to: '/procurement', label: 'Procurement', icon: '📑', exact: false },
  { to: '/policies', label: 'Policies', icon: '⚖️', exact: false },
  { to: '/reports', label: 'Reports', icon: '📤', exact: false },
  { to: '/workspaces', label: 'Workspaces', icon: '👥', exact: false },
];

export function SideNav(): JSX.Element {
  const user = useStore((s) => s.user);
  const items = user?.role === 'admin' ? [...NAV_ITEMS, { to: '/admin', label: 'Admin', icon: '🛡', exact: false }] : NAV_ITEMS;
  return (
    <nav className="sidenav" aria-label="Primary">
      {items.map((item) => (
        <NavLink key={item.to} to={item.to}>
          <span aria-hidden="true">{item.icon}</span>
          {item.label}
        </NavLink>
      ))}
      <span className="spacer" />
      <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer" className="text-xs">
        <span aria-hidden="true">⚙</span> API reference
      </a>
    </nav>
  );
}

/** Mobile bottom tab bar — primary destinations stay in the thumb zone. */
export function BottomNav(): JSX.Element {
  const user = useStore((s) => s.user);
  const mobile = [
    { to: '/map', label: 'Map', icon: '🗺' },
    { to: '/foia', label: 'FOIA', icon: '📨' },
    { to: '/procurement', label: 'Procure', icon: '📑' },
    { to: '/reports', label: 'Reports', icon: '📤' },
    user?.role === 'admin'
      ? { to: '/admin', label: 'Admin', icon: '🛡' }
      : { to: '/policies', label: 'Policies', icon: '⚖️' },
  ];
  return (
    <nav className="bottomnav" aria-label="Primary">
      {mobile.map((item) => (
        <NavLink key={item.to} to={item.to}>
          <span aria-hidden="true">{item.icon}</span>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
