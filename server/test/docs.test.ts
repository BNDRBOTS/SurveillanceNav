import { describe, it, expect } from 'vitest';
import { renderDocsHtml } from '../src/openapi.js';

describe('rendered API docs', () => {
  const html = renderDocsHtml();

  it('renders a complete HTML document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('API reference');
    expect(html).toContain('</html>');
  });

  it('lists endpoints grouped by tag with methods', () => {
    expect(html).toContain('/auth/login');
    expect(html).toContain('/assets');
    expect(html).toContain('>GET<');
    expect(html).toContain('>POST<');
  });

  it('marks auth vs public and ships zero scripts (CSP-safe)', () => {
    expect(html).toContain('>auth<');
    expect(html).toContain('>public<');
    expect(html).not.toContain('<script');
  });
});
