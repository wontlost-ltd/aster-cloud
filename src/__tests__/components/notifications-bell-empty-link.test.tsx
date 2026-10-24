import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => Object.assign((key: string) => key, { raw: (key: string) => key }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => React.createElement('a', { href, ...props }, children),
}));

import { NotificationsBell } from '@/components/notifications/notifications-bell';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('NotificationsBell', () => {
  it('empty notifications do not show the approvals shortcut', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      json: async () => String(input).includes('/count') ? { count: 0 } : { notifications: [] },
    })));
    render(<NotificationsBell />);
    fireEvent.click(screen.getByRole('button', { name: 'label' }));
    await screen.findByText('empty');
    expect(screen.queryByRole('link', { name: /openApprovals/ })).toBeNull();
  });
});
