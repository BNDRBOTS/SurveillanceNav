import { useEffect, useRef, useState } from 'react';
import {
  appleMapsDirectionsUrl,
  formatDistance,
  googleMapsDirectionsUrl,
  parseCoordinates,
} from '@stn/shared';
import { get } from '@/lib/api';
import { useStore } from '@/lib/store';
import { haptics } from '@/lib/haptics';
import { useDebounce } from '@/lib/useDebounce';
import { Icon } from '@/components/Icon';
import type { NavState, RouteResponse } from './useNavigation';

/**
 * Directions panel: A→B with geocoded search (or "my location" / map tap /
 * pasted coordinates), camera-avoidance on by default, honest comparison
 * against the fastest route, one-tap handoff to Google/Apple Maps pinned
 * through the avoidance via-points, and in-app turn-by-turn.
 */

export interface NavEndpoint {
  label: string;
  lng: number;
  lat: number;
}

interface GeocodeHit {
  label: string;
  lng: number;
  lat: number;
}

function fmtDuration(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function EndpointInput({
  placeholder,
  value,
  onSelect,
  onUseMyLocation,
  pickLabel,
  onPickOnMap,
}: {
  placeholder: string;
  value: NavEndpoint | null;
  onSelect: (e: NavEndpoint | null) => void;
  onUseMyLocation?: () => void;
  pickLabel: string;
  onPickOnMap: () => void;
}): JSX.Element {
  const [text, setText] = useState('');
  const [hits, setHits] = useState<GeocodeHit[]>([]);
  const [searching, setSearching] = useState(false);
  const debounced = useDebounce(text, 300);
  const toast = useStore((s) => s.toast);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (value) return; // a selection is showing — no live search
    const q = debounced.trim();
    const coords = parseCoordinates(q);
    if (coords) {
      setHits([{ label: `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`, ...coords }]);
      return;
    }
    if (q.length < 3) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    get<{ items: GeocodeHit[] }>(`/geo/search?q=${encodeURIComponent(q)}`)
      .then((res) => {
        if (!cancelled) setHits(res.items);
      })
      .catch((err) => {
        if (!cancelled) {
          setHits([]);
          toast((err as Error).message, 'warning', 6000);
        }
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, value, toast]);

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <div className="row" style={{ gap: 6 }}>
        <input
          className="input"
          style={{ minHeight: 44 }}
          placeholder={placeholder}
          aria-label={placeholder}
          value={value ? value.label : text}
          onChange={(e) => {
            onSelect(null);
            setText(e.target.value);
          }}
          onFocus={() => value && onSelect(null)}
        />
        {onUseMyLocation ? (
          <button type="button" className="btn btn-icon btn-ghost" title="Use my location" aria-label="Use my location" onClick={onUseMyLocation}>
            <Icon name="locate" size={18} />
          </button>
        ) : null}
        <button type="button" className="btn btn-icon btn-ghost" title={pickLabel} aria-label={pickLabel} onClick={onPickOnMap}>
          <Icon name="map-pin" size={18} />
        </button>
      </div>
      {!value && (hits.length > 0 || searching) ? (
        <div className="menu" style={{ left: 0, right: 0, top: 'calc(100% + 4px)' }} role="listbox" aria-label="Search results">
          {searching ? <p className="text-xs text-secondary" style={{ padding: 'var(--space-xs) var(--space-sm)' }}>searching…</p> : null}
          {hits.map((h, i) => (
            <button
              key={i}
              type="button"
              role="option"
              aria-selected="false"
              onClick={() => {
                onSelect({ label: h.label.split(',').slice(0, 3).join(','), lng: h.lng, lat: h.lat });
                setText('');
                setHits([]);
                haptics.light();
              }}
            >
              <span className="text-sm">{h.label.length > 70 ? `${h.label.slice(0, 69)}…` : h.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function NavigatePanel({
  nav,
  origin,
  destination,
  setOrigin,
  setDestination,
  mode,
  setMode,
  avoidEnabled,
  setAvoidEnabled,
  onGo,
  onClose,
  onPick,
  onUseRoute,
  onStart,
  onStop,
  onVoice,
}: {
  nav: NavState;
  origin: NavEndpoint | null;
  destination: NavEndpoint | null;
  setOrigin: (e: NavEndpoint | null) => void;
  setDestination: (e: NavEndpoint | null) => void;
  mode: 'driving' | 'walking' | 'cycling';
  setMode: (m: 'driving' | 'walking' | 'cycling') => void;
  avoidEnabled: boolean;
  setAvoidEnabled: (v: boolean) => void;
  onGo: () => void;
  onClose: () => void;
  onPick: (which: 'origin' | 'destination') => void;
  onUseRoute: (which: 'avoidant' | 'fastest') => void;
  onStart: () => void;
  onStop: () => void;
  onVoice: (on: boolean) => void;
}): JSX.Element {
  const toast = useStore((s) => s.toast);
  const result: RouteResponse | null = nav.result;
  const active = nav.active;
  const [stepsOpen, setStepsOpen] = useState(false);
  const [googleAvailable, setGoogleAvailable] = useState(false);
  const [preferGoogle, setPreferGoogle] = useState(() => localStorage.getItem('stn.preferGoogle') === 'true');
  useEffect(() => {
    get<{ googleAvailable: boolean }>('/navigation/config')
      .then((c) => setGoogleAvailable(c.googleAvailable))
      .catch(() => undefined);
  }, []);

  const useMyLocation = () => {
    if (!('geolocation' in navigator)) {
      toast('Location unavailable on this device — search or tap the map instead.', 'warning');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setOrigin({ label: 'My location', lng: pos.coords.longitude, lat: pos.coords.latitude }),
      () => toast('Couldn’t get your location — search for a starting point, or tap the map to drop one.', 'warning', 7000),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  const avoided = result?.avoidant && result.fastest ? Math.max(0, result.fastest.exposure.count - result.avoidant.exposure.count) : 0;
  const extraSec = result?.avoidant ? result.avoidant.durationS - result.fastest.durationS : 0;
  const usingAvoidant = active === result?.avoidant;

  /* -------- live navigation HUD -------- */
  if (nav.phase === 'navigating' && active) {
    const next = active.steps[Math.min(nav.nextStepIndex, active.steps.length - 1)]!;
    return (
      <div className="navhud" role="region" aria-label="Turn-by-turn navigation">
        <div className="navhud-card">
          <span className="kicker">{formatDistance(nav.distanceToNextM)}</span>
          <strong>{next.instruction}</strong>
        </div>
        {nav.cameraAlert ? (
          <div className="banner" data-tone="danger" role="alert" style={{ borderRadius: 'var(--radius-md)' }}>
            <Icon name="camera" size={16} /> {nav.cameraAlert}
          </div>
        ) : null}
        <div className="navhud-bottom">
          <div className="col" style={{ gap: 0 }}>
            <strong>{fmtDuration(nav.remainingS)}</strong>
            <span className="text-xs text-secondary">{formatDistance(nav.remainingM)} left</span>
          </div>
          <span className="spacer" />
          <button type="button" className="btn btn-icon btn-ghost" aria-pressed={nav.voiceOn} aria-label={nav.voiceOn ? 'Mute voice' : 'Unmute voice'} onClick={() => onVoice(!nav.voiceOn)}>
            {nav.voiceOn ? <Icon name="volume-2" size={18} /> : <Icon name="volume-x" size={18} />}
          </button>
          <button type="button" className="btn btn-danger" onClick={onStop}>
            End
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="filtersheet" role="region" aria-label="Directions" style={{ width: 'min(360px, calc(100vw - 16px))' }}>
      <div className="filtersheet-header">
        <strong>Directions</strong>
        {result ? (
          <span className="pill" data-tone={result.avoidance === 'hard' ? 'success' : result.avoidance === 'best-effort' ? 'warning' : 'muted'}>
            {result.avoidance === 'hard' ? 'avoidance: guaranteed' : result.avoidance === 'best-effort' ? 'avoidance: best effort' : 'avoidance off'}
          </span>
        ) : null}
        <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close directions">
          <Icon name="x" size={18} />
        </button>
      </div>

      <div className="filtersheet-body col">
        {nav.phase === 'arrived' ? (
          <div className="banner" data-tone="info" style={{ borderRadius: 'var(--radius-md)' }}>
            <Icon name="flag" size={16} /> You arrived. Stay sharp out there.
          </div>
        ) : null}

        <EndpointInput placeholder="From — search, paste coordinates, or use my location" value={origin} onSelect={setOrigin} onUseMyLocation={useMyLocation} pickLabel="Tap the map to set start" onPickOnMap={() => onPick('origin')} />
        <EndpointInput placeholder="To — where are you headed?" value={destination} onSelect={setDestination} pickLabel="Tap the map to set destination" onPickOnMap={() => onPick('destination')} />

        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="row" style={{ gap: 6 }} role="radiogroup" aria-label="Travel mode">
            {(['driving', 'walking', 'cycling'] as const).map((m) => (
              <button key={m} type="button" className="chip" aria-pressed={mode === m} onClick={() => setMode(m)}>
                {m === 'driving' ? <Icon name="car" size={16} /> : m === 'walking' ? <Icon name="footprints" size={16} /> : <Icon name="bike" size={16} />} {m}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-icon btn-ghost"
            aria-label="Swap start and destination"
            title="Swap"
            onClick={() => {
              const o = origin;
              setOrigin(destination);
              setDestination(o);
            }}
          >
            <Icon name="arrow-up-down" size={18} />
          </button>
        </div>

        <label className="checkbox-row">
          <input type="checkbox" checked={avoidEnabled} onChange={(e) => setAvoidEnabled(e.target.checked)} />
          <span className="text-sm">
            <strong>Avoid known cameras</strong>
            <br />
            <span className="text-xs text-secondary">Routes around active LPRs, CCTV and sensors in the database</span>
          </span>
        </label>

        {googleAvailable ? (
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={preferGoogle}
              onChange={(e) => {
                setPreferGoogle(e.target.checked);
                localStorage.setItem('stn.preferGoogle', String(e.target.checked));
              }}
            />
            <span className="text-sm">
              <strong>Use Google routing</strong>
              <br />
              <span className="text-xs text-secondary">Google&rsquo;s directions (best-effort camera avoidance). Off keeps the private, hard-avoidance route.</span>
            </span>
          </label>
        ) : null}

        <button type="button" className="btn btn-primary" onClick={onGo} disabled={!origin || !destination || nav.phase === 'routing'}>
          {nav.phase === 'routing' ? 'Routing…' : 'Get route'}
        </button>

        {nav.error ? (
          <div className="banner" data-tone="danger" role="alert" style={{ borderRadius: 'var(--radius-md)' }}>
            {nav.error}
          </div>
        ) : null}

        {result && active ? (
          <>
            <div className="card col" style={{ gap: 6 }}>
              <div className="row-wrap" style={{ gap: 6 }}>
                <strong>{fmtDuration(active.durationS)}</strong>
                <span className="text-sm text-secondary">{formatDistance(active.distanceM)}</span>
                {result.avoidant ? (
                  <span className="pill" data-tone={active.exposure.count === 0 ? 'success' : 'warning'}>
                    {usingAvoidant
                      ? `passes ${active.exposure.count} camera${active.exposure.count === 1 ? '' : 's'}`
                      : `fastest — passes ${active.exposure.count}`}
                  </span>
                ) : (
                  <span className="pill" data-tone={active.exposure.count === 0 ? 'success' : 'danger'}>
                    passes {active.exposure.count} camera{active.exposure.count === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              {result.avoidant ? (
                <p className="text-xs text-secondary">
                  Avoids <strong className="text-accent">{avoided}</strong> of {result.fastest.exposure.count} cameras on the fastest route
                  {extraSec > 30 ? ` · costs ${fmtDuration(extraSec)} extra` : ' · no meaningful time cost'} · {result.camerasConsidered} checked
                </p>
              ) : null}
              {result.warnings.map((w, i) => (
                <p key={i} className="text-xs text-warning">
                  <Icon name="alert-triangle" size={14} /> {w}
                </p>
              ))}
              {result.avoidant ? (
                <div className="row" style={{ gap: 6 }}>
                  <button type="button" className="chip" aria-pressed={usingAvoidant} onClick={() => onUseRoute('avoidant')}>
                    <Icon name="shield" size={16} /> Avoidant
                  </button>
                  <button type="button" className="chip" aria-pressed={!usingAvoidant} onClick={() => onUseRoute('fastest')}>
                    <Icon name="zap" size={16} /> Fastest
                  </button>
                </div>
              ) : null}
            </div>

            <button type="button" className="btn btn-primary" onClick={onStart}>
              <Icon name="play" size={16} /> Start navigation
            </button>
            <div className="row" style={{ gap: 6 }}>
              <a
                className="btn btn-ghost"
                style={{ flex: 1 }}
                href={googleMapsDirectionsUrl(
                  { lng: origin!.lng, lat: origin!.lat },
                  { lng: destination!.lng, lat: destination!.lat },
                  active.geometry,
                  mode === 'cycling' ? 'bicycling' : mode,
                )}
                target="_blank"
                rel="noreferrer"
                onClick={() => haptics.light()}
              >
                Google Maps <Icon name="external-link" size={14} />
              </a>
              <a
                className="btn btn-ghost"
                style={{ flex: 1 }}
                href={appleMapsDirectionsUrl(
                  { lng: origin!.lng, lat: origin!.lat },
                  { lng: destination!.lng, lat: destination!.lat },
                  mode === 'cycling' ? 'bicycling' : mode,
                )}
                target="_blank"
                rel="noreferrer"
              >
                Apple Maps <Icon name="external-link" size={14} />
              </a>
            </div>
            <p className="text-xs text-secondary">
              Google/Apple follow your avoidance route via pinned waypoints — re-check the preview before driving.
            </p>

            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setStepsOpen((o) => !o)} aria-expanded={stepsOpen}>
              {stepsOpen ? 'Hide steps' : `Steps (${active.steps.length})`}
            </button>
            {stepsOpen ? (
              <ol className="col" style={{ gap: 4, paddingLeft: 'var(--space-lg)', margin: 0 }}>
                {active.steps.map((s, i) => (
                  <li key={i} className="text-sm">
                    {s.instruction} <span className="text-xs text-secondary">({formatDistance(s.distanceM)})</span>
                  </li>
                ))}
              </ol>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
