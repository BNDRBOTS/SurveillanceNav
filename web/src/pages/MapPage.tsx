import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  TECHNOLOGY_LABELS,
  TECH_COLORS,
  formatDistance,
  type Jurisdiction,
  type LayerPreset,
  type SurveillanceAsset,
  type TechnologyType,
} from '@stn/shared';
import { MapCanvas, DEFAULT_LAYERS, type LayerConfig } from '@/map/MapCanvas';
import { useMapAssets, DEFAULT_FILTERS, type MapFilters } from '@/map/useAssets';
import { AssetDrawer } from '@/map/AssetDrawer';
import { FilterSheet } from '@/map/FilterSheet';
import type { BaseStyle } from '@/map/mapStyle';
import { BASE_STYLES } from '@/map/mapStyle';
import { get, post, del, ApiError } from '@/lib/api';
import { useStore } from '@/lib/store';
import { Modal } from '@/components/Modal';
import { TextInput, Select } from '@/components/Form';
import { haptics } from '@/lib/haptics';

const DEFAULT_CAMERA = { lng: -96.9, lat: 38.5, zoom: 4 };

function filtersFromParams(params: URLSearchParams): MapFilters {
  return {
    ...DEFAULT_FILTERS,
    technologyType: params.getAll('tech'),
    status: params.getAll('status'),
    sourceType: params.getAll('src'),
    minConfidence: Number(params.get('conf') ?? 0) || 0,
    vendor: params.get('vendor') ?? '',
    deployedAfter: params.get('after') ?? '',
    deployedBefore: params.get('before') ?? '',
    verification: params.get('ver') ?? '',
    q: params.get('q') ?? '',
  };
}

