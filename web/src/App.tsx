import { lazy, Suspense, useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { TopBar } from '@/components/TopBar';
import { SideNav, BottomNav } from '@/components/SideNav';
import { EntryGate } from '@/components/EntryGate';
import { Toasts, ErrorBoundary, Skeleton } from '@/components/Feedback';
import { Icon } from '@/components/Icon';
import { Announcer } from '@/lib/announcer';
import { useStore } from '@/lib/store';

export function AppShell(): JSX.Element {
  const online = useStore((s) => s.online);
  const authReady = useStore((s) => s.authReady);
  const user = useStore((s) => s.user);
  const mfaSetupRequired = useStore((s) => s.mfaSetupRequired);
  const location = useLocation();
  const navigate = useNavigate();

  // Admins must finish MFA enrollment before using the app.
  useEffect(() => {
    if (authReady && user && mfaSetupRequired && location.pathname !== '/mfa-setup') {
      navigate('/mfa-setup');
    }
  }, [authReady, user, mfaSetupRequired, location.pathname, navigate]);

  // First-run onboarding tour.
  useEffect(() => {
    if (authReady && user && !mfaSetupRequired && !localStorage.getItem('stn.onboarded') && location.pathname === '/map') {
      localStorage.setItem('stn.onboarded', 'true');
      navigate('/onboarding');
    }
  }, [authReady, user, mfaSetupRequired, location.pathname, navigate]);

  return (
    <ErrorBoundary>
      <a href="#main-content" className="visually-hidden">
        Skip to main content
      </a>
      <TopBar />
      {!online ? (
        <div className="banner" data-tone="warning" role="status">
          <Icon name="wifi-off" size={16} /> Offline mode — showing cached data; submissions are queued and will sync automatically.
        </div>
      ) : null}
      <div className="shell">
        <SideNav />
        <main className="main" id="main-content">
          <Suspense
            fallback={
              <div className="page">
                <Skeleton count={6} height={28} />
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </main>
      </div>
      <BottomNav />
      <EntryGate />
      <Toasts />
      <Announcer />
    </ErrorBoundary>
  );
}

export const LazyMapPage = lazy(() => import('@/pages/MapPage'));
export const LazyProcurementPage = lazy(() => import('@/pages/ProcurementPage'));
export const LazyPoliciesPage = lazy(() => import('@/pages/PoliciesPage'));
export const LazyReportsPage = lazy(() => import('@/pages/ReportsPage'));
export const LazyAdminPage = lazy(() => import('@/pages/AdminPage'));
export const LazySettingsPage = lazy(() => import('@/pages/SettingsPage'));
export const LazyHelpPage = lazy(() => import('@/pages/HelpPage'));
