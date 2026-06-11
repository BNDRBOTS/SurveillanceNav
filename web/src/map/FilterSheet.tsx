import { useState } from 'react';
import {
  TECHNOLOGY_TYPES,
  TECHNOLOGY_LABELS,
  ASSET_STATUSES,
  SOURCE_TYPES,
  type TechnologyType,
} from '@stn/shared';
import type { MapFilters } from './useAssets';
import { TextInput } from '@/components/Form';
import { haptics } from '@/lib/haptics';

interface FilterSheetProps {
  filters: MapFilters;
  onChange: (filters: MapFilters) => void;
  onClose: () => void;
  resultCount: number | null;
  loading: boolean;
}

/**
 * Filter panel — desktop side panel / mobile slide-up sheet with sticky
 * header, live result preview, apply-on-change semantics and full reset.
 */
export function FilterSheet({ filters, onChange, onClose, resultCount, loading }: FilterSheetProps): JSX.Element {
  const [advanced, setAdvanced] = useState(false);

  const toggleIn = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const set = <K extends keyof MapFilters>(key: K, value: MapFilters[K]) => {
    haptics.light();
    onChange({ ...filters, [key]: value });
  };

  const activeCount =
    filters.technologyType.length +
    filters.status.length +
    filters.sourceType.length +
    (filters.minConfidence > 0 ? 1 : 0) +
    (filters.vendor ? 1 : 0) +
    (filters.deployedAfter ? 1 : 0) +
    (filters.deployedBefore ? 1 : 0) +
    (filters.verification ? 1 : 0);

  return (
    <div className="filtersheet" role="region" aria-label="Map filters">
      <div className="filtersheet-header">
        <strong>
          Filters{activeCount > 0 ? ` (${activeCount})` : ''}
        </strong>
        <span className="text-xs text-secondary" aria-live="polite">
          {loading ? 'searching…' : resultCount !== null ? `${resultCount.toLocaleString()} results` : ''}
        </span>
        <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close filters">
          ✕
        </button>
      </div>

      <div className="filtersheet-body col">
        <fieldset style={{ border: 'none', padding: 0 }}>
          <legend className="text-sm text-secondary" style={{ marginBottom: 'var(--space-xs)' }}>
            Technology
          </legend>
          <div className="row-wrap" style={{ gap: 6 }}>
            {TECHNOLOGY_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                className="chip"
                aria-pressed={filters.technologyType.includes(t)}
                onClick={() => set('technologyType', toggleIn(filters.technologyType, t))}
              >
                {TECHNOLOGY_LABELS[t as TechnologyType]}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset style={{ border: 'none', padding: 0 }}>
          <legend className="text-sm text-secondary" style={{ marginBottom: 'var(--space-xs)' }}>
            Deployment status
          </legend>
          <div className="row-wrap" style={{ gap: 6 }}>
            {ASSET_STATUSES.map((s) => (
              <button key={s} type="button" className="chip" aria-pressed={filters.status.includes(s)} onClick={() => set('status', toggleIn(filters.status, s))}>
                {s}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="field">
          <label htmlFor="conf-range">Minimum confidence: {filters.minConfidence}</label>
          <input
            id="conf-range"
            type="range"
            min={0}
            max={100}
            step={5}
            value={filters.minConfidence}
            onChange={(e) => set('minConfidence', Number(e.target.value))}
            style={{ accentColor: 'var(--color-accent)', minHeight: 'var(--touch-target)' }}
          />
        </div>

        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
          {advanced ? '− Fewer filters' : '+ More filters (source, vendor, dates)'}
        </button>

        {advanced ? (
          <>
            <fieldset style={{ border: 'none', padding: 0 }}>
              <legend className="text-sm text-secondary" style={{ marginBottom: 'var(--space-xs)' }}>
                Source type
              </legend>
              <div className="row-wrap" style={{ gap: 6 }}>
                {SOURCE_TYPES.map((s) => (
                  <button key={s} type="button" className="chip" aria-pressed={filters.sourceType.includes(s)} onClick={() => set('sourceType', toggleIn(filters.sourceType, s))}>
                    {s}
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="field">
              <label htmlFor="filter-verification">Source verification</label>
              <select id="filter-verification" className="input" value={filters.verification} onChange={(e) => set('verification', e.target.value)}>
                <option value="">Any</option>
                <option value="verified">Verified only</option>
                <option value="pending">Pending review</option>
                <option value="unverified">Unverified</option>
              </select>
            </div>
            <TextInput label="Vendor contains" value={filters.vendor} onChange={(e) => set('vendor', e.target.value)} placeholder="e.g. Flock" />
            <div className="row">
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="deployed-after">Deployed after</label>
                <input id="deployed-after" type="date" className="input" value={filters.deployedAfter} onChange={(e) => set('deployedAfter', e.target.value)} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="deployed-before">before</label>
                <input id="deployed-before" type="date" className="input" value={filters.deployedBefore} onChange={(e) => set('deployedBefore', e.target.value)} />
              </div>
            </div>
          </>
        ) : null}
      </div>

      <div className="filtersheet-footer">
        <button
          type="button"
          className="btn btn-ghost"
          style={{ flex: 1 }}
          onClick={() =>
            onChange({
              technologyType: [],
              status: [],
              sourceType: [],
              minConfidence: 0,
              vendor: '',
              deployedAfter: '',
              deployedBefore: '',
              verification: '',
              q: filters.q,
            })
          }
        >
          Reset
        </button>
        <button type="button" className="btn btn-primary" style={{ flex: 1 }} onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
