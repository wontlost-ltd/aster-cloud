// /reports 历史导出的创建时间：服务端（容器 UTC）与浏览器（本地时区）各自 toLocaleString 会得到
// 不同文本，触发 hydration mismatch。这里在 UTC 下做 SSR、在另一时区下 hydrate，要求零 mismatch。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { raw: (key: string) => key });
  return { useTranslations: () => t };
});

import { ReportsContent } from '@/app/[locale]/(dashboard)/reports/reports-content';

const CREATED_AT = '2026-10-09T23:30:00.000Z';
const props = {
  locale: 'en',
  policies: [],
  initialExports: [
    {
      id: 'exp-1',
      title: 'Export 1',
      status: 'failed' as const,
      period: null,
      count: 3,
      bundleHash: null,
      schemaVersion: null,
      createdAt: CREATED_AT,
      completedAt: null,
    },
  ],
};

const originalTz = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTz;
  document.body.innerHTML = '';
});

describe('ReportsContent — 创建时间 hydration', () => {
  it('服务端 UTC、浏览器 Pacific/Auckland 时 hydrate 不报 mismatch，挂载后显示本地时间', async () => {
    process.env.TZ = 'UTC';
    const html = renderToString(<ReportsContent {...props} />);

    process.env.TZ = 'Pacific/Auckland';
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);

    const recoverable: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      hydrateRoot(container, <ReportsContent {...props} />, {
        onRecoverableError: (err) => recoverable.push(err),
      });
    });
    const mismatchLogs = consoleError.mock.calls.filter((args) => /hydrat/i.test(String(args[0])));
    consoleError.mockRestore();

    expect(recoverable).toEqual([]);
    expect(mismatchLogs).toEqual([]);
    expect(container.textContent).toContain(new Date(CREATED_AT).toLocaleString('en'));
  });
});
