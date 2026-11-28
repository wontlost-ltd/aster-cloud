// 管理员功能开关卡片：覆盖 ADR 0065 新增的两个 Guard 孤儿通知开关行。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

import { FeatureFlagsCard } from '@/components/admin/feature-flags-card';

const IN_APP = 'guard.orphan_notifications.enabled';
const EMAIL = 'guard.orphan_notifications.email.enabled';

function row(container: HTMLElement, key: string): HTMLElement | null {
  return container.querySelector(`[data-flag-key="${key}"]`);
}

function stubFetch(postOk: boolean) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return { ok: postOk, json: async () => ({}) };
    return {
      ok: true,
      json: async () => ({
        settings: {
          A: { key: IN_APP, value: false },
          B: { key: EMAIL, value: false },
        },
      }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('FeatureFlagsCard Guard 孤儿通知开关', () => {
  it('渲染站内与邮件两行', () => {
    stubFetch(true);
    const { container } = render(<FeatureFlagsCard />);
    expect(row(container, IN_APP)).not.toBeNull();
    expect(row(container, EMAIL)).not.toBeNull();
    expect(row(container, IN_APP)!.textContent).toContain('guardOrphanNotifyTitle');
    expect(row(container, EMAIL)!.textContent).toContain('guardOrphanEmailTitle');
  });

  it('点击发出 POST { key, value: true }', async () => {
    const fetchMock = stubFetch(true);
    const { container } = render(<FeatureFlagsCard />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(row(container, IN_APP)!.querySelector('button')!);
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(post?.[0]).toBe('/api/admin/platform-settings');
      expect(JSON.parse(post![1]!.body as string)).toEqual({ key: IN_APP, value: true });
    });
  });

  it('POST 失败时回滚为关闭', async () => {
    const fetchMock = stubFetch(false);
    const { container } = render(<FeatureFlagsCard />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const emailRow = row(container, EMAIL)!;
    fireEvent.click(emailRow.querySelector('button')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(emailRow.textContent).toContain('off');
      expect(emailRow.textContent).toContain('enable');
      expect(emailRow.textContent).not.toContain('saving');
    });
  });
});
