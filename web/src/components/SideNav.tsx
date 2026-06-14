import { NavLink } from 'react-router-dom';
import { useStore } from '@/lib/store';
import { Icon, type IconName } from './Icon';

const NAV_ITEMS: Array<{ to: string; label: string; icon: IconName }> = [
  { to: '/map', label: 'Map', icon: 'map' },
  { to: '/foia', label: 'FOIA', icon: 'mail' },
  { to: '/procurement', label: 'Procurement', icon: 'file-text' },
  { to: '/policies', label: 'Policies', icon: 'scale' },
  { to: '/reports', label: 'Reports', icon: 'download' },
  { to: '/workspaces', label: 'Workspaces', icon: 'users' },
];

export function SideNav(): JSX.Element {
  const user = useStore((s) => s.user);
  const items: typeof NAV_ITEMS =
    user?.role === 'admin' ? [...NAV_ITEMS, { to: '/admin', label: 'Admin', icon: 'shield' }] : NAV_ITEMS;
  return (
    <nav className="sidenav" aria-label="Primary">
      {items.map((item) => (
        <NavLink key={item.to} to={item.to}>
          <Icon name={item.icon} />
          {item.label}
        </NavLink>
      ))}
      <span className="spacer" />
      <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer" className="text-xs">
        <Icon name="code" size={16} /> API reference
      </a>
    </nav>
  );
}

/** Mobile bottom tab bar — primary destinations stay in the thumb zone. */
export function BottomNav(): JSX.Element {
  const user = useStore((s) => s.user);
  const mobile: Array<{ to: string; label: string; icon: IconName }> = [
    { to: '/map', label: 'Map', icon: 'map' },
    { to: '/foia', label: 'FOIA', icon: 'mail' },
    { to: '/procurement', label: 'Procure', icon: 'file-text' },
    { to: '/reports', label: 'Reports', icon: 'download' },
    user?.role === 'admin'
      ? { to: '/admin', label: 'Admin', icon: 'shield' }
      : { to: '/policies', label: 'Policies', icon: 'scale' },
  ];
  return (
    <nav className="bottomnav" aria-label="Primary">
      {mobile.map((item) => (
        <NavLink key={item.to} to={item.to}>
          <Icon name={item.icon} size={22} />
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
