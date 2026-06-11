import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axe from 'axe-core';
import { LoginPage, SignupPage } from '@/pages/AuthPages';
import { PrivacyPage } from '@/pages/StaticPages';

async function expectNoViolations(container: HTMLElement): Promise<void> {
  const results = await axe.run(container, {
    rules: {
      // jsdom cannot compute real colors/layout; contrast is asserted by the
      // token design review instead (documented in docs/AUDIT.md).
      'color-contrast': { enabled: false },
    },
  });
  const violations = results.violations.map((v) => `${v.id}: ${v.nodes.length} node(s) — ${v.help}`);
  expect(violations).toEqual([]);
}

describe('accessibility (axe-core)', () => {
  it('login page has no WCAG violations', async () => {
    const { container } = render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    await expectNoViolations(container);
  });

  it('signup page has no WCAG violations', async () => {
    const { container } = render(
      <MemoryRouter>
        <SignupPage />
      </MemoryRouter>,
    );
    await expectNoViolations(container);
  });

  it('privacy page has no WCAG violations', async () => {
    const { container } = render(
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>,
    );
    await expectNoViolations(container);
  });
});
