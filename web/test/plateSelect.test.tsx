import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlateSelect } from '@/components/PlateSelect';

describe('PlateSelect', () => {
  it('exposes an accessible native select and fires onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PlateSelect label="Base map style" value="dark" displayValue="Dark" onChange={onChange}>
        <option value="dark">Dark</option>
        <option value="streets">Streets (online)</option>
      </PlateSelect>,
    );
    const select = screen.getByRole('combobox', { name: 'Base map style' });
    expect(select).toBeInTheDocument();

    await user.selectOptions(select, 'streets');
    expect(onChange).toHaveBeenCalled();
  });

  it('shows the display value on the plate, not the raw id', () => {
    const { container } = render(
      <PlateSelect label="x" value="hybrid" displayValue="Hybrid (imagery)" onChange={() => undefined}>
        <option value="hybrid">Hybrid</option>
      </PlateSelect>,
    );
    expect(container.querySelector('.plate-select-value')?.textContent).toBe('Hybrid (imagery)');
  });
});
