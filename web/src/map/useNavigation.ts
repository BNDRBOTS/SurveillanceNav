import { useCallback, useEffect, useRef, useState } from 'react';
import { distanceToPolylineMeters, haversineMeters } from '@stn/shared';
import { post } from '@/lib/api';
import { useStore } from '@/lib/store';
import { haptics } from '@/lib/haptics';
import { announce } from '@/lib/announcer';

/**
 * Live turn-by-turn state machine on top of /navigation/route:
 * follows the user via watchPosition, speaks maneuvers (SpeechSynthesis,
 * mutable), raises camera-proximity alerts (voice + haptic + banner),
 * detects off-route (>60m for 2 fixes) and recomputes from the current
 * position, and holds a screen wake-lock while navigating. Every browser
 * capability degrades gracefully (no voice / no wake-lock / no geolocation
 * → clear messaging, never a crash).
 */

export interface NavStep {
  instruction: string;
  distanceM: number;
  durationS: number;
  lng: number;
  lat: number;
}

export interface NavRoute {
  geometry: Array<[number, number]>;
  distanceM: number;
  durationS: number;
  steps: NavStep[];
  exposure: { count: number; cameras: Array<{ id: string; name: string; lng: number; lat: number; technologyType: string }> };
}

export interface RouteResponse {
  engine: string;
  avoidance: 'hard' | 'best-effort' | 'off';
  avoidant: NavRoute | null;
  fastest: NavRoute;
  camerasConsidered: number;
  warnings: string[];
}

export interface NavState {
  phase: 'idle' | 'routing' | 'ready' | 'navigating' | 'arrived';
  result: RouteResponse | null;
  active: NavRoute | null;
  position: { lng: number; lat: number } | null;
  nextStepIndex: number;
  distanceToNextM: number;
  remainingM: number;
  remainingS: number;
  cameraAlert: string | null;
  error: string | null;
  voiceOn: boolean;
}

const OFF_ROUTE_M = 60;