export default function MapPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const user = useStore((s) => s.user);
  const toast = useStore((s) => s.toast);
  const dataStale = useStore((s) => s.dataStale);

  const [camera, setCamera] = useState(() => ({
    lng: Number(params.get('lng') ?? DEFAULT_CAMERA.lng) || DEFAULT_CAMERA.lng,
    lat: Number(params.get('lat') ?? DEFAULT_CAMERA.lat) || DEFAULT_CAMERA.lat,
    zoom: Number(params.get('z') ?? DEFAULT_CAMERA.zoom) || DEFAULT_CAMERA.zoom,
  }));
  const [bbox, setBbox] = useState<[number, number, number, number] | null>(null);
  const [filters, setFilters] = useState<MapFilters>(() => filtersFromParams(params));
  const [layers, setLayers] = useState<LayerConfig>(DEFAULT_LAYERS);
  const [baseStyle, setBaseStyle] = useState<BaseStyle>((localStorage.getItem('stn.basestyle') as BaseStyle) ?? 'dark');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<string | null>(params.get('asset'));
  const [addMode, setAddMode] = useState(false);
  const [addLocation, setAddLocation] = useState<{ lng: number; lat: number } | null>(null);
  const [nearbyOpen, setNearbyOpen] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);

  const { data, loading, error, stale, truncated, refetch } = useMapAssets(bbox, camera.zoom, filters);

  /* URL state sync (shareable map links) */
  useEffect(() => {
    const next = new URLSearchParams();
    next.set('lng', camera.lng.toFixed(4));
    next.set('lat', camera.lat.toFixed(4));
    next.set('z', camera.zoom.toFixed(1));
    for (const t of filters.technologyType) next.append('tech', t);
    for (const s of filters.status) next.append('status', s);
    for (const s of filters.sourceType) next.append('src', s);
    if (filters.minConfidence > 0) next.set('conf', String(filters.minConfidence));
    if (filters.vendor) next.set('vendor', filters.vendor);
    if (filters.deployedAfter) next.set('after', filters.deployedAfter);
    if (filters.deployedBefore) next.set('before', filters.deployedBefore);
    if (filters.verification) next.set('ver', filters.verification);
    if (filters.q) next.set('q', filters.q);
    if (selectedAsset) next.set('asset', selectedAsset);
    setParams(next, { replace: true });
  }, [camera, filters, selectedAsset, setParams]);

  /* shared preset via URL (?preset=token) */
  useEffect(() => {
    const token = params.get('preset');
    if (!token) return;
    void get<{ name: string; config: Record<string, unknown> }>(`/presets/shared/${token}`)
      .then((preset) => {
        applyPresetConfig(preset.config);
        toast(`Loaded shared view "${preset.name}"`, 'success');
      })
      .catch(() => toast('That shared map link is invalid or was deleted.', 'warning'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyPresetConfig = (config: Record<string, unknown>) => {
    const cfg = config as {
      baseStyle?: BaseStyle;
      layers?: Record<string, boolean>;
      heatmap?: boolean;
      clustering?: boolean;
      filters?: Partial<MapFilters>;
      camera?: { lng: number; lat: number; zoom: number };
    };
    if (cfg.baseStyle) setBaseStyle(cfg.baseStyle);
    setLayers((l) => ({
      clustering: cfg.clustering ?? l.clustering,
      heatmap: cfg.heatmap ?? l.heatmap,
      techVisible: { ...l.techVisible, ...(cfg.layers ?? {}) },
    }));
    if (cfg.filters) setFilters((f) => ({ ...f, ...cfg.filters }));
    if (cfg.camera) setCamera(cfg.camera);
  };

  const onViewChange = useCallback(
    (view: { lng: number; lat: number; zoom: number; bbox: [number, number, number, number] }) => {
      setCamera({ lng: view.lng, lat: view.lat, zoom: view.zoom });
      setBbox(view.bbox);
    },
    [],
  );

  const resultCount = data ? (data.clustered ? data.features.reduce((acc, f) => acc + Number(f.properties.count ?? 1), 0) : (data.total ?? data.features.length)) : null;

  return (
    <div className="map-page">
      <MapCanvas
        data={data}
        baseStyle={baseStyle}
        layers={layers}
        camera={camera}
        onViewChange={onViewChange}
        onSelect={(id) => setSelectedAsset(id)}
        onMapClick={(lngLat) => {
          if (addMode) {
            setAddLocation(lngLat);
            setAddMode(false);
          }
        }}
        pickMode={addMode}
      />

      <div className="map-topleft">
        <button type="button" className="btn btn-sm" style={{ boxShadow: 'var(--shadow-2)' }} onClick={() => setFiltersOpen((o) => !o)} aria-expanded={filtersOpen}>
          ☰ Filters{filters.technologyType.length + filters.status.length > 0 ? ` (${filters.technologyType.length + filters.status.length})` : ''}
        </button>
        <button type="button" className="btn btn-sm" style={{ boxShadow: 'var(--shadow-2)' }} onClick={() => setLayersOpen(true)}>
          ▤ Layers
        </button>
        <button type="button" className="btn btn-sm" style={{ boxShadow: 'var(--shadow-2)' }} onClick={() => setNearbyOpen(true)}>
          ◎ Nearby
        </button>
        {user ? (
          <button type="button" className="btn btn-sm" style={{ boxShadow: 'var(--shadow-2)' }} onClick={() => setPresetsOpen(true)}>
            ★ Views
          </button>
        ) : null}
        {user && user.role !== 'viewer' ? (
          <button
            type="button"
            className={`btn btn-sm ${addMode ? 'btn-primary' : ''}`}
            style={{ boxShadow: 'var(--shadow-2)' }}
            onClick={() => {
              setAddMode((m) => !m);
              if (!addMode) toast('Tap the map where the asset is located.', 'info', 4000);
            }}
            aria-pressed={addMode}
          >
            ＋ Add asset
          </button>
        ) : null}
        <select
          className="input"
          style={{ minHeight: 34, width: 'auto', boxShadow: 'var(--shadow-2)', fontSize: 'var(--font-size-xs)' }}
          aria-label="Base map style"
          value={baseStyle}
          onChange={(e) => {
            setBaseStyle(e.target.value as BaseStyle);
            localStorage.setItem('stn.basestyle', e.target.value);
          }}
        >
          {BASE_STYLES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
              {s.online ? ' (online)' : ''}
            </option>
          ))}
        </select>
        {(stale || dataStale) && (
          <span className="pill" data-tone="warning" title="Data served from cache — may be out of date">
            cached data
          </span>
        )}
        {truncated ? (
          <span className="pill" data-tone="warning" title="Zoom in to see all matching assets — this view is capped">
            {resultCount?.toLocaleString()} results · zoom for all
          </span>
        ) : null}
        {error ? (
          <button type="button" className="pill" data-tone="danger" onClick={refetch} style={{ cursor: 'pointer' }}>
            load failed — retry
          </button>
        ) : null}
      </div>

      {filtersOpen ? (
        <FilterSheet filters={filters} onChange={setFilters} onClose={() => setFiltersOpen(false)} resultCount={resultCount} loading={loading} />
      ) : null}

      {layersOpen ? (
        <LayersModal layers={layers} onChange={setLayers} onClose={() => setLayersOpen(false)} />
      ) : null}

      {selectedAsset ? (
        <AssetDrawer assetId={selectedAsset} onClose={() => setSelectedAsset(null)} onNavigateAsset={(id) => setSelectedAsset(id)} />
      ) : null}

      {addLocation ? (
        <AddAssetModal
          location={addLocation}
          onClose={() => setAddLocation(null)}
          onCreated={(id) => {
            setAddLocation(null);
            setSelectedAsset(id);
            refetch();
          }}
        />
      ) : null}

      {nearbyOpen ? <NearbyModal camera={camera} onClose={() => setNearbyOpen(false)} onSelect={(id) => { setNearbyOpen(false); setSelectedAsset(id); }} /> : null}

      {presetsOpen ? (
        <PresetsModal
          current={{ baseStyle, layers, filters, camera }}
          onApply={(cfg) => {
            applyPresetConfig(cfg);
            setPresetsOpen(false);
          }}
          onClose={() => setPresetsOpen(false)}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------ layers modal ------------------------------ */

function LayersModal({ layers, onChange, onClose }: { layers: LayerConfig; onChange: (l: LayerConfig) => void; onClose: () => void }): JSX.Element {
  return (
    <Modal title="Map layers" onClose={onClose}>
      <div className="col">
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={layers.clustering}
            onChange={(e) => onChange({ ...layers, clustering: e.target.checked })}
          />
          <span>
            <strong className="text-sm">Adaptive clustering</strong>
            <br />
            <span className="text-xs text-secondary">Group nearby points for smooth rendering at any scale</span>
          </span>
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={layers.heatmap} onChange={(e) => onChange({ ...layers, heatmap: e.target.checked })} />
          <span>
            <strong className="text-sm">Heatmap intensity</strong>
            <br />
            <span className="text-xs text-secondary">Density view — useful for spotting concentration patterns</span>
          </span>
        </label>
        <hr className="divider" />
        <strong className="text-sm">Technology layers</strong>
        {Object.entries(TECH_COLORS).map(([tech, color]) => (
          <label key={tech} className="checkbox-row" style={{ padding: '2px 0' }}>
            <input
              type="checkbox"
              checked={layers.techVisible[tech] ?? true}
              onChange={(e) => onChange({ ...layers, techVisible: { ...layers.techVisible, [tech]: e.target.checked } })}
            />
            <span className="row" style={{ gap: 6 }}>
              <span className="legend-dot" style={{ background: color }} />
              <span className="text-sm">{TECHNOLOGY_LABELS[tech as TechnologyType]}</span>
            </span>
          </label>
        ))}
      </div>
    </Modal>
  );
}

/* ------------------------------ add asset ------------------------------ */

function AddAssetModal({ location, onClose, onCreated }: { location: { lng: number; lat: number }; onClose: () => void; onCreated: (id: string) => void }): JSX.Element {
  const toast = useStore((s) => s.toast);
  const [name, setName] = useState('');
  const [tech, setTech] = useState<string>('cctv');
  const [vendor, setVendor] = useState('');
  const [status, setStatus] = useState('unverified');
  const [deploymentDate, setDeploymentDate] = useState('');
  const [jurisdictionQuery, setJurisdictionQuery] = useState('');
  const [jurisdictionId, setJurisdictionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const { data: jurisdictions } = useQuery({
    queryKey: ['jurisdictions', jurisdictionQuery],
    queryFn: () => get<{ items: Jurisdiction[] }>(`/jurisdictions?q=${encodeURIComponent(jurisdictionQuery)}`),
    enabled: jurisdictionQuery.length > 1,
  });

  const submit = async () => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Give the asset a descriptive name';
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    try {
      const created = await post<SurveillanceAsset>('/assets', {
        name: name.trim(),
        technologyType: tech,
        vendor: vendor.trim() || undefined,
        status,
        deploymentDate: deploymentDate || undefined,
        jurisdictionId,
        lng: location.lng,
        lat: location.lat,
        properties: {},
      });
      toast('Asset submitted. It starts as low-confidence until evidence and verification accumulate.', 'success', 7000);
      haptics.success();
      onCreated(created.id);
    } catch (err) {
      toast((err as ApiError).message, 'error', 8000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add surveillance asset"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? 'Submitting…' : 'Submit'}
          </button>
        </>
      }
    >
      <p className="text-xs text-secondary mono" style={{ marginBottom: 'var(--space-sm)' }}>
        📍 {location.lat.toFixed(5)}, {location.lng.toFixed(5)}
      </p>
      <p className="text-xs text-secondary" style={{ marginBottom: 'var(--space-sm)' }}>
        Privacy first: submit only what is observable from public space. Don’t include faces, plates, or personal
        information — uploads are scanned, and PII is held for review.
      </p>
      <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} placeholder="e.g. ALPR — Main St & 5th Ave (NE corner)" />
      <Select label="Technology" value={tech} onChange={(e) => setTech(e.target.value)}>
        {Object.entries(TECHNOLOGY_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </Select>
      <TextInput label="Vendor (if known)" value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="e.g. Flock Safety" />
      <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} hint="Choose 'unverified' unless you have direct knowledge">
        <option value="unverified">Unverified (default)</option>
        <option value="active">Active</option>
        <option value="proposed">Proposed</option>
        <option value="retired">Retired</option>
      </Select>
      <div className="field">
        <label htmlFor="add-deploy-date">Deployment date (if known)</label>
        <input id="add-deploy-date" type="date" className="input" value={deploymentDate} onChange={(e) => setDeploymentDate(e.target.value)} />
      </div>
      <TextInput label="Jurisdiction" value={jurisdictionQuery} onChange={(e) => { setJurisdictionQuery(e.target.value); setJurisdictionId(null); }} placeholder="Start typing a city or county…" hint={jurisdictionId ? '✓ selected' : undefined} />
      {jurisdictionQuery.length > 1 && !jurisdictionId && (jurisdictions?.items ?? []).length > 0 ? (
        <div className="col" style={{ gap: 2, marginTop: -8, marginBottom: 'var(--space-sm)' }}>
          {(jurisdictions?.items ?? []).slice(0, 5).map((j) => (
            <button key={j.id} type="button" className="btn btn-sm btn-ghost" style={{ justifyContent: 'flex-start' }} onClick={() => { setJurisdictionId(j.id); setJurisdictionQuery(j.name); }}>
              {j.name} <span className="text-xs text-secondary">({j.type})</span>
            </button>
          ))}
        </div>
      ) : null}
    </Modal>
  );
}

/* ------------------------------ nearby ------------------------------ */

function NearbyModal({ camera, onClose, onSelect }: { camera: { lng: number; lat: number; zoom: number }; onClose: () => void; onSelect: (id: string) => void }): JSX.Element {
  const [radius, setRadius] = useState(1609);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['nearby', camera.lng.toFixed(3), camera.lat.toFixed(3), radius],
    queryFn: () =>
      get<{ items: Array<SurveillanceAsset & { distanceMeters: number }> }>(
        `/assets/nearby?lng=${camera.lng}&lat=${camera.lat}&radiusMeters=${radius}`,
      ),
  });

  return (
    <Modal title="What's near the map center?" onClose={onClose} large>
      <div className="field">
        <label htmlFor="nearby-radius">Radius: {formatDistance(radius)}</label>
        <input id="nearby-radius" type="range" min={200} max={20000} step={200} value={radius} onChange={(e) => setRadius(Number(e.target.value))} style={{ accentColor: 'var(--color-accent)', minHeight: 'var(--touch-target)' }} />
      </div>
      {isLoading ? (
        <p className="text-sm text-secondary">Measuring…</p>
      ) : error ? (
        <div className="row">
          <p className="text-sm text-danger">{(error as Error).message}</p>
          <button type="button" className="btn btn-sm" onClick={() => void refetch()}>
            Retry
          </button>
        </div>
      ) : (data?.items ?? []).length === 0 ? (
        <p className="text-sm text-secondary">No recorded assets within {formatDistance(radius)} of the map center.</p>
      ) : (
        <div className="col" style={{ gap: 4, maxHeight: 380, overflow: 'auto' }}>
          {(data?.items ?? []).slice(0, 60).map((a) => (
            <button key={a.id} type="button" className="btn btn-ghost" style={{ justifyContent: 'space-between' }} onClick={() => onSelect(a.id)}>
              <span className="row" style={{ gap: 8 }}>
                <span className="legend-dot" style={{ background: TECH_COLORS[a.technologyType] }} />
                <span className="text-sm">{a.name}</span>
              </span>
              <span className="text-xs text-secondary">{formatDistance(a.distanceMeters)}</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------ presets ------------------------------ */

function PresetsModal({
  current,
  onApply,
  onClose,
}: {
  current: { baseStyle: BaseStyle; layers: LayerConfig; filters: MapFilters; camera: { lng: number; lat: number; zoom: number } };
  onApply: (config: Record<string, unknown>) => void;
  onClose: () => void;
}): JSX.Element {
  const toast = useStore((s) => s.toast);
  const workspaceId = useStore((s) => s.currentWorkspaceId);
  const [name, setName] = useState('');
  const [shareToWorkspace, setShareToWorkspace] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data, refetch } = useQuery({
    queryKey: ['presets'],
    queryFn: () => get<{ items: LayerPreset[] }>('/presets'),
  });

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await post('/presets', {
        name: name.trim(),
        workspaceId: shareToWorkspace ? workspaceId : null,
        config: {
          baseStyle: current.baseStyle,
          layers: current.layers.techVisible,
          heatmap: current.layers.heatmap,
          clustering: current.layers.clustering,
          filters: current.filters,
          camera: current.camera,
        },
      });
      setName('');
      toast('View saved.', 'success');
      void refetch();
    } catch (err) {
      toast((err as ApiError).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const copyShare = async (preset: LayerPreset) => {
    const url = `${window.location.origin}/map?preset=${preset.shareToken}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Share link copied — anyone with it sees this exact view.', 'success');
    } catch {
      toast(url, 'info', 12_000);
    }
  };

  return (
    <Modal title="Saved views" onClose={onClose}>
      <div className="col">
        {(data?.items ?? []).length === 0 ? (
          <p className="text-sm text-secondary">Save the current style, layers, filters and camera as a reusable view.</p>
        ) : (
          (data?.items ?? []).map((p) => (
            <div key={p.id} className="card row" style={{ padding: 'var(--space-sm)' }}>
              <button type="button" className="btn btn-sm btn-ghost" style={{ flex: 1, justifyContent: 'flex-start' }} onClick={() => onApply(p.config)}>
                {p.name} {p.workspaceId ? <span className="pill" data-tone="accent">workspace</span> : null}
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => void copyShare(p)} aria-label={`Copy share link for ${p.name}`}>
                🔗
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                aria-label={`Delete ${p.name}`}
                onClick={async () => {
                  await del(`/presets/${p.id}`);
                  void refetch();
                }}
              >
                🗑
              </button>
            </div>
          ))
        )}
        <hr className="divider" />
        <TextInput label="Save current view as" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bay Area LPR audit" />
        {workspaceId ? (
          <label className="checkbox-row">
            <input type="checkbox" checked={shareToWorkspace} onChange={(e) => setShareToWorkspace(e.target.checked)} />
            <span className="text-sm">Share with my workspace</span>
          </label>
        ) : null}
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : 'Save view'}
        </button>
      </div>
    </Modal>
  );
}
