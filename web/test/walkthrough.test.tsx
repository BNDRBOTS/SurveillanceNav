import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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

describe('anchored coach-marks (walkthrough v2)', () => {
  const rect = (r: Partial<DOMRect>): DOMRect =>
    ({ top: 100, left: 300, bottom: 132, right: 420, width: 120, height: 32, x: 300, y: 100, toJSON: () => ({}), ...r }) as DOMRect;

  function mountTarget(anchor: string, r: Partial<DOMRect> = {}): HTMLElement {
    const el = document.createElement('button');
    el.setAttribute('data-tour', anchor);
    document.body.appendChild(el);
    el.getBoundingClientRect = () => rect(r);
    return el;
  }

  afterEach(() => {
    document.querySelectorAll('[data-tour]').forEach((el) => el.remove());
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true, writable: true });
  });

  it('renders a floating coach-mark with a highlight ring when the target exists', () => {
    mountTarget('map-filters');
    render(<Toasts />);
    act(() =>
      useStore.getState().startWalkthrough('map', [
      { title: 'Anchored step', body: 'Points at the filters button.', anchor: 'map-filters' },
      ]),
    );
    const card = document.querySelector('.coachmark');
    expect(card).toBeTruthy();
    expect(document.querySelector('.toast.walkthrough')).toBeNull();
    const ring = document.querySelector<HTMLElement>('.coachmark-ring')!;
    expect(ring.style.top).toBe('94px'); // target top 100 − 6px pad
    expect(ring.style.left).toBe('294px');
    expect(document.querySelector('.coachmark-caret')).toBeTruthy();
  });

  it('prefers placement below, flips above when the viewport bottom is tight', () => {
    mountTarget('map-filters', { top: 700, bottom: 730, y: 700 });
    render(<Toasts />);
    act(() =>
      useStore.getState().startWalkthrough('map', [
      { title: 'Low target', body: 'No room below — the card flips on top.', anchor: 'map-filters' },
      ]),
    );
    expect(document.querySelector('.coachmark')!.getAttribute('data-place')).toBe('top');
  });

  it('falls back to the bottom card when the anchor target is missing', () => {
    render(<Toasts />);
    act(() =>
      useStore.getState().startWalkthrough('map', [
      { title: 'Orphan step', body: 'Anchor names an element that never mounted.', anchor: 'no-such-target' },
      ]),
    );
    expect(document.querySelector('.toast.walkthrough')).toBeTruthy();
    expect(document.querySelector('.coachmark')).toBeNull();
  });

  it('falls back to the bottom card on narrow viewports even with a live target', () => {
    Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true, writable: true });
    mountTarget('map-filters');
    render(<Toasts />);
    act(() =>
      useStore.getState().startWalkthrough('map', [
      { title: 'Mobile step', body: 'Coach-marks are desktop-only; mobile keeps the card.', anchor: 'map-filters' },
      ]),
    );
    expect(document.querySelector('.toast.walkthrough')).toBeTruthy();
    expect(document.querySelector('.coachmark')).toBeNull();
  });

  it('advances and skips from the coach-mark controls', async () => {
    const user = userEvent.setup();
    mountTarget('map-filters');
    render(<Toasts />);
    act(() =>
      useStore.getState().startWalkthrough('map', [
      { title: 'First anchored', body: 'Anchored to the filters button first.', anchor: 'map-filters' },
      { title: 'Then plain', body: 'Second step has no anchor and drops to the card.' },
      ]),
    );
    expect(document.querySelector('.coachmark')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Then plain')).toBeInTheDocument();
    expect(document.querySelector('.coachmark')).toBeNull(); // anchorless → bottom card
    await user.click(screen.getByRole('button', { name: 'Skip tour' }));
    expect(useStore.getState().walkthrough).toBeNull();
  });

  it('tilts with the pointer, and stays flat under reduced motion', () => {
    mountTarget('map-filters');
    render(<Toasts />);
    act(() =>
      useStore.getState().startWalkthrough('map', [
      { title: 'Tilt step', body: 'The card leans toward the pointer, gently.', anchor: 'map-filters' },
      ]),
    );
    const card = document.querySelector<HTMLElement>('.coachmark')!;
    card.getBoundingClientRect = () => rect({ top: 200, bottom: 380, left: 200, right: 540, width: 340, height: 180 });
    // jsdom has no PointerEvent — a MouseEvent with the pointermove type carries coords
    fireEvent(card, new MouseEvent('pointermove', { bubbles: true, clientX: 540, clientY: 200 }));
    const tiltY = parseFloat(card.style.getPropertyValue('--tilt-y'));
    const tiltX = parseFloat(card.style.getPropertyValue('--tilt-x'));
    expect(tiltY).toBeGreaterThan(0);
    expect(Math.abs(tiltY)).toBeLessThanOrEqual(4);
    expect(Math.abs(tiltX)).toBeLessThanOrEqual(4);

    fireEvent.pointerLeave(card);
    expect(card.style.getPropertyValue('--tilt-x')).toBe('0deg');

    act(() => useStore.setState({ reducedMotion: true }));
    fireEvent(card, new MouseEvent('pointermove', { bubbles: true, clientX: 540, clientY: 200 }));
    expect(card.style.getPropertyValue('--tilt-x')).toBe('0deg');
    act(() => useStore.setState({ reducedMotion: false }));
  });

  it('every tour anchor has a matching data-tour attribute in the codebase', async () => {
    // Guard against anchor tokens drifting from the page markup: collect the
    // tokens used in tours and assert each appears in a source file.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = path.resolve(__dirname, '../src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(tsx|ts)$/.test(entry.name)) files.push(full);
      }
    };
    walk(src);
    const all = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const anchors = Object.values(TOURS).flatMap((t) => t.steps.map((s) => s.anchor).filter(Boolean));
    expect(anchors.length).toBeGreaterThanOrEqual(10);
    for (const anchor of anchors) {
      expect(all, `data-tour="${anchor}" missing from src`).toContain(`data-tour="${anchor}"`);
    }
  });
});
