import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EXPORT_FORMATS, type ExportJob } from '@stn/shared';
import { get, post, ApiError } from '@/lib/api';
import { useStore } from '@/lib/store';
import { fmtDateTime, fmtNumber } from '@/lib/format';
import { StatusPill } from '@/components/Badges';
import { EmptyState, ErrorState, Skeleton } from '@/components/Feedback';
import { Select } from '@/components/Form';
import { haptics } from '@/lib/haptics';

const RESOURCES = [
  { id: 'assets', label: 'Surveillance assets (public data)' },
  { id: 'report', label: 'Full report with map snapshot' },
  { id: 'foia', label: 'FOIA tracker (workspace)' },
  { id: 'procurements', label: 'Procurement records' },
  { id: 'policies', label: 'Policy timeline' },
] as const;

const FORMAT_HINTS: Record<string, string> = {
  csv: 'Spreadsheet-ready, formula-injection safe',
  json: 'Full fidelity for scripts and pipelines',
  geojson: 'Drop into QGIS, Felt, Mapbox, or Observable',
  kml: 'Google Earth & legacy GIS',
  pdf: 'Print-ready report with vector map snapshot & methodology',
  html: 'Self-contained shareable report',
};

export default function ReportsPage(): JSX.Element {
  const toast = useStore((s) => s.toast);
  const user = useStore((s) => s.user);
  const workspaceId = useStore((s) => s.currentWorkspaceId);
  const queryClient = useQueryClient();
  const [resource, setResource] = useState<string>('assets');
  const [format, setFormat] = useState<string>('csv');
  const [busy, setBusy] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['exports'],
    queryFn: () => get<{ items: ExportJob[] }>('/exports'),
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some((e) => e.status === 'queued' || e.status === 'processing') ? 2500 : false,
    enabled: !!user,
  });

  const create = async () => {
    setBusy(true);
    try {
      const res = await post<{ id: string; message: string }>('/exports', {
        format,
        resource,
        workspaceId: resource === 'foia' ? workspaceId : null,
        params: {},
      });
      toast(res.message, 'success', 6000);
      haptics.light();
      void queryClient.invalidateQueries({ queryKey: ['exports'] });
    } catch (err) {
      toast((err as ApiError).message, 'error', 8000);
    } finally {
      setBusy(false);
    }
  };

  if (!user) {
    return (
      <div className="page">
        <EmptyState title="Sign in to generate exports" hint="Exports include CSV, GeoJSON, KML, JSON, and PDF/HTML reports with methodology and provenance notes." />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Reports & exports</h1>
          <p className="text-sm text-secondary">
            Generated server-side with provenance notes; downloads use short-lived signed links and expire after 72h.
          </p>
        </div>
      </div>

      <div className="card col" style={{ marginBottom: 'var(--space-lg)' }}>
        <div className="row-wrap" style={{ alignItems: 'flex-end' }}>
          <div style={{ minWidth: 260, flex: 1 }}>
            <Select label="What to export" value={resource} onChange={(e) => setResource(e.target.value)}>
              {RESOURCES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </Select>
          </div>
          <div style={{ minWidth: 200, flex: 1 }}>
            <Select label="Format" value={format} onChange={(e) => setFormat(e.target.value)} hint={FORMAT_HINTS[format]}>
              {EXPORT_FORMATS.filter((f) => (resource === 'foia' ? f === 'csv' || f === 'json' : true)).map((f) => (
                <option key={f} value={f}>
                  {f.toUpperCase()}
                </option>
              ))}
            </Select>
          </div>
          <button type="button" className="btn btn-primary" onClick={create} disabled={busy} style={{ marginBottom: 'var(--space-md)' }}>
            {busy ? 'Starting…' : 'Generate export'}
          </button>
        </div>
      </div>

      {isLoading ? (
        <Skeleton count={4} height={48} />
      ) : error ? (
        <ErrorState message={(error as Error).message} onRetry={() => void refetch()} />
      ) : (data?.items ?? []).length === 0 ? (
        <EmptyState title="No exports yet" hint="Your generated files appear here with their status and a signed download link." />
      ) : (
        <div className="col">
          {(data?.items ?? []).map((e) => (
            <div key={e.id} className="card row-wrap" style={{ padding: 'var(--space-sm) var(--space-md)' }}>
              <div className="col" style={{ gap: 2, flex: 1, minWidth: 200 }}>
                <strong className="text-sm">
                  {e.resource} · {e.format.toUpperCase()}
                </strong>
                <span className="text-xs text-secondary">
                  {fmtDateTime(e.createdAt)}
                  {e.rowCount !== null ? ` · ${fmtNumber(e.rowCount)} rows` : ''}
                  {e.truncated ? ' · truncated at cap' : ''}
                </span>
                {e.error ? <span className="text-xs text-danger">{e.error}</span> : null}
              </div>
              {e.truncated ? (
                <span className="pill" data-tone="warning" title="Row cap reached — narrow filters or use CSV/JSON">
                  partial
                </span>
              ) : null}
              <StatusPill status={e.status} />
              {e.status === 'completed' && e.downloadUrl ? (
                <a className="btn btn-sm btn-primary" href={e.downloadUrl} download onClick={() => haptics.success()}>
                  ⬇ Download
                </a>
              ) : e.status === 'queued' || e.status === 'processing' ? (
                <span className="text-xs text-secondary" aria-live="polite">
                  working…
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
