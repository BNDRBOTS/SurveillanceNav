import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles/tokens.css';
import './styles/base.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  AppShell,
  LazyMapPage,
  LazyProcurementPage,
  LazyPoliciesPage,
  LazyReportsPage,
  LazyAdminPage,
  LazySettingsPage,
} from './App';
import { LoginPage, SignupPage, ResetPasswordPage, MfaSetupPage, InvitePage } from '@/pages/AuthPages';
import { FoiaListPage, FoiaNewPage, FoiaDetailPage } from '@/pages/FoiaPages';
import { WorkspacesPage, WorkspaceDetailPage } from '@/pages/WorkspacesPage';
import { PrivacyPage, TermsPage, SupportPage, NotFoundPage, OnboardingPage } from '@/pages/StaticPages';
import { bootstrapSession, installSessionListeners, syncOutbox } from '@/lib/auth';
import { applyPersistedAppearance } from '@/lib/store';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000, // stale-while-revalidate
      retry: (failureCount, error) => {
        const status = (error as { status?: number }).status ?? 0;
        if (status >= 400 && status < 500) return false; // client errors are final
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
  },
});

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <Navigate to="/map" replace /> },
      { path: '/map', element: <LazyMapPage /> },
      { path: '/foia', element: <FoiaListPage /> },
      { path: '/foia/new', element: <FoiaNewPage /> },
      { path: '/foia/:id', element: <FoiaDetailPage /> },
      { path: '/procurement', element: <LazyProcurementPage /> },
      { path: '/policies', element: <LazyPoliciesPage /> },
      { path: '/reports', element: <LazyReportsPage /> },
      { path: '/workspaces', element: <WorkspacesPage /> },
      { path: '/workspaces/:id', element: <WorkspaceDetailPage /> },
      { path: '/admin', element: <LazyAdminPage /> },
      { path: '/settings', element: <LazySettingsPage /> },
      { path: '/privacy', element: <PrivacyPage /> },
      { path: '/terms', element: <TermsPage /> },
      { path: '/support', element: <SupportPage /> },
      { path: '/onboarding', element: <OnboardingPage /> },
      { path: '/login', element: <LoginPage /> },
      { path: '/signup', element: <SignupPage /> },
      { path: '/reset-password', element: <ResetPasswordPage /> },
      { path: '/mfa-setup', element: <MfaSetupPage /> },
      { path: '/invite', element: <InvitePage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

applyPersistedAppearance();
installSessionListeners();
void bootstrapSession();

// PWA: register the service worker and wire background sync of the outbox.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        navigator.serviceWorker.addEventListener('message', (event) => {
          if ((event.data as { type?: string })?.type === 'stn-sync-outbox') void syncOutbox();
        });
        reg.addEventListener('updatefound', () => {
          const next = reg.installing;
          next?.addEventListener('statechange', () => {
            if (next.state === 'installed' && navigator.serviceWorker.controller) {
              window.dispatchEvent(new CustomEvent('stn:update-available'));
            }
          });
        });
      })
      .catch(() => undefined);
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
