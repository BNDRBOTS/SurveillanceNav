import { useCallback, useEffect, useRef, useState } from 'react';
import { get } from '@/lib/api';
import { cacheDataset, restoreDataset } from '@/lib/offline';
import { useStore } from '@/lib/store';

export interface AssetFeatureCollection {
  type: 'FeatureCollection';
  clustered: boolean;
  total?: number;
  truncated?: boolean;
  features: Array<{
    type: 'Feature';
    id?: string;
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: Record<string, unknown>;
  }>;
}

export interface MapFilters {
  technologyType: string[];
  status: string[];
  sourceType: string[];
  minConfidence: number;
  vendor: string;
  deployedAfter: string;
  deployedBefore: string;
  verification: string;
  q: string;
}

export const DEFAULT_FILTERS: MapFilters = {
  technologyType: [],
  status: [],
  sourceType: [],
  minConfidence: 0,
  vendor: '',
  deployedAfter: '',
  deployedBefore: '',
  verification: '',
  q: '',
};

export function filtersToQuery(f: MapFilters): string {
  const params = new URLSearchParams();
  for (const t of f.technologyType) params.append('technologyType', t);
  for (const s of f.status) params.append('status', s);
  for (const s of f.sourceType) params.append('sourceType', s);
  if (f.minConfidence > 0) params.set('minConfidence', String(f.minConfidence));
  if (f.vendor) params.set('vendor', f.vendor);
  if (f.deployedAfter) params.set('deployedAfter', f.deployedAfter);
  if (f.deployedBefore) params.set('deployedBefore', f.deployedBefore);
  if (f.verification) params.set('verification', f.verification);
  if (f.q) params.set('q', f.q);
  return params.toString();
}

interface UseAssetsResult {
  data: AssetFeatureCollection | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
  truncated: boolean;
  refetch: () => void;
}

/**
 * Viewport-driven asset loading with: 250ms debounce, in-flight aborts,
 * offline cache fallback (checksum-verified), and stale indicators.
 */
export function useMapAssets(
  bbox: [number, number, number, number] | null,
  zoom: number,
  filters: MapFilters,
): UseAssetsResult {
  const [data, setData] = useState<AssetFeatureCollection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [nonce, setNonce] = useState(0);
  const toast = useStore((s) => s.toast);
  const filterQuery = filtersToQuery(filters);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!bbox) return;
    const [minLng, minLat, maxLng, maxLat] = bbox;
    // round bbox so tiny pans reuse the cache key
    const key = `assets:${minLng.toFixed(2)},${minLat.toFixed(2)},${maxLng.toFixed(2)},${maxLat.toFixed(2)}:z${Math.round(zoom)}:${filterQuery}`;
    const url = `/assets?format=geojson&bbox=${minLng},${minLat},${maxLng},${maxLat}&zoom=${Math.round(zoom)}${filterQuery ? `&${filterQuery}` : ''}`;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    const timer = setTimeout(async () => {
      try {
        const result = await get<AssetFeatureCollection>(url, controller.signal);
        if (controller.signal.aborted) return;
        setData(result);
        setError(null);
        setStale(false);
        setLoading(false);
        void cacheDataset(key, result);
        void cacheDataset('assets:last-view', { bbox, zoom, filterQuery, result });
      } catch (err) {
        if (controller.signal.aborted) return;
        // graceful fallback: integrity-checked offline cache
        const cached =
          (await restoreDataset<AssetFeatureCollection>(key)) ??
          (await restoreDataset<{ result: AssetFeatureCollection }>('assets:last-view').then((entry) =>
            entry ? { data: entry.data.result, savedAt: entry.savedAt } : null,
          ));
        if (cached) {
          setData(cached.data);
          setStale(true);
          setError(null);
          toast('Showing cached map data — live service unreachable.', 'warning', 6000);
        } else {
          setError((err as Error).message);
        }
        setLoading(false);
      }
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bbox?.join(','), Math.round(zoom), filterQuery, nonce]);

  return { data, loading, error, stale, truncated: data?.truncated ?? false, refetch };
}
