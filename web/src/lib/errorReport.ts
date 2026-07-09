import { post } from './api';

export interface ErrorReportInput {
  kind: 'map_style' | 'map_tiles' | 'statute' | 'content' | 'client_error';
  message: string;
  detail?: {
    route?: string;
    styleId?: string;
    errorChain?: string[];
    mapState?: { lng: number; lat: number; zoom: number };
    context?: string;
  };
}

/**
 * One-tap forensic error report. Collects only technical diagnostics — user
 * agent, viewport, route, app state the caller passes in — never identity or
 * precise location (map coordinates are rounded to ~1 km). Returns a truthful
 * confirmation string based on what the server actually did with it.
 */
export async function submitErrorReport(input: ErrorReportInput): Promise<string> {
  const detail = {
    route: window.location.pathname,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    online: navigator.onLine,
    ...input.detail,
    ...(input.detail?.mapState
      ? {
          mapState: {
            lng: Math.round(input.detail.mapState.lng * 100) / 100,
            lat: Math.round(input.detail.mapState.lat * 100) / 100,
            zoom: Math.round(input.detail.mapState.zoom * 10) / 10,
          },
        }
      : {}),
    errorChain: (input.detail?.errorChain ?? []).slice(-10).map((e) => e.slice(0, 300)),
  };
  const res = await post<{ ok: boolean; stored: boolean; emailed: boolean }>('/feedback/error-report', {
    kind: input.kind,
    message: input.message,
    detail,
  });
  return res.emailed
    ? 'Report sent to the maintainers.'
    : 'Report recorded — the operators will see it in the review console.';
}
