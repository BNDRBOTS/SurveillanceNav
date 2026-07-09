import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toasts } from '@/components/Feedback';
import { useStore } from '@/lib/store';

beforeEach(() => {
  for (const t of useStore.getState().toasts) useStore.getState().dismissToast(t.id);
});

describe('toast actions', () => {
  it('renders the action button, runs it once, and dismisses', async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    render(<Toasts />);
    useStore.getState().toast('Base map failed to load.', 'error', 0, { label: 'Send error report', run });
    expect(await screen.findByText('Base map failed to load.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Send error report' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Base map failed to load.')).not.toBeInTheDocument();
  });

  it('plain toasts render without an action button', async () => {
    render(<Toasts />);
    useStore.getState().toast('Saved.', 'success', 0);
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send error report' })).not.toBeInTheDocument();
  });
});
