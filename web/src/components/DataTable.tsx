import { useMemo, useRef, useState, type ReactNode } from 'react';

export interface Column<T> {
  key: string;
  label: string;
  sortable?: boolean;
  width?: string;
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number | null;
}

interface DataTableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Window rows above this count (handles 100k+ rows smoothly). */
  virtualizeOver?: number;
  rowHeight?: number;
  emptyState?: ReactNode;
  ariaLabel: string;
}

/**
 * Sortable, hand-virtualized table. Windowing renders only visible rows plus
 * overscan; with fixed row height it stays smooth past 100k rows.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  virtualizeOver = 120,
  rowHeight = 49,
  emptyState,
  ariaLabel,
}: DataTableProps<T>): JSX.Element {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [scrollTop, setScrollTop] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return rows;
    const value = col.sortValue ?? ((row: T) => String((row as Record<string, unknown>)[col.key] ?? ''));
    return [...rows].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [rows, sortKey, sortDir, columns]);

  const virtual = sorted.length > virtualizeOver;
  const viewportH = 560;
  const overscan = 8;
  const start = virtual ? Math.max(0, Math.floor(scrollTop / rowHeight) - overscan) : 0;
  const visibleCount = virtual ? Math.ceil(viewportH / rowHeight) + overscan * 2 : sorted.length;
  const visible = sorted.slice(start, start + visibleCount);

  const toggleSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  if (rows.length === 0 && emptyState) return <>{emptyState}</>;

  return (
    <div
      className="table-wrap"
      ref={wrapRef}
      style={virtual ? { maxHeight: viewportH, overflowY: 'auto' } : undefined}
      onScroll={virtual ? (e) => setScrollTop((e.target as HTMLDivElement).scrollTop) : undefined}
    >
      <table className="table" aria-label={ariaLabel} aria-rowcount={sorted.length}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                style={c.width ? { width: c.width } : undefined}
                data-sortable={c.sortable || undefined}
                aria-sort={sortKey === c.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                onClick={c.sortable ? () => toggleSort(c.key) : undefined}
                onKeyDown={
                  c.sortable
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleSort(c.key);
                        }
                      }
                    : undefined
                }
                tabIndex={c.sortable ? 0 : undefined}
                role={c.sortable ? 'button' : undefined}
              >
                {c.label}
                {sortKey === c.key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {virtual && start > 0 ? (
            <tr aria-hidden="true" style={{ height: start * rowHeight }}>
              <td colSpan={columns.length} style={{ padding: 0, border: 0 }} />
            </tr>
          ) : null}
          {visible.map((row) => (
            <tr
              key={rowKey(row)}
              data-clickable={onRowClick ? true : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter') onRowClick(row);
                    }
                  : undefined
              }
              tabIndex={onRowClick ? 0 : undefined}
              style={virtual ? { height: rowHeight } : undefined}
            >
              {columns.map((c) => (
                <td key={c.key}>{c.render(row)}</td>
              ))}
            </tr>
          ))}
          {virtual && start + visibleCount < sorted.length ? (
            <tr aria-hidden="true" style={{ height: (sorted.length - start - visibleCount) * rowHeight }}>
              <td colSpan={columns.length} style={{ padding: 0, border: 0 }} />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
