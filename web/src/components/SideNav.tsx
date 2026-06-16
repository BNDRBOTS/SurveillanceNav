import { NavLink } from 'react-router-dom';
import { useStore } from '@/lib/store';
import { Icon, type IconName } from './Icon';

const NAV_ITEMS: Array<{ to: string; label: string; icon: IconName; color: string }> = [
  { to: '/map',         label: 'Map',         icon: 'map',       color: '#00E5A8' },
  { to: '/foia',        label: 'FOIA',        icon: 'mail',      color: '#FFB347' },
  { to: '/procurement', label: 'Procurement', icon: 'file-text', color: '#19D3DA' },
  { to: '/policies',    label: 'Policies',    icon: 'scale',     color: '#8B7CF6' },
  { to: '/reports',     label: 'Reports',     icon: 'download',  color: '#FF8E3C' },
  { to: '/workspaces',  label: 'Workspaces',  icon: 'users',     color: '#FF5CA8' },
];

export function SideNav(): JSX.Element {
  const user = useStore((s) => s.user);
  const items = user?.role === 'admin'
    ? [...NAV_ITEMS, { to: '/admin', label: 'Admin', icon: 'shield' as IconName, color: '#FF4D4D' }]
    : NAV_ITEMS;
  return (
    <nav className="sidenav" aria-label="Primary">
      {items.map((item) => (
        <NavLink key={item.to} to={item.to}>
          {({ isActive }) => (
            <>
              <Icon name={item.icon} style={{ color: isActive ? item.color : undefined }} />
              {item.label}
            </>
          )}
        </NavLink>
      ))}
      <span className="spacer" />
      <a href="/docs" target="_blank" rel="noreferrer" className="text-xs">
        <Icon name="code" size={16} /> API reference
      </a>
    </nav>
  );
}

/** Mobile bottom tab bar — primary destinations stay in the thumb zone. */
export function BottomNav(): JSX.Element {
  const user = useStore((s) => s.user);
  const mobile: Array<{ to: string; label: string; icon: IconName; color: string }> = [
    { to: '/map',         label: 'Map',     icon: 'map',       color: '#00E5A8' },
    { to: '/foia',        label: 'FOIA',    icon: 'mail',      color: '#FFB347' },
    { to: '/procurement', label: 'Procure', icon: 'file-text', color: '#19D3DA' },
    { to: '/reports',     label: 'Reports', icon: 'download',  color: '#FF8E3C' },
    user?.role === 'admin'
      ? { to: '/admin',    label: 'Admin',    icon: 'shield' as IconName, color: '#FF4D4D' }
      : { to: '/policies', label: 'Policies', icon: 'scale',              color: '#8B7CF6' },
  ];
  return (
    <nav className="bottomnav" aria-label="Primary">
      {mobile.map((item) => (
        <NavLink key={item.to} to={item.to}>
          {({ isActive }) => (
            <>
              <Icon name={item.icon} size={22} style={{ color: isActive ? item.color : undefined }} />
              {item.label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
