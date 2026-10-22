// 「你的 AI 数据」下载失败（F24）：生产上点「下载 JSON」后没有可见反馈。
// 现在显示常驻的本地化错误（附错误编号），不渲染服务端英文原文。
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';
import { DataContent } from '@/app/[locale]/(dashboard)/settings/data/data-content';

const pkgZh = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../../../node_modules/@aster-cloud/ui-messages/zh-CN.json'),
    'utf8',
  ),
);
const messages = deepMergeMessages(pkgZh, DEMO_SUPPLEMENT.zh);
const S = (messages as { settings: { dataPage: Record<string, unknown> } }).settings.dataPage;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DataContent 下载失败', () => {
  it('★显示本地化错误与错误编号，不显示服务端原文', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'audit_export_unavailable',
                message: 'AI data export is temporarily unavailable.',
                requestId: 'req-123',
              },
            }),
            { status: 503 },
          ),
      ),
    );
    render(
      <NextIntlClientProvider locale="zh" messages={messages}>
        <DataContent />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: (S.downloadCard as Record<string, string>).action }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(S.downloadUnavailable as string);
    expect(alert.textContent).toContain('req-123');
    expect(alert.textContent).not.toContain('temporarily unavailable');
  });
});
