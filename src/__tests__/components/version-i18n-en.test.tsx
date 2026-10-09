/*
 * 版本对比面板 / 版本列表在 en provider 下渲染英文（UI E2E：/en 页面曾显示硬编码中文）。
 * 用真实消息：@aster-cloud/ui-messages en-US 底座 + demo-supplement en 叠加，与 request.ts 一致。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import enBase from '@aster-cloud/ui-messages/en-US.json';
import { IntlClientProvider } from '@/i18n/intl-client-provider';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';
import { VersionComparePanel } from '@/components/policy/version-compare-panel';
import { PolicyVersionList } from '@/components/policy/policy-version-list';

const messages = deepMergeMessages(enBase as Record<string, unknown>, DEMO_SUPPLEMENT.en);
const CJK = /[一-鿿]/;

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ content: 'Module m.' }) });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function withEn(ui: React.ReactElement) {
  return render(
    <IntlClientProvider locale="en" messages={messages as never}>
      {ui}
    </IntlClientProvider>,
  );
}

const base = {
  releaseNote: null, sourceHash: null, createdBy: 'u1', createdAt: '2026-08-01T00:00:00Z',
  deprecatedAt: null, deprecatedBy: null, archivedAt: null, archivedBy: null,
};

describe('版本 UI 英文渲染', () => {
  it('★VersionComparePanel：标题/基准/比较版本为英文，无中文', async () => {
    const versions = [
      { id: 'r3', version: 3, status: 'APPROVED' as const, isDefault: true, releaseNote: null, createdAt: '2026-08-01T00:00:00Z' },
      { id: 'r2', version: 2, status: 'APPROVED' as const, isDefault: false, releaseNote: null, createdAt: '2026-07-01T00:00:00Z' },
    ];
    const { container } = withEn(<VersionComparePanel policyId="p1" versions={versions} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByText('Version comparison')).toBeTruthy();
    expect(screen.getByText('Base version')).toBeTruthy();
    expect(screen.getByText('Compare version')).toBeTruthy();
    expect(CJK.test(container.textContent ?? '')).toBe(false);
  });

  it('★PolicyVersionList：设为默认/废弃/归档按钮为英文', () => {
    const versions = [
      { ...base, id: 'v2', version: 2, status: 'APPROVED', isDefault: false, _count: { approvals: 2 } },
    ];
    const noop = async () => {};
    const { container } = withEn(
      <PolicyVersionList
        versions={versions as never}
        onSetDefault={noop}
        onDeprecate={noop}
        onArchive={noop}
      />,
    );
    expect(screen.getByText('Make default')).toBeTruthy();
    expect(screen.getByText('Deprecate')).toBeTruthy();
    expect(screen.getByText('Archive')).toBeTruthy();
    expect(screen.getByText('2 approval records')).toBeTruthy();
    expect(CJK.test(container.textContent ?? '')).toBe(false);
  });
});
