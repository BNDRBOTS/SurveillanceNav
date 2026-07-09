import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DISCLAIMER_VERSIONS } from '@stn/shared';
import { EntryGate } from '@/components/EntryGate';
import { useStore } from '@/lib/store';

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <EntryGate />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.removeItem('stn.ack.entry');
  useStore.getState().setUser(null);
  useStore.getState().setAuthReady();
});

describe('entry disclaimer gate', () => {
  it('blocks the app surface for a fresh anonymous visitor', () => {
    renderAt('/map');
    expect(screen.getByRole('dialog', { name: /before you use this tool/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /close dialog/i })).not.toBeInTheDocument(); // truly blocking
  });

  it('accepting records the version on the device and unblocks', async () => {
    const user = userEvent.setup();
    renderAt('/map');
    await user.click(screen.getByRole('button', { name: /i understand and accept/i }));
    expect(localStorage.getItem('stn.ack.entry')).toBe(String(DISCLAIMER_VERSIONS.entry));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('stays off legal and auth pages so the terms are readable pre-acceptance', () => {
    for (const path of ['/terms', '/privacy', '/login', '/signup', '/support']) {
      const { unmount } = renderAt(path);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('re-blocks when the disclaimer version advances past the stored one', () => {
    localStorage.setItem('stn.ack.entry', '0'); // older than any current version
    renderAt('/map');
    expect(screen.getByRole('dialog', { name: /before you use this tool/i })).toBeInTheDocument();
  });
});
