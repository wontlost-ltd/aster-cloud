// 编辑器侧栏决策页的模块块（ADR 0046 §6）：摘要带 profile 时显示档案标签与按 locale 的注册表标题。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import zhBase from '@aster-cloud/ui-messages/zh-CN.json';
import { IntlClientProvider } from '@/i18n/intl-client-provider';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';

// 侧栏其余面板与本用例无关，替换为空壳避免拖入 Monaco 依赖树
vi.mock('@/components/policy/ai-assistant-panel', () => ({ AIAssistantPanel: () => null }));
vi.mock('@/components/policy/cnl-syntax-reference-panel', () => ({ CNLSyntaxReferencePanel: () => null }));
vi.mock('@/components/policy/policy-alias-panel', () => ({ PolicyAliasPanel: () => null }));

import { DecisionTab } from '@/components/policy/policy-form/side-panel';

const messages = deepMergeMessages(zhBase as Record<string, unknown>, DEMO_SUPPLEMENT.zh);
const base = { name: 'credit.pilot', functions: ['decide'], types: [] };

function renderZh(module: typeof base & { profile?: string }) {
  return render(
    <IntlClientProvider locale="zh" messages={messages as never}>
      <DecisionTab state="ok" diagnostics={[]} module={module} locale="zh" />
    </IntlClientProvider>,
  );
}

afterEach(cleanup);

describe('DecisionTab 治理档案', () => {
  it('摘要带 profile → 显示「治理档案」与中文标题', () => {
    renderZh({ ...base, profile: 'eu-ai-act-high-risk' });
    expect(screen.getByText(/治理档案/)).toBeTruthy();
    expect(screen.getByText('欧盟人工智能法高风险系统')).toBeTruthy();
  });

  it('摘要无 profile → 不显示档案行', () => {
    renderZh(base);
    expect(screen.getByText('credit.pilot')).toBeTruthy();
    expect(screen.queryByText(/治理档案/)).toBeNull();
  });
});
