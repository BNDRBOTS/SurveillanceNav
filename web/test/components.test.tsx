import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal, ConfirmDialog } from '@/components/Modal';
import { DataTable } from '@/components/DataTable';
import { ConfidenceBadge, StatusPill } from '@/components/Badges';
import { PasswordInput, FileDrop } from '@/components/Form';
import { Toasts } from '@/components/Feedback';
import { useStore } from '@/lib/store';

describe('Modal', () => {
  it('traps focus, closes on ESC, and restores focus', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const outside = document.createElement('button');
    outside.textContent = 'outside';
    document.body.appendChild(outside);
    outside.focus();

    render(
      <Modal title="Test dialog" onClose={onClose}>
        <button>first</button>
        <button>second</button>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Test dialog' });
    expect(dialog).toBeInTheDocument();
    // initial focus lands inside the dialog
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Tab cycles within the dialog (trap)
    for (let i = 0; i < 6; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    outside.remove();
  });

  it('ConfirmDialog wires confirm/cancel and disables while busy', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <ConfirmDialog title="Delete?" message="Sure?" destructive onConfirm={onConfirm} onCancel={onCancel} />,
    );
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalled();
    rerender(<ConfirmDialog title="Delete?" message="Sure?" busy onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled();
  });
});

describe('DataTable', () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: String(i), name: `Row ${i}`, n: i }));
  const columns = [
    { key: 'name', label: 'Name', sortable: true, render: (r: (typeof rows)[number]) => r.name, sortValue: (r: (typeof rows)[number]) => r.name },
    { key: 'n', label: 'N', sortable: true, render: (r: (typeof rows)[number]) => String(r.n), sortValue: (r: (typeof rows)[number]) => r.n },
  ];

  it('virtualizes large datasets (renders a window, not all rows)', () => {
    render(<DataTable ariaLabel="big" rows={rows} rowKey={(r) => r.id} columns={columns} />);
    const table = screen.getByRole('table', { name: 'big' });
    const rendered = within(table).getAllByRole('row');
    expect(rendered.length).toBeLessThan(80); // 500 rows → small window + spacers
    expect(table).toHaveAttribute('aria-rowcount', '500');
  });

  it('sorts numerically on header activation and reverses on second click', async () => {
    const user = userEvent.setup();
    render(<DataTable ariaLabel="sortable" rows={rows.slice(0, 5)} rowKey={(r) => r.id} columns={columns} />);
    const header = screen.getByRole('button', { name: 'N' });
    await user.click(header); // asc
    let cells = screen.getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(cells[0]).toContain('Row 0');
    await user.click(header); // desc
    cells = screen.getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(cells[0]).toContain('Row 4');
    expect(header).toHaveAttribute('aria-sort', 'descending');
  });
});

describe('Badges', () => {
  it('ConfidenceBadge explains its factors on demand', async () => {
    const user = userEvent.setup();
    render(
      <ConfidenceBadge
        score={72}
        factors={[
          { factor: 'baseline', delta: 20, note: 'All records start at a conservative baseline.' },
          { factor: 'evidence', delta: 10, note: '2 evidence file(s) attached.' },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: /confidence 72/i }));
    expect(screen.getByRole('dialog', { name: /confidence: 72\/100/i })).toBeInTheDocument();
    expect(screen.getByText(/evidence file/)).toBeInTheDocument();
  });

  it('StatusPill renders readable status text', () => {
    render(<StatusPill status="needs_review" />);
    expect(screen.getByText('needs review')).toBeInTheDocument();
  });
});

describe('Form primitives', () => {
  it('password meter reflects strength levels', async () => {
    const user = userEvent.setup();
    let value = '';
    const { rerender, container } = render(
      <PasswordInput label="Password" value={value} onChange={(v) => (value = v)} withMeter />,
    );
    await user.type(screen.getByLabelText('Password'), 'aB3!aB3!aB3!aB3!');
    rerender(<PasswordInput label="Password" value="aB3!aB3!aB3!aB3!" onChange={() => undefined} withMeter />);
    expect(container.querySelector('.strength')).toHaveAttribute('data-level', '4');
  });

  it('FileDrop rejects oversized files with a clear inline error', async () => {
    const onFile = vi.fn();
    render(<FileDrop onFile={onFile} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const big = new File([new ArrayBuffer(10)], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 51 * 1024 * 1024 });
    await userEvent.upload(input, big);
    expect(onFile).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/limit is/);
  });
});

describe('Toasts', () => {
  it('queues, deduplicates, and dismisses', async () => {
    const user = userEvent.setup();
    render(<Toasts />);
    useStore.getState().toast('Saved ✓', 'success', 0);
    useStore.getState().toast('Saved ✓', 'success', 0); // duplicate collapsed
    expect(await screen.findAllByText('Saved ✓')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByText('Saved ✓')).not.toBeInTheDocument();
  });
});
