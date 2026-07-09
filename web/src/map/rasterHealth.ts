/**
 * Raster basemap health state machine — pure logic, no map dependency.
 *
 * The old behavior toasted "tiles unavailable" on the FIRST raster error,
 * which fires during perfectly normal style transitions and slow first
 * tiles. The machine instead requires sustained evidence of failure:
 * three errors with zero successfully loaded tiles arms a grace timer;
 * only if the timer expires with still zero loaded tiles do we resolve to
 * the offline vector fallback — silently (a chrome pill, not a toast).
 * A single loaded tile at any point vetoes the fallback; tiles that start
 * loading after a fallback recover the raster view automatically.
 */

export interface RasterHealth {
  errors: number;
  loaded: number;
  armed: boolean;
  resolved: 'none' | 'fallback';
}

export type RasterAction = 'none' | 'armTimer' | 'disarmTimer' | 'fallback' | 'recover';

export const FALLBACK_ERROR_THRESHOLD = 3;
export const FALLBACK_GRACE_MS = 4000;

export const initialRasterHealth = (): RasterHealth => ({
  errors: 0,
  loaded: 0,
  armed: false,
  resolved: 'none',
});

export function rasterHealthNext(
  state: RasterHealth,
  event: 'error' | 'tileLoaded' | 'timerFired' | 'reset',
): { state: RasterHealth; action: RasterAction } {
  switch (event) {
    case 'reset':
      return { state: initialRasterHealth(), action: state.armed ? 'disarmTimer' : 'none' };

    case 'tileLoaded': {
      const next = { ...state, loaded: state.loaded + 1 };
      if (state.resolved === 'fallback') {
        // tiles came back after we fell back — undo the fallback
        return { state: { ...next, resolved: 'none' as const, armed: false }, action: 'recover' };
      }
      if (state.armed) return { state: { ...next, armed: false }, action: 'disarmTimer' };
      return { state: next, action: 'none' };
    }

    case 'error': {
      const next = { ...state, errors: state.errors + 1 };
      const shouldArm =
        !state.armed &&
        state.resolved === 'none' &&
        next.errors >= FALLBACK_ERROR_THRESHOLD &&
        state.loaded === 0;
      if (shouldArm) return { state: { ...next, armed: true }, action: 'armTimer' };
      return { state: next, action: 'none' };
    }

    case 'timerFired': {
      if (state.resolved === 'none' && state.loaded === 0 && state.armed) {
        return { state: { ...state, armed: false, resolved: 'fallback' }, action: 'fallback' };
      }
      return { state: { ...state, armed: false }, action: 'none' };
    }
  }
}
