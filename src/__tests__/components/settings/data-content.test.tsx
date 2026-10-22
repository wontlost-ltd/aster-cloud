// 「你的 AI 数据」下载失败（F24）：生产上点「下载 JSON」后没有可见反馈。
// 现在显示常驻的本地化错误（附错误编号），不渲染服务端英文原文。
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
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

// AI 工作台对话的导出 / 抹除（F23）：工作台部分失败或有法律保留时给常驻的本地化提示。
const D = S.deleteCard as Record<string, string>;

function renderZh() {
  render(
    <NextIntlClientProvider locale="zh" messages={messages}>
      <DataContent />
    </NextIntlClientProvider>,
  );
}

describe('DataContent AI 工作台导出', () => {
  it('★工作台数据未能包含 → 文件照常下载，并提示工作台部分缺失', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ records: [], aiWorkspace: { error: 'unavailable' } }), { status: 200 })),
    );
    renderZh();
    fireEvent.click(screen.getByRole('button', { name: (S.downloadCard as Record<string, string>).action }));
    expect(await screen.findByText(S.workspaceExportUnavailable as string)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();
    expect(screen.queryByText(S.downloadUnavailable as string)).toBeNull();
  });

  it('工作台数据已包含 → 不提示', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ records: [], aiWorkspace: { conversations: [] } }), { status: 200 })),
    );
    renderZh();
    fireEvent.click(screen.getByRole('button', { name: (S.downloadCard as Record<string, string>).action }));
    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(screen.queryByText(S.workspaceExportUnavailable as string)).toBeNull();
    expect(screen.queryByText(S.auditContentUnavailable as string)).toBeNull();
  });

  it('★审计原文无法解密（review I2）→ 文件照常下载，提示原文部分缺失，工作台提示不受影响', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ records: [], auditContent: { error: 'unavailable' }, aiWorkspace: { conversations: [] } }),
            { status: 200 },
          ),
      ),
    );
    renderZh();
    fireEvent.click(screen.getByRole('button', { name: (S.downloadCard as Record<string, string>).action }));
    expect(await screen.findByText(S.auditContentUnavailable as string)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();
    expect(screen.queryByText(S.workspaceExportUnavailable as string)).toBeNull();
    expect(screen.queryByText(S.downloadUnavailable as string)).toBeNull();
  });
});

describe('DataContent AI 工作台抹除', () => {
  // jsdom 未实现 <dialog>.showModal/close（ConfirmDialog 依赖）：补最小桩，只切换 open 属性。
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  });

  async function erase(response: unknown) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })));
    renderZh();
    fireEvent.click(screen.getByRole('button', { name: D.action }));
    fireEvent.click(await screen.findByRole('button', { name: D.confirmAction }));
  }

  it('★有线程处于法律保留 → 提示保留数量', async () => {
    await erase({ records_cleared: 2, aiWorkspace: { deletedConversations: 3, deletedAudit: 9, tenantHold: false, held: ['a', 'b'] } });
    const expected = D.workspaceHeld.replace('{count}', '2');
    expect(await screen.findByText(expected)).toBeTruthy();
  });

  it('用户级法律保留 → 提示全部未删除', async () => {
    await erase({ records_cleared: 0, aiWorkspace: { deletedConversations: 0, deletedAudit: 0, tenantHold: true, held: ['a'] } });
    expect(await screen.findByText(D.workspaceTenantHold)).toBeTruthy();
  });

  it('★工作台抹除失败 → 提示部分失败', async () => {
    await erase({ records_cleared: 2, aiWorkspace: { error: 'unavailable' } });
    expect(await screen.findByText(D.workspaceFailed)).toBeTruthy();
  });

  it('工作台全部删除或未部署 → 不提示', async () => {
    await erase({ records_cleared: 2, aiWorkspace: { deletedConversations: 1, deletedAudit: 1, tenantHold: false, held: [] } });
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: D.confirmAction })).toBeNull());
    expect(screen.queryByText(D.workspaceFailed)).toBeNull();
    expect(screen.queryByText(D.workspaceTenantHold)).toBeNull();
  });
});
