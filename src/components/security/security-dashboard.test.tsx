import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import deBase from '@aster-cloud/ui-messages/de-DE.json';
import enBase from '@aster-cloud/ui-messages/en-US.json';
import { IntlClientProvider } from '@/i18n/intl-client-provider';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';
import { SecurityDashboard } from './security-dashboard';

const germanMessages = deepMergeMessages(
  deBase as Record<string, unknown>,
  DEMO_SUPPLEMENT.de,
);

const stats = {
  total: 0,
  bySeverity: { INFO: 0, WARNING: 0, ERROR: 0, CRITICAL: 0 },
  byType: {},
  errorRate: 0,
  period: { startDate: '2026-01-01T00:00:00.000Z', endDate: '2026-01-02T00:00:00.000Z' },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SecurityDashboard localization', () => {
  it('renders German dashboard copy without Chinese characters', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        json: async () => url.includes('/stats') ? stats : { events: [] },
      }),
    ));

    const { container } = render(
      <IntlClientProvider locale="de" messages={germanMessages as never}>
        <SecurityDashboard />
      </IntlClientProvider>,
    );

    await waitFor(() => expect(container.textContent).toContain('Letzte Ereignisse'));
    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
  });
});

describe('SecurityDashboard accessibility (#774)', () => {
  const enMessages = deepMergeMessages(
    enBase as Record<string, unknown>,
    DEMO_SUPPLEMENT.en,
  );

  it('names the icon-only refresh button and the severity filter, exposes the active range, and wraps stats in a <dl>', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) =>
      Promise.resolve({ ok: true, json: async () => url.includes('/stats') ? stats : { events: [] } }),
    ));
    const { container, findByRole, getByRole } = render(
      <IntlClientProvider locale="en" messages={enMessages as never}>
        <SecurityDashboard />
      </IntlClientProvider>,
    );
    expect(await findByRole('button', { name: 'Refresh security data' })).toBeTruthy();
    expect(getByRole('combobox', { name: 'Filter events by severity' })).toBeTruthy();
    expect(getByRole('button', { name: '24 hours' }).getAttribute('aria-pressed')).toBe('true');
    expect(getByRole('button', { name: '7 days' }).getAttribute('aria-pressed')).toBe('false');
    for (const dt of Array.from(container.querySelectorAll('dt'))) {
      expect(dt.closest('dl')).not.toBeNull();
    }
    expect(container.querySelectorAll('dt').length).toBeGreaterThan(0);
  });

  it('does not repeat the page title (the /security PageHeader owns it)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) =>
      Promise.resolve({ ok: true, json: async () => url.includes('/stats') ? stats : { events: [] } }),
    ));
    const { findByRole, queryByRole } = render(
      <IntlClientProvider locale="en" messages={enMessages as never}>
        <SecurityDashboard />
      </IntlClientProvider>,
    );
    await findByRole('button', { name: 'Refresh security data' });
    expect(queryByRole('heading', { name: 'Security monitoring' })).toBeNull();
  });
});
