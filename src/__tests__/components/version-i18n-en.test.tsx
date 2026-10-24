/*
 * 版本对比面板 / 版本列表在 en provider 下渲染英文（UI E2E：/en 页面曾显示硬编码中文）。
 * 用真实消息：@aster-cloud/ui-messages en-US 底座 + demo-supplement en 叠加，与 request.ts 一致。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import enBase from '@aster-cloud/ui-messages/en-US.json';
import deBase from '@aster-cloud/ui-messages/de-DE.json';
import zhBase from '@aster-cloud/ui-messages/zh-CN.json';
import hiBase from '@aster-cloud/ui-messages-hi/hi-IN.json';
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

function withLocale(locale: 'en' | 'zh' | 'de' | 'hi', ui: React.ReactElement) {
  const baseByLocale = { en: enBase, zh: zhBase, de: deBase, hi: hiBase };
  const messages = deepMergeMessages(
    baseByLocale[locale] as Record<string, unknown>,
    DEMO_SUPPLEMENT[locale],
  );
  return render(
    <IntlClientProvider locale={locale} messages={messages as never}>
      {ui}
    </IntlClientProvider>,
  );
}

const base = {
  releaseNote: null, sourceHash: null, createdBy: 'u1', createdAt: '2026-08-01T00:00:00Z',
  deprecatedAt: null, deprecatedBy: null, archivedAt: null, archivedBy: null,
};

describe('版本 UI 文案 key 四语齐备', () => {
  it('★common.cancel 与 versionCompare/versions 补充键在四个语种都有定义', () => {
    const sup = DEMO_SUPPLEMENT as unknown as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
    for (const locale of ['en', 'zh', 'de', 'hi']) {
      expect(sup[locale].common?.cancel, `${locale} common.cancel`).toBeTruthy();
      const compare = sup[locale].policies.versionCompare ?? {};
      const missing = Object.keys(sup.en.policies.versionCompare).filter((k) => !(k in compare));
      expect(missing, `${locale} versionCompare 缺 key`).toEqual([]);
      // sox 仅 zh 覆盖包内笔误（待上游修正），其余语种不补充该组，故比较时排除。
      const ownKeys = (l: string) => Object.keys(sup[l].policies.versions ?? {}).filter((k) => k !== 'sox');
      expect(ownKeys(locale)).toEqual(ownKeys('en'));
    }
  });
});

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
    // 文案缺失时 next-intl 会回显原始 key（如 policies.versions.actions.archive）
    expect(container.textContent).not.toMatch(/policies\.|common\./);
    expect(CJK.test(container.textContent ?? '')).toBe(false);
  });

  it.each([
    ['en', 'Initial version', 'Edited version'],
    ['zh', '初始版本', '编辑后的版本'],
    ['de', 'Anfangsversion', 'Bearbeitete Version'],
    ['hi', 'प्रारंभिक संस्करण', 'संपादित संस्करण'],
  ] as const)('%s：空 release note 与历史英文字面量按版本号本地化', (locale, initialLabel, editedLabel) => {
    const versions = [
      { ...base, id: 'v1', version: 1, status: 'APPROVED', isDefault: true, releaseNote: null },
      { ...base, id: 'v2', version: 2, status: 'APPROVED', isDefault: false, releaseNote: 'Edited version' },
      { ...base, id: 'v3', version: 3, status: 'APPROVED', isDefault: false, releaseNote: null },
    ];
    withLocale(locale, <PolicyVersionList versions={versions as never} />);
    expect(screen.getByText(initialLabel)).toBeTruthy();
    expect(screen.getAllByText(editedLabel)).toHaveLength(2);
    cleanup();
  });
});
