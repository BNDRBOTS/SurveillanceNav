import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toasts } from '@/components/Feedback';
import { useStore } from '@/lib/store';
import { TOURS } from '@/lib/tours';

beforeEach(() => {
  useStore.getState().endWalkthrough();
});

describe('tour registry', () => {
  it('every tour has a key, path, blurb, and at least two steps', () => {
    const defs = Object.values(TOURS);
    expect(defs.length).toBeGreaterThanOrEqual(7);
    for (const tour of defs) {
      expect(tour.key).toBeTruthy();
      expect(tour.path.startsWith('/')).toBe(true);
      expect(tour.blurb.length).toBeGreaterThan(10);
      expect(tour.steps.length).toBeGreaterThanOrEqual(2);
      for (const step of tour.steps) {
        expect(step.title.length).toBeGreaterThan(3);
        expect(step.body.length).toBeGreaterThan(20);
      }
    }
  });
});

describe('walkthrough card', () => {
  it('steps forward and back, then completes on Done', async () => {
    const user = userEvent.setup();
    render(<Toasts />);
    useStore.getState().startWalkthrough('map', [
      { title: 'Step one', body: 'First things first.' },
      { title: 'Step two', body: 'Then this.' },
    ]);
    expect(await screen.findByText('Step one')).toBeInTheDocument();
    expect(screen.getByText(/1 \/ 2/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Step two')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Step one')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('Step two')).not.toBeInTheDocument();
    expect(useStore.getState().walkthrough).toBeNull();
  });

  it('can be skipped at any point', async () => {
    const user = userEvent.setup();
    render(<Toasts />);
    useStore.getState().startWalkthrough('foia', TOURS.foia!.steps);
    expect(await screen.findByText(TOURS.foia!.steps[0]!.title)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Skip tour' }));
    expect(useStore.getState().walkthrough).toBeNull();
  });

  it('ending a different page key leaves the active tour alone', () => {
    useStore.getState().startWalkthrough('map', TOURS.map!.steps);
    useStore.getState().endWalkthrough('reports');
    expect(useStore.getState().walkthrough?.key).toBe('map');
    useStore.getState().endWalkthrough('map');
    expect(useStore.getState().walkthrough).toBeNull();
  });
});
