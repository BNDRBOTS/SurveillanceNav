import type { StyleSpecification } from 'maplibre-gl';

export type BaseStyle = 'streets' | 'satellite' | 'hybrid' | 'dark' | 'contrast';

export const BASE_STYLES: Array<{ id: BaseStyle; label: string; online: boolean }> = [
  { id: 'dark', label: 'Dark', online: false },
  { id: 'streets', label: 'Streets', online: true },
  { id: 'satellite', label: 'Satellite', online: true },
  { id: 'hybrid', label: 'Hybrid', online: true },
  { id: 'contrast', label: 'High contrast', online: false },
];

const OSM_RASTER = {
  type: 'raster' as const,
  tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
  tileSize: 256,
  maxzoom: 19,
  attribution: '© OpenStreetMap contributors',
};

const ESRI_IMAGERY = {
  type: 'raster' as const,
  tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
  tileSize: 256,
  maxzoom: 19,
  attribution: 'Imagery © Esri',
};

interface Palette {
  bg: string;
  land: string;
  border: string;
  label: string;
  halo: string;
}

const PALETTES: Record<'dark' | 'contrast', Palette> = {
  dark: { bg: '#050505', land: '#0E0F10', border: '#26282B', label: '#9BA0A6', halo: '#050505' },
  contrast: { bg: '#000000', land: '#0a0a0a', border: '#999999', label: '#FFFFFF', halo: '#000000' },
};

/**
 * Builds the MapLibre style. The vector basemap renders entirely from the
 * bundled US states GeoJSON — fully offline-capable with zero external tile
 * dependencies. Online styles add OSM/Esri raster underneath; if tiles fail
 * to load (offline, provider outage) the vector layer is still there, so the
 * map never goes blank.
 */
export function buildStyle(base: BaseStyle, statesGeoJson: GeoJSON.FeatureCollection): StyleSpecification {
  const palette = PALETTES[base === 'contrast' ? 'contrast' : 'dark'];
  const wantsRaster = base === 'streets' || base === 'satellite' || base === 'hybrid';
  const rasterSource = base === 'satellite' || base === 'hybrid' ? ESRI_IMAGERY : OSM_RASTER;

  const style: StyleSpecification = {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      states: { type: 'geojson', data: statesGeoJson as never },
      ...(wantsRaster ? { raster: rasterSource } : {}),
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': palette.bg } },
      {
        id: 'states-fill',
        type: 'fill',
        source: 'states',
        paint: { 'fill-color': palette.land, 'fill-opacity': wantsRaster ? 0 : 1 },
      },
      ...(wantsRaster
        ? [
            {
              id: 'raster-base',
              type: 'raster' as const,
              source: 'raster',
              paint: { 'raster-opacity': 1, 'raster-fade-duration': 150 },
            },
          ]
        : []),
      {
        id: 'states-line',
        type: 'line',
        source: 'states',
        paint: {
          'line-color': base === 'hybrid' ? '#ffffff' : palette.border,
          'line-width': base === 'hybrid' ? 1.2 : 1,
          'line-opacity': base === 'satellite' ? 0 : 0.9,
        },
      },
    ],
  };
  return style;
}
