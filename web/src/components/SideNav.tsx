import { NavLink } from 'react-router-dom';
import { useStore } from '@/lib/store';
import { Icon, type IconName } from './Icon';

/* Icons carry their own purpose hue (see Icon.tsx tone map); active route
   gets full presence + glow, inactive stays colored but recedes. */
const NAV_ITEMS: Array<{ to: string; label: string; icon: IconName }> = [
  { to: '/map',         label: 'Map',         icon: 'map' },
  { to: '/foia',        label: 'FOIA',        icon: 'mail' },
  { to: '/procurement', label: 'Procurement', icon: 'file-text' },
  { to: '/policies',    label: 'Policies',    icon: 'scale' },
  { to: '/reports',     label: 'Reports',     icon: 'download' },
  { to: '/workspaces',  label: 'Workspaces',  icon: 'users' },
];

export function SideNav(): JSX.Element {
  const user = useStore((s) => s.user);
  const items = user?.role === 'admin'
    ? [...NAV_ITEMS, { to: '/admin', label: 'Admin', icon: 'shield' as IconName }]
    : NAV_ITEMS;
  return (
    <nav className="sidenav" aria-label="Primary">
      {items.map((item) => (
        <NavLink key={item.to} to={item.to}>
          {({ isActive }) => (
            <>
              <Icon name={item.icon} glow={isActive} style={{ opacity: isActive ? 1 : 0.78 }} />
              {item.label}
            </>
          )}
        </NavLink>
      ))}
      <span className="spacer" />
      <NavLink to="/help" className="text-xs">
        {({ isActive }) => (
          <>
            <Icon name="compass" size={16} glow={isActive} /> Help & tours
          </>
        )}
      </NavLink>
      <a href="/docs" target="_blank" rel="noreferrer" className="text-xs">
        <Icon name="code" size={16} /> API reference
      </a>
    </nav>
  );
}

/** Mobile bottom tab bar — primary destinations stay in the thumb zone. */
export function BottomNav(): JSX.Element {
  const user = useStore((s) => s.user);
  const mobile: Array<{ to: string; label: string; icon: IconName }> = [
    { to: '/map',         label: 'Map',     icon: 'map' },
    { to: '/foia',        label: 'FOIA',    icon: 'mail' },
    { to: '/procurement', label: 'Procure', icon: 'file-text' },
    { to: '/reports',     label: 'Reports', icon: 'download' },
    user?.role === 'admin'
      ? { to: '/admin',    label: 'Admin',    icon: 'shield' as IconName }
      : { to: '/policies', label: 'Policies', icon: 'scale' },
  ];
  return (
    <nav className="bottomnav" aria-label="Primary">
      {mobile.map((item) => (
        <NavLink key={item.to} to={item.to}>
          {({ isActive }) => (
            <>
              <Icon name={item.icon} size={22} glow={isActive} style={{ opacity: isActive ? 1 : 0.78 }} />
              {item.label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
