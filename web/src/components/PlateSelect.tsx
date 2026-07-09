import type { ChangeEventHandler, ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * A native <select> wearing the parallelogram plate. Replaced elements can't
 * carry the ::before/::after sheet construction, so the plate lives on a
 * wrapping <label> (which also gives the select its accessible relationship)
 * while the real select stretches invisibly across it — native popup,
 * keyboard, and screen-reader behavior all intact.
 */
export function PlateSelect({
  label,
  value,
  displayValue,
  onChange,
  children,
  className = 'btn btn-sm',
}: {
  label: string;
  value: string;
  /** Text shown on the plate (defaults to the raw value). */
  displayValue?: string;
  onChange: ChangeEventHandler<HTMLSelectElement>;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <label className={`${className} plate-select`}>
      <span className="plate-select-value">{displayValue ?? value}</span>
      <Icon name="chevron-down" size={14} />
      <select aria-label={label} value={value} onChange={onChange}>
        {children}
      </select>
    </label>
  );
}