export function useNavigation(args: {
  onRecompute: (from: { lng: number; lat: number }) => Promise<void>;
}) {
  const toast = useStore((s) => s.toast);
  const [state, setState] = useState<NavState>({
    phase: 'idle',
    result: null,
    active: null,
    position: null,
    nextStepIndex: 0,
    distanceToNextM: 0,
    remainingM: 0,
    remainingS: 0,
    cameraAlert: null,
    error: null,
    voiceOn: true,
  });
  const watchIdRef = useRef<number | null>(null);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const offRouteCountRef = useRef(0);
  const alertedCamerasRef = useRef<Set<string>>(new Set());
  const spokenStepRef = useRef(-1);
  const stateRef = useRef(state);
  stateRef.current = state;

  const speak = useCallback((text: string) => {
    if (!stateRef.current.voiceOn) return;
    try {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.05;
        window.speechSynthesis.speak(u);
      }
    } catch {
      /* voice is best-effort */
    }
  }, []);

  const compute = useCallback(
    async (
      origin: { lng: number; lat: number },
      destination: { lng: number; lat: number },
      mode: 'driving' | 'walking' | 'cycling',
      avoid: { enabled: boolean; minConfidence: number; bufferMeters: number },
    ): Promise<RouteResponse | null> => {
      setState((s) => ({ ...s, phase: 'routing', error: null }));
      try {
        const result = await post<RouteResponse>('/navigation/route', { origin, destination, mode, avoid });
        const active = result.avoidant ?? result.fastest;
        setState((s) => ({
          ...s,
          phase: 'ready',
          result,
          active,
          remainingM: active.distanceM,
          remainingS: active.durationS,
          nextStepIndex: 0,
        }));
        return result;
      } catch (err) {
        setState((s) => ({ ...s, phase: 'idle', error: (err as Error).message }));
        return null;
      }
    },
    [],
  );

  const stop = useCallback((arrived = false) => {
    if (watchIdRef.current !== null) {
      navigator.geolocation?.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    void wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* ignore */
    }
    alertedCamerasRef.current.clear();
    offRouteCountRef.current = 0;
    spokenStepRef.current = -1;
    setState((s) => ({ ...s, phase: arrived ? 'arrived' : s.result ? 'ready' : 'idle', cameraAlert: null }));
  }, []);

  const onPosition = useCallback(
    (pos: GeolocationPosition) => {
      const here = { lng: pos.coords.longitude, lat: pos.coords.latitude };
      const s = stateRef.current;
      const route = s.active;
      if (!route || s.phase !== 'navigating') return;

      // arrival check
      const end = route.geometry[route.geometry.length - 1]!;
      if (haversineMeters(here.lng, here.lat, end[0], end[1]) < 35) {
        speak('You have arrived.');
        haptics.success();
        stop(true);
        return;
      }

      // off-route detection → recompute from current position
      const offBy = distanceToPolylineMeters(here.lng, here.lat, route.geometry);
      if (offBy > OFF_ROUTE_M) {
        offRouteCountRef.current += 1;
        if (offRouteCountRef.current >= 2) {
          offRouteCountRef.current = 0;
          speak('Recalculating.');
          void args.onRecompute(here);
          return;
        }
      } else {
        offRouteCountRef.current = 0;
      }

      // progress: next maneuver + remaining estimates
      let nextIdx = s.nextStepIndex;
      while (
        nextIdx < route.steps.length - 1 &&
        haversineMeters(here.lng, here.lat, route.steps[nextIdx]!.lng, route.steps[nextIdx]!.lat) < 25
      ) {
        nextIdx += 1;
      }
      const next = route.steps[Math.min(nextIdx, route.steps.length - 1)]!;
      const distToNext = haversineMeters(here.lng, here.lat, next.lng, next.lat);
      const remainingAfter = route.steps.slice(nextIdx).reduce((acc, st) => acc + st.distanceM, 0);
      const remainingM = Math.round(distToNext + remainingAfter);
      const frac = route.distanceM > 0 ? remainingM / route.distanceM : 0;
      const remainingS = Math.round(route.durationS * Math.min(1, frac));

      // voice the upcoming maneuver once, ~where it matters
      if (nextIdx !== spokenStepRef.current && distToNext < 220) {
        spokenStepRef.current = nextIdx;
        speak(next.instruction);
      }

      // camera proximity alerts (once per camera)
      let cameraAlert: string | null = null;
      for (const cam of route.exposure.cameras) {
        const d = haversineMeters(here.lng, here.lat, cam.lng, cam.lat);
        if (d < 250 && !alertedCamerasRef.current.has(cam.id)) {
          alertedCamerasRef.current.add(cam.id);
          cameraAlert = `${cam.name} — ${Math.round(d)} m ahead`;
          speak(`Heads up: camera in ${Math.round(d / 10) * 10} meters.`);
          haptics.medium();
          announce(`Camera nearby: ${cam.name}`);
          break;
        }
      }

      setState((prev) => ({
        ...prev,
        position: here,
        nextStepIndex: nextIdx,
        distanceToNextM: Math.round(distToNext),
        remainingM,
        remainingS,
        ...(cameraAlert ? { cameraAlert } : {}),
      }));
    },
    [args, speak, stop],
  );

  const start = useCallback(() => {
    if (!stateRef.current.active) return;
    if (!('geolocation' in navigator)) {
      toast('Live navigation needs location access — this device does not support it. The route and steps still work.', 'warning', 8000);
      return;
    }
    setState((s) => ({ ...s, phase: 'navigating', cameraAlert: null }));
    speak('Starting navigation.');
    haptics.light();
    watchIdRef.current = navigator.geolocation.watchPosition(
      onPosition,
      (err) => {
        toast(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied — navigation paused. You can still follow the written steps.'
            : 'Lost location fix — still trying…',
          'warning',
          7000,
        );
        if (err.code === err.PERMISSION_DENIED) stop();
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15_000 },
    );
    // keep the screen awake (best-effort)
    void (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock
      ?.request('screen')
      .then((lock) => {
        wakeLockRef.current = lock;
      })
      .catch(() => undefined);
  }, [onPosition, speak, stop, toast]);

  // re-acquire wake lock when returning to the tab mid-navigation
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'visible' && stateRef.current.phase === 'navigating' && !wakeLockRef.current) {
        void (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock
          ?.request('screen')
          .then((lock) => {
            wakeLockRef.current = lock;
          })
          .catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  // cleanup on unmount
  useEffect(() => () => stop(), [stop]);

  const setVoice = useCallback((on: boolean) => setState((s) => ({ ...s, voiceOn: on })), []);
  const reset = useCallback(() => {
    stop();
    setState((s) => ({ ...s, phase: 'idle', result: null, active: null, error: null }));
  }, [stop]);
  const useRoute = useCallback((which: 'avoidant' | 'fastest') => {
    setState((s) => {
      const active = which === 'avoidant' ? (s.result?.avoidant ?? s.result?.fastest ?? null) : (s.result?.fastest ?? null);
      return active ? { ...s, active, remainingM: active.distanceM, remainingS: active.durationS, nextStepIndex: 0 } : s;
    });
  }, []);

  return { state, compute, start, stop, reset, setVoice, useRoute };
}
