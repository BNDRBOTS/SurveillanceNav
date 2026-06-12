import { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl, { Map as MlMap, Marker, GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import Supercluster from 'supercluster';
import { TECH_COLORS, TECHNOLOGY_LABELS, type TechnologyType } from '@stn/shared';
import statesData from '@/data/us-states.json';
import { buildStyle, type BaseStyle } from './mapStyle';
import type { AssetFeatureCollection } from './useAssets';
import { useStore } from '@/lib/store';
import { haptics } from '@/lib/haptics';
import { announce } from '@/lib/announcer';

export interface LayerConfig {
  clustering: boolean;
  heatmap: boolean;
  techVisible: Record<string, boolean>;
}

export const DEFAULT_LAYERS: LayerConfig = {
  clustering: true,
  heatmap: false,
  techVisible: Object.fromEntries(Object.keys(TECH_COLORS).map((t) => [t, true])),
};

interface MapCanvasProps {
  data: AssetFeatureCollection | null;
  baseStyle: BaseStyle;
  layers: LayerConfig;
  camera: { lng: number; lat: number; zoom: number };
  onViewChange: (view: { lng: number; lat: number; zoom: number; bbox: [number, number, number, number] }) => void;
  onSelect: (assetId: string) => void;
  onMapClick?: (lngLat: { lng: number; lat: number }) => void;
  pickMode?: boolean;
  /** Navigation overlay: route lines, endpoints, exposed cameras. */
  route?: {
    avoidant?: Array<[number, number]> | null;
    fastest?: Array<[number, number]> | null;
    origin?: { lng: number; lat: number } | null;
    destination?: { lng: number; lat: number } | null;
    exposed?: Array<{ id: string; lng: number; lat: number }>;
    position?: { lng: number; lat: number } | null;
  } | null;
}

interface LocateState {
  status: 'idle' | 'locating' | 'active' | 'denied' | 'unavailable';
  accuracy?: number;
}

const CIRCLE_COLOR_EXPR: maplibregl.ExpressionSpecification = [
  'match',
  ['get', 'technologyType'],
  ...Object.entries(TECH_COLORS).flatMap(([tech, color]) => [tech, color]),
  '#8A9099',
] as never;

export function MapCanvas({
  data,
  baseStyle,
  layers,
  camera,
  onViewChange,
  onSelect,
  onMapClick,
  pickMode,
  route,
}: MapCanvasProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const clusterIndexRef = useRef<Supercluster | null>(null);
  const [ready, setReady] = useState(false);
  const [locate, setLocate] = useState<LocateState>({ status: 'idle' });
  const userMarkerRef = useRef<Marker | null>(null);
  const toast = useStore((s) => s.toast);
  const rasterErrorToastedRef = useRef(false);
  const styleRef = useRef<BaseStyle>(baseStyle);
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onMapClickRef = useRef(onMapClick);
  onMapClickRef.current = onMapClick;
  const pickModeRef = useRef(pickMode);
  pickModeRef.current = pickMode;

  /* ----------------------------- init ----------------------------- */
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildStyle(baseStyle, statesData as never),
      center: [camera.lng, camera.lat],
      zoom: camera.zoom,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      maxZoom: 19,
      minZoom: 2,
    });
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');

    map.on('load', () => {
      map.addSource('assets', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'asset-points',
        type: 'circle',
        source: 'assets',
        filter: ['!', ['has', 'cluster']],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4, 13, 7, 17, 10],
          'circle-color': CIRCLE_COLOR_EXPR,
          'circle-stroke-width': 1.4,
          'circle-stroke-color': '#050505',
          'circle-opacity': ['case', ['==', ['get', 'status'], 'retired'], 0.45, 0.92],
        },
      });
      map.addLayer({
        id: 'asset-heat',
        type: 'heatmap',
        source: 'assets',
        layout: { visibility: 'none' },
        paint: {
          'heatmap-weight': ['coalesce', ['get', 'count'], 1],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 4, 0.7, 14, 2.2],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 4, 14, 14, 34],
          'heatmap-color': [
            'interpolate',
            ['linear'],
            ['heatmap-density'],
            0, 'rgba(0,229,168,0)',
            0.25, 'rgba(0,229,168,0.35)',
            0.5, 'rgba(0,184,140,0.55)',
            0.75, 'rgba(255,179,71,0.75)',
            1, 'rgba(255,77,77,0.9)',
          ],
        },
      });

      map.on('click', 'asset-points', (e) => {
        if (pickModeRef.current) return;
        const feature = e.features?.[0];
        const id = (feature?.id as string) ?? (feature?.properties?.id as string);
        if (id) {
          haptics.light();
          onSelectRef.current(String(id));
        }
      });
      map.on('mouseenter', 'asset-points', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'asset-points', () => {
        map.getCanvas().style.cursor = '';
      });
      map.on('click', (e) => {
        if (pickModeRef.current && onMapClickRef.current) {
          haptics.light();
          onMapClickRef.current(e.lngLat);
        }
      });

      setReady(true);
      emitView(map);
    });

    const emitView = (m: MlMap) => {
      const bounds = m.getBounds();
      const center = m.getCenter();
      onViewChangeRef.current({
        lng: center.lng,
        lat: center.lat,
        zoom: m.getZoom(),
        bbox: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      });
    };
    map.on('moveend', () => emitView(map));

    map.on('error', (e) => {
      const sourceId = (e as { sourceId?: string }).sourceId;
      if (sourceId === 'raster' && !rasterErrorToastedRef.current) {
        rasterErrorToastedRef.current = true;
        toast('Base tiles are unavailable — showing the offline vector basemap instead.', 'warning', 6000);
        if (map.getLayer('states-fill')) map.setPaintProperty('states-fill', 'fill-opacity', 1);
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------- style switching ------------------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || styleRef.current === baseStyle) return;
    styleRef.current = baseStyle;
    rasterErrorToastedRef.current = false;
    const center = map.getCenter();
    const zoom = map.getZoom();
    map.setStyle(buildStyle(baseStyle, statesData as never));
    map.once('styledata', () => {
      if (!map.getSource('assets')) {
        map.addSource('assets', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({
          id: 'asset-points',
          type: 'circle',
          source: 'assets',
          filter: ['!', ['has', 'cluster']],
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4, 13, 7, 17, 10],
            'circle-color': CIRCLE_COLOR_EXPR,
            'circle-stroke-width': 1.4,
            'circle-stroke-color': '#050505',
          },
        });
        map.addLayer({
          id: 'asset-heat',
          type: 'heatmap',
          source: 'assets',
          layout: { visibility: layers.heatmap ? 'visible' : 'none' },
          paint: {
            'heatmap-weight': ['coalesce', ['get', 'count'], 1],
            'heatmap-color': [
              'interpolate',
              ['linear'],
              ['heatmap-density'],
              0, 'rgba(0,229,168,0)',
              0.5, 'rgba(0,184,140,0.55)',
              1, 'rgba(255,77,77,0.9)',
            ],
          },
        });
      }
      setDataNonce((n) => n + 1); // re-render data into the fresh style
    });
    map.jumpTo({ center, zoom });
  }, [baseStyle, ready, layers.heatmap]);

  const [dataNonce, setDataNonce] = useState(0);

  /* --------------------------- data render --------------------------- */
  const renderData = useCallback(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getSource('assets')) return;

    for (const m of markersRef.current) m.remove();
    markersRef.current = [];

    if (!data) return;

    const visibleTech = new Set(Object.entries(layers.techVisible).filter(([, v]) => v).map(([k]) => k));
    const techFiltered = data.features.filter((f) =>
      f.properties.cluster ? true : visibleTech.has(String(f.properties.technologyType)),
    );

    const addClusterMarker = (lng: number, lat: number, count: number, expandZoom?: number) => {
      const el = document.createElement('button');
      el.type = 'button';
      const size = Math.min(58, 26 + Math.log2(count + 1) * 5.5);
      el.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;border:2px solid var(--color-accent);background:rgba(0,229,168,0.16);backdrop-filter:blur(2px);color:var(--color-text-primary);font:600 ${count > 999 ? 10 : 12}px/1 var(--font-family);cursor:pointer;display:flex;align-items:center;justify-content:center;`;
      el.textContent = count > 9999 ? `${Math.round(count / 1000)}k` : String(count);
      el.setAttribute('aria-label', `Cluster of ${count} assets — activate to zoom in`);
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        haptics.light();
        map.easeTo({ center: [lng, lat], zoom: expandZoom ?? Math.min(map.getZoom() + 2.5, 17) });
      });
      const marker = new Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
      markersRef.current.push(marker);
    };

    if (data.clustered) {
      // server-side grid clusters at low zoom
      (map.getSource('assets') as GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: layers.heatmap
          ? techFiltered.map((f) => ({ ...f, properties: { ...f.properties, count: f.properties.count ?? 1 } }))
          : [],
      } as never);
      if (!layers.heatmap) {
        for (const f of techFiltered) {
          addClusterMarker(f.geometry.coordinates[0], f.geometry.coordinates[1], Number(f.properties.count ?? 1));
        }
      }
      announce(`Map showing ${techFiltered.reduce((acc, f) => acc + Number(f.properties.count ?? 1), 0)} assets in clusters`);
      return;
    }

    if (layers.clustering && !layers.heatmap && techFiltered.length > 40) {
      const index = new Supercluster({ radius: 52, maxZoom: 16 });
      index.load(
        techFiltered.map((f) => ({
          type: 'Feature' as const,
          geometry: f.geometry,
          properties: { ...f.properties, _fid: f.id ?? f.properties.id },
        })),
      );
      clusterIndexRef.current = index;
      const bounds = map.getBounds();
      const clusters = index.getClusters(
        [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
        Math.floor(map.getZoom()),
      );
      const points = clusters.filter((c) => !c.properties.cluster);
      (map.getSource('assets') as GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: points.map((p) => ({ ...p, id: p.properties._fid as string })),
      } as never);
      for (const c of clusters) {
        if (!c.properties.cluster) continue;
        const [lng, lat] = (c.geometry as unknown as { coordinates: [number, number] }).coordinates;
        const expandZoom = Math.min(index.getClusterExpansionZoom(Number(c.id)), 17);
        addClusterMarker(lng, lat, Number(c.properties.point_count), expandZoom);
      }
    } else {
      (map.getSource('assets') as GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: techFiltered.map((f) => ({ ...f, id: f.id ?? f.properties.id })),
      } as never);
    }
    map.setLayoutProperty('asset-heat', 'visibility', layers.heatmap ? 'visible' : 'none');
    map.setLayoutProperty('asset-points', 'visibility', layers.heatmap ? 'none' : 'visible');
    announce(`Map showing ${techFiltered.length} assets`);
  }, [data, layers, ready]);

  useEffect(() => {
    renderData();
  }, [renderData, dataNonce]);

  // re-cluster on zoom changes between data fetches
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const handler = () => {
      if (data && !data.clustered && layers.clustering) renderData();
    };
    map.on('zoomend', handler);
    return () => {
      map.off('zoomend', handler);
    };
  }, [data, layers.clustering, renderData]);

  /* --------------------------- route overlay --------------------------- */
  const routeMarkersRef = useRef<Marker[]>([]);
  const lastFitRef = useRef<string>('');
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const ensureLayers = () => {
      if (map.getSource('route')) return;
      map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('route-exposed', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      const before = map.getLayer('asset-points') ? 'asset-points' : undefined;
      map.addLayer({
        id: 'route-fast', type: 'line', source: 'route',
        filter: ['==', ['get', 'kind'], 'fastest'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#9BA0A6', 'line-width': 4, 'line-dasharray': [1.5, 2], 'line-opacity': 0.75 },
      }, before);
      map.addLayer({
        id: 'route-avoid-casing', type: 'line', source: 'route',
        filter: ['==', ['get', 'kind'], 'avoid'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#050505', 'line-width': 9, 'line-opacity': 0.85 },
      }, before);
      map.addLayer({
        id: 'route-avoid', type: 'line', source: 'route',
        filter: ['==', ['get', 'kind'], 'avoid'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#00E5A8', 'line-width': 4.5 },
      }, before);
      map.addLayer({
        id: 'route-exposed-halo', type: 'circle', source: 'route-exposed',
        paint: {
          'circle-radius': 11, 'circle-color': 'rgba(255,77,77,0.22)',
          'circle-stroke-color': '#FF4D4D', 'circle-stroke-width': 1.6,
        },
      });
    };
    ensureLayers();

    const features: GeoJSON.Feature[] = [];
    if (route?.fastest) {
      features.push({ type: 'Feature', properties: { kind: 'fastest' }, geometry: { type: 'LineString', coordinates: route.fastest } });
    }
    if (route?.avoidant) {
      features.push({ type: 'Feature', properties: { kind: 'avoid' }, geometry: { type: 'LineString', coordinates: route.avoidant } });
    }
    (map.getSource('route') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features } as never);
    (map.getSource('route-exposed') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: (route?.exposed ?? []).map((c) => ({
        type: 'Feature', properties: { id: c.id }, geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
      })),
    } as never);

    for (const m of routeMarkersRef.current) m.remove();
    routeMarkersRef.current = [];
    const pin = (lng: number, lat: number, label: string, bg: string, ink: string) => {
      const el = document.createElement('div');
      el.style.cssText = `width:26px;height:26px;border-radius:50% 50% 50% 4px;transform:rotate(0deg);background:${bg};color:${ink};display:flex;align-items:center;justify-content:center;font:700 12px var(--font-family);border:2px solid #050505;box-shadow:var(--shadow-2);`;
      el.textContent = label;
      el.setAttribute('aria-label', label === 'A' ? 'Route start' : 'Route destination');
      routeMarkersRef.current.push(new Marker({ element: el }).setLngLat([lng, lat]).addTo(map));
    };
    if (route?.origin) pin(route.origin.lng, route.origin.lat, 'A', '#F4F4F2', '#050505');
    if (route?.destination) pin(route.destination.lng, route.destination.lat, 'B', '#00E5A8', '#03251B');
    if (route?.position) {
      const el = document.createElement('div');
      el.style.cssText = 'width:18px;height:18px;border-radius:50%;background:#00E5A8;border:3px solid #050505;box-shadow:0 0 0 6px rgba(0,229,168,0.3), var(--glow-accent);';
      el.setAttribute('aria-label', 'Your position');
      routeMarkersRef.current.push(new Marker({ element: el }).setLngLat([route.position.lng, route.position.lat]).addTo(map));
    }

    // fit once per new route geometry
    const line = route?.avoidant ?? route?.fastest;
    if (line && line.length > 1) {
      const key = `${line.length}:${line[0]![0]}:${line[line.length - 1]![1]}`;
      if (key !== lastFitRef.current) {
        lastFitRef.current = key;
        let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
        for (const [lng, lat] of line) {
          if (lng < minLng) minLng = lng;
          if (lat < minLat) minLat = lat;
          if (lng > maxLng) maxLng = lng;
          if (lat > maxLat) maxLat = lat;
        }
        map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 72, maxZoom: 16, duration: 600 });
      }
    } else {
      lastFitRef.current = '';
    }
  }, [route, ready, dataNonce]);

  /* ----------------------------- locate ----------------------------- */
  const handleLocate = () => {
    const map = mapRef.current;
    if (!map) return;
    if (!('geolocation' in navigator)) {
      setLocate({ status: 'unavailable' });
      toast('Geolocation is not available on this device — use the search box instead.', 'warning');
      return;
    }
    setLocate({ status: 'locating' });
    haptics.light();
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { longitude, latitude, accuracy } = pos.coords;
        setLocate({ status: 'active', accuracy: Math.round(accuracy) });
        userMarkerRef.current?.remove();
        const el = document.createElement('div');
        el.style.cssText =
          'width:16px;height:16px;border-radius:50%;background:var(--color-accent);border:3px solid #fff;box-shadow:0 0 0 6px rgba(0,229,168,0.25);';
        el.setAttribute('aria-label', 'Your location');
        userMarkerRef.current = new Marker({ element: el }).setLngLat([longitude, latitude]).addTo(map);
        map.easeTo({ center: [longitude, latitude], zoom: Math.max(map.getZoom(), 14) });
        haptics.success();
        announce(`Located you within ${Math.round(accuracy)} meters`);
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setLocate({ status: 'denied' });
          toast('Location permission denied. You can search for an address or paste coordinates instead.', 'warning', 7000);
        } else {
          setLocate({ status: 'unavailable' });
          toast('Couldn’t get a location fix — try again near a window, or search manually.', 'warning', 7000);
        }
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
    );
  };

  /* ----------------------------- camera sync ----------------------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const center = map.getCenter();
    const dist = Math.abs(center.lng - camera.lng) + Math.abs(center.lat - camera.lat);
    if (dist > 0.0001 || Math.abs(map.getZoom() - camera.zoom) > 0.01) {
      map.jumpTo({ center: [camera.lng, camera.lat], zoom: camera.zoom });
    }
     
  }, [camera.lng, camera.lat, camera.zoom, ready]);

  return (
    <>
      <div ref={containerRef} className="map-canvas" role="application" aria-label="Surveillance asset map" />
      <div className="map-controls">
        <button
          type="button"
          className="btn btn-icon"
          onClick={handleLocate}
          aria-label="Find my location"
          title={
            locate.status === 'active'
              ? `Located (±${locate.accuracy}m)`
              : locate.status === 'denied'
                ? 'Permission denied — search instead'
                : 'Find me'
          }
        >
          {locate.status === 'locating' ? '⏳' : locate.status === 'active' ? '📍' : '🧭'}
        </button>
      </div>
      <div className="map-legend" aria-label="Legend">
        {Object.entries(TECH_COLORS)
          .filter(([tech]) => layers.techVisible[tech])
          .map(([tech, color]) => (
            <span key={tech} className="legend-item">
              <span className="legend-dot" style={{ background: color }} />
              {TECHNOLOGY_LABELS[tech as TechnologyType]}
            </span>
          ))}
        {locate.status === 'active' && locate.accuracy !== undefined ? (
          <span className="legend-item">
            <span className="legend-dot" style={{ background: 'var(--color-accent)' }} />
            You (±{locate.accuracy}m)
          </span>
        ) : null}
      </div>
    </>
  );
}
