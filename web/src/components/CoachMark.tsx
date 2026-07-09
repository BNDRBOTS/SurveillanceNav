import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore, type WalkthroughState } from '@/lib/store';
import { announce } from '@/lib/announcer';
import { Icon } from './Icon';

/**
 * Desktop walkthrough v2: a floating heavy-glass coach-mark that points
 * directly at the element a step is about, with a soft highlight ring around
 * the target. Placement prefers below the target, then above, right, left —
 * always keeping 12px clear of both the target and the viewport edges. The
 * card carries a subtle pointer-driven 3D tilt (≤4°), disabled entirely under
 * reduced motion. Below 840px, or when a step has no anchor (or its target is
 * missing), the walkthrough falls back to the bottom card — the coach-mark is
 * an enhancement, never a requirement.
 */

type Place = 'bottom' | 'top' | 'right' | 'left';
const MARGIN = 12;
const RING_PAD = 6;

interface Layout {
  top: number;
  left: number;
  place: Place;
  caret: { x: number; y: number };
  ring: { top: number; left: number; width: number; height: number };
}

export function CoachMark({ wt, target }: { wt: WalkthroughState; target: HTMLElement }): JSX.Element {
  const advance = useStore((s) => s.advanceWalkthrough);
  const end = useStore((s) => s.endWalkthrough);
  const reducedMotion = useStore((s) => s.reducedMotion);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);

  const step = wt.steps[wt.index]!;
  const last = wt.index === wt.steps.length - 1;

  useEffect(() => {
    announce(`${step.title}. ${step.body}`);
  }, [step]);

  const compute = useCallback(() => {
    const r = target.getBoundingClientRect();
    const cw = cardRef.current?.offsetWidth || 340;
    const ch = cardRef.current?.offsetHeight || 180;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const fits: Record<Place, boolean> = {
      bottom: r.bottom + MARGIN + ch <= vh - MARGIN,
      top: r.top - MARGIN - ch >= MARGIN,
      right: r.right + MARGIN + cw <= vw - MARGIN,
      left: r.left - MARGIN - cw >= MARGIN,
    };
    const place: Place = (['bottom', 'top', 'right', 'left'] as Place[]).find((p) => fits[p]) ?? 'bottom';

    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let top: number;
    let left: number;
    if (place === 'bottom' || place === 'top') {
      top = place === 'bottom' ? r.bottom + MARGIN : r.top - MARGIN - ch;
      left = Math.min(Math.max(cx - cw / 2, MARGIN), Math.max(vw - cw - MARGIN, MARGIN));
    } else {
      left = place === 'right' ? r.right + MARGIN : r.left - MARGIN - cw;
      top = Math.min(Math.max(cy - ch / 2, MARGIN), Math.max(vh - ch - MARGIN, MARGIN));
    }
    const caret =
      place === 'bottom' || place === 'top'
        ? { x: Math.min(Math.max(cx - left, 20), cw - 20), y: 0 }
        : { x: 0, y: Math.min(Math.max(cy - top, 20), ch - 20) };

    setLayout({
      top,
      left,
      place,
      caret,
      ring: {
        top: r.top - RING_PAD,
        left: r.left - RING_PAD,
        width: r.width + RING_PAD * 2,
        height: r.height + RING_PAD * 2,
      },
    });
  }, [target]);

  useLayoutEffect(() => {
    compute();
  }, [compute, wt.index]);

  useEffect(() => {
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [compute]);

  const tiltOff =
    reducedMotion ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (tiltOff || !cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const dx = (e.clientX - rect.left) / Math.max(rect.width, 1) - 0.5;
    const dy = (e.clientY - rect.top) / Math.max(rect.height, 1) - 0.5;
    /* ±0.5 × 8 → ±4° maximum */
    cardRef.current.style.setProperty('--tilt-x', `${(-dy * 8).toFixed(2)}deg`);
    cardRef.current.style.setProperty('--tilt-y', `${(dx * 8).toFixed(2)}deg`);
  };
  const resetTilt = (): void => {
    cardRef.current?.style.setProperty('--tilt-x', '0deg');
    cardRef.current?.style.setProperty('--tilt-y', '0deg');
  };

  return createPortal(
    <>
      <div
        className="coachmark-ring"
        aria-hidden="true"
        style={
          layout
            ? { top: layout.ring.top, left: layout.ring.left, width: layout.ring.width, height: layout.ring.height }
            : { opacity: 0 }
        }
      />
      <div
        ref={cardRef}
        className="coachmark"
        data-place={layout?.place ?? 'bottom'}
        role="status"
        style={layout ? { top: layout.top, left: layout.left } : { visibility: 'hidden', top: 0, left: 0 }}
        onPointerMove={onPointerMove}
        onPointerLeave={resetTilt}
      >
        <span
          className="coachmark-caret"
          aria-hidden="true"
          style={
            layout
              ? layout.place === 'bottom' || layout.place === 'top'
                ? { left: layout.caret.x }
                : { top: layout.caret.y }
              : undefined
          }
        />
        <div className="col" style={{ gap: 'var(--space-xxs)' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="kicker">
              Walkthrough · {wt.index + 1} / {wt.steps.length}
            </span>
            <button type="button" className="coachmark-close" onClick={() => end()} aria-label="Dismiss walkthrough">
              <Icon name="x" size={16} />
            </button>
          </div>
          <strong>{step.title}</strong>
          <p className="text-sm text-secondary" style={{ margin: 0 }}>
            {step.body}
          </p>
          <div className="row" style={{ marginTop: 'var(--space-xs)', justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => end()}>
              Skip tour
            </button>
            {wt.index > 0 ? (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => advance(-1)}>
                Back
              </button>
            ) : null}
            <button type="button" className="btn btn-sm btn-primary" onClick={() => advance(1)}>
              {last ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
