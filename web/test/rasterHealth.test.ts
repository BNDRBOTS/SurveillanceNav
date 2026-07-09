import { describe, it, expect } from 'vitest';
import { initialRasterHealth, rasterHealthNext, type RasterHealth } from '@/map/rasterHealth';

function run(events: Array<'error' | 'tileLoaded' | 'timerFired' | 'reset'>) {
  let state: RasterHealth = initialRasterHealth();
  const actions: string[] = [];
  for (const e of events) {
    const r = rasterHealthNext(state, e);
    state = r.state;
    actions.push(r.action);
  }
  return { state, actions };
}

describe('raster fallback state machine', () => {
  it('two errors alone never arm the fallback', () => {
    const { state, actions } = run(['error', 'error']);
    expect(state.armed).toBe(false);
    expect(actions).toEqual(['none', 'none']);
  });

  it('three errors with zero loaded tiles arm the grace timer', () => {
    const { state, actions } = run(['error', 'error', 'error']);
    expect(state.armed).toBe(true);
    expect(actions[2]).toBe('armTimer');
  });

  it('a single loaded tile before the threshold vetoes arming forever', () => {
    const { state, actions } = run(['error', 'tileLoaded', 'error', 'error', 'error', 'error']);
    expect(state.armed).toBe(false);
    expect(actions).not.toContain('armTimer');
    expect(state.resolved).toBe('none');
  });

  it('a tile that loads while armed disarms the timer', () => {
    const { state, actions } = run(['error', 'error', 'error', 'tileLoaded']);
    expect(actions[3]).toBe('disarmTimer');
    expect(state.armed).toBe(false);
    expect(state.resolved).toBe('none');
  });

  it('timer expiry with zero loads resolves to fallback', () => {
    const { state, actions } = run(['error', 'error', 'error', 'timerFired']);
    expect(actions[3]).toBe('fallback');
    expect(state.resolved).toBe('fallback');
  });

  it('tiles arriving after fallback recover the raster view', () => {
    const { state, actions } = run(['error', 'error', 'error', 'timerFired', 'tileLoaded']);
    expect(actions[4]).toBe('recover');
    expect(state.resolved).toBe('none');
  });

  it('reset (style switch) clears everything and disarms a pending timer', () => {
    const { state, actions } = run(['error', 'error', 'error', 'reset']);
    expect(actions[3]).toBe('disarmTimer');
    expect(state).toEqual(initialRasterHealth());
  });

  it('stale timer after disarm-by-tile does not fall back', () => {
    const { state } = run(['error', 'error', 'error', 'tileLoaded', 'timerFired']);
    expect(state.resolved).toBe('none');
  });
});
