import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Icon } from '@/components/Icon';

/* The icon craft system: every glyph is layered — dim fill, receding detail
   linework (~0.63× weight), full-weight structure, light-tone facet glints,
   and a champagne spark. These tests pin the layer contract so a future
   refactor can't silently flatten the set back to single-weight strokes. */

describe('Icon layer structure', () => {
  it('toned glyphs stroke with a per-instance gradient and carry a glow halo', () => {
    const { container } = render(<Icon name="shield" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('stroke')).toMatch(/^url\(#/);
    expect(container.querySelector('linearGradient')).toBeTruthy();
    expect(svg.style.filter).toContain('drop-shadow');
  });

  it('renders detail linework at a lighter weight than structure', () => {
    const { container } = render(<Icon name="shield" strokeWidth={1.75} />);
    const detail = container.querySelector('[data-layer="detail"]')!;
    expect(detail).toBeTruthy();
    const detailWidth = Number(detail.getAttribute('stroke-width'));
    expect(detailWidth).toBeGreaterThan(1);
    expect(detailWidth).toBeLessThan(1.75 * 0.7); // recedes, not merely thinner
  });

  it('facet catch-lights use the light tone with rounded caps', () => {
    const { container } = render(<Icon name="layers" />);
    const facet = container.querySelector('[data-layer="facet"]')!;
    expect(facet).toBeTruthy();
    expect(facet.getAttribute('stroke')).toBe('#8CE4F2'); // cyan light
    expect(facet.getAttribute('stroke-linecap')).toBe('round');
    expect(Number(facet.getAttribute('stroke-width'))).toBeLessThan(1);
  });

  it('sparks stay champagne-gold via the accent custom property', () => {
    const { container } = render(<Icon name="map" />);
    const spark = container.querySelector('[data-layer="spark"]')!;
    expect(spark).toBeTruthy();
    expect(spark.getAttribute('stroke')).toContain('--color-accent');
  });

  it('mono glyphs inherit currentColor and never render tone-only layers', () => {
    const { container } = render(<Icon name="plus" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(container.querySelector('linearGradient')).toBeNull();
    expect(container.querySelector('[data-layer="dim"]')).toBeNull();
    expect(container.querySelector('[data-layer="facet"]')).toBeNull();
    expect(container.querySelector('[data-layer="spark"]')).toBeNull();
    expect(svg.style.filter).toBe('');
  });

  it('forcing tone="mono" on a toned glyph strips gradient, facets, and sparks', () => {
    const { container } = render(<Icon name="shield" tone="mono" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(container.querySelector('[data-layer="facet"]')).toBeNull();
    expect(container.querySelector('[data-layer="spark"]')).toBeNull();
  });

  it('gradient ids stay unique across sibling icons (no cross-bleed)', () => {
    const { container } = render(
      <>
        <Icon name="map" />
        <Icon name="mail" />
      </>,
    );
    const ids = Array.from(container.querySelectorAll('linearGradient')).map((g) => g.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('mono detail layers still recede (dual-weight works without tone)', () => {
    const { container } = render(<Icon name="external-link" />);
    const detail = container.querySelector('[data-layer="detail"]')!;
    expect(detail).toBeTruthy(); // the frame recedes behind the outbound arrow
    expect(Number(detail.getAttribute('stroke-width'))).toBeLessThan(1.75);
  });
});
