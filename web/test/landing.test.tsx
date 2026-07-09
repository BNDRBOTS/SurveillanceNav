import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LandingPage from '@/pages/LandingPage';
import { FAQ } from '@/data/faq';
import { useStore } from '@/lib/store';

vi.mock('@/lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...mod,
    get: vi.fn(async (path: string) => {
      if (path === '/stats') {
        return {
          documentedAssets: 1284,
          foiaRequests: 61,
          procurementRecords: 18,
          policiesTracked: 42,
          statuteJurisdictions: 57,
        };
      }
      throw new Error(`unexpected GET ${path}`);
    }),
  };
});

function renderLanding(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/map" element={<div data-testid="map-page">map</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  act(() => useStore.setState({ user: null, authReady: false }));
});

describe('marketing landing', () => {
  it('renders hero, capabilities, trust, security, and FAQ sections', async () => {
    renderLanding();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('See the cameras');
    expect(screen.getByText('A map with receipts')).toBeInTheDocument();
    expect(screen.getByText('Method before claims')).toBeInTheDocument();
    expect(screen.getByText(/Security & privacy, specifically/)).toBeInTheDocument();
    // FAQ shared verbatim with the Help page
    for (const item of FAQ.slice(0, 3)) {
      expect(screen.getByText(item.q)).toBeInTheDocument();
    }
  });

  it('shows live stats from the public endpoint', async () => {
    renderLanding();
    expect(await screen.findByText('1,284')).toBeInTheDocument();
    expect(screen.getByText('57')).toBeInTheDocument();
    expect(screen.getByText('Jurisdictions with statute coverage')).toBeInTheDocument();
  });

  it('links the legal and product surfaces from the footer', () => {
    renderLanding();
    const footer = screen.getByRole('navigation', { name: 'Footer' });
    for (const label of ['Privacy', 'Terms', 'Support', 'Help', 'API reference']) {
      expect(footer).toHaveTextContent(label);
    }
    expect(screen.getByText(/Not affiliated with, endorsed by, or connected to any surveillance vendor/)).toBeInTheDocument();
    expect(screen.getAllByText(/DeFlock/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/AGPL-3.0/).length).toBeGreaterThanOrEqual(1);
  });

  it('redirects signed-in visitors straight to the map once auth is ready', () => {
    act(() =>
      useStore.setState({
        authReady: true,
        user: { id: 'u1', email: 'x@y.z', name: 'X', role: 'editor' } as never,
      }),
    );
    renderLanding();
    expect(screen.getByTestId('map-page')).toBeInTheDocument();
    expect(screen.queryByText('A map with receipts')).not.toBeInTheDocument();
  });

  it('keeps rendering the page while auth is still resolving (no blank flash)', () => {
    renderLanding();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('never overpromises: forbidden marketing phrases stay out of the copy', () => {
    const { container } = renderLanding();
    const text = container.textContent ?? '';
    // Claims the product cannot back, or that Support-page wording already
    // walked back (export caps exist) — these must not reappear here.
    for (const banned of ['no locked features', 'guaranteed anonymity', 'military-grade', 'unhackable', '100% secure']) {
      expect(text.toLowerCase()).not.toContain(banned);
    }
  });

  it('falls back to the styled BNDR wordmark when the logo image fails', () => {
    renderLanding();
    const img = screen.getByAltText('BNDR');
    act(() => {
      img.dispatchEvent(new Event('error'));
    });
    expect(screen.getByLabelText('BNDR')).toHaveClass('bndr-word');
  });
});
