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
import { defaultControlRegistry, type ControlRegistryData } from '@/services/evidence/control-registry';

const messages = deepMergeMessages(zhBase as Record<string, unknown>, DEMO_SUPPLEMENT.zh);
const base = { name: 'credit.pilot', functions: ['decide'], types: [] };

function renderZh(
  module: typeof base & { profile?: string; inputRefs?: Record<string, readonly string[]> },
  registry?: ControlRegistryData,
) {
  return render(
    <IntlClientProvider locale="zh" messages={messages as never}>
      <DecisionTab state="ok" diagnostics={[]} module={module} locale="zh" registry={registry} />
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

/* ADR 0046 §11 D4 / X4 Task C2：规则输入引用取自浏览器 Core IR 的 Func.inputRefs。 */
describe('DecisionTab 规则输入引用', () => {
  const HINT = /运行时这些字段须由已登记签发方签名/;
  const requiring = (id: string): ControlRegistryData => {
    const r = structuredClone(defaultControlRegistry);
    r.profiles.find((p) => p.id === id)!.requires.verifiedInputs = true;
    return r;
  };

  it('★列出规则读取的输入字段路径', () => {
    renderZh({ ...base, profile: 'eu-ai-act-high-risk', inputRefs: { decide: ['applicant.creditScore', 'applicant.requestedAmount'] } });
    expect(screen.getByText(/规则读取的输入字段/)).toBeTruthy();
    expect(screen.getByText('applicant.creditScore')).toBeTruthy();
    expect(screen.getByText('applicant.requestedAmount')).toBeTruthy();
  });

  it('["*"] → 无法静态确定', () => {
    renderZh({ ...base, profile: 'eu-ai-act-high-risk', inputRefs: { decide: ['*'] } });
    expect(screen.getByText(/无法静态确定/)).toBeTruthy();
    expect(screen.queryByText('*')).toBeNull();
  });

  it('[""] → 整个输入', () => {
    renderZh({ ...base, profile: 'eu-ai-act-high-risk', inputRefs: { decide: [''] } });
    expect(screen.getByText('整个输入')).toBeTruthy();
  });

  it('[] → 不读取输入', () => {
    renderZh({ ...base, profile: 'eu-ai-act-high-risk', inputRefs: { decide: [] } });
    expect(screen.getByText('不读取输入')).toBeTruthy();
  });

  it('多个规则 → 按函数名分组', () => {
    renderZh({ ...base, functions: ['decide', 'score'], profile: 'governed', inputRefs: { decide: ['a.b'], score: ['c'] } });
    expect(screen.getByText('decide:')).toBeTruthy();
    expect(screen.getByText('score:')).toBeTruthy();
    expect(screen.getByText('a.b')).toBeTruthy();
    expect(screen.getByText('c')).toBeTruthy();
  });

  it('★档案要求 verifiedInputs → 显示签名提示；governed 档案不显示', () => {
    const refs = { decide: ['applicant.creditScore'] };
    renderZh({ ...base, profile: 'eu-ai-act-high-risk', inputRefs: refs }, requiring('eu-ai-act-high-risk'));
    expect(screen.getByText(HINT)).toBeTruthy();
    cleanup();
    renderZh({ ...base, profile: 'governed', inputRefs: refs }, requiring('eu-ai-act-high-risk'));
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('默认注册表 1.2.0 不要求 verifiedInputs → 不显示签名提示', () => {
    renderZh({ ...base, profile: 'eu-ai-act-high-risk', inputRefs: { decide: ['applicant.creditScore'] } });
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('摘要无 inputRefs（未声明档案的模块）→ 不显示输入字段块', () => {
    renderZh(base);
    expect(screen.queryByText(/规则读取的输入字段/)).toBeNull();
  });
});

describe('DecisionTab 空状态（F6）', () => {
  const EMPTY = /暂无可预览的内容/;
  const renderState = (state: 'pending' | 'ok' | 'error', diagnostics: Parameters<typeof DecisionTab>[0]['diagnostics'] = []) =>
    render(
      <IntlClientProvider locale="zh" messages={messages as never}>
        <DecisionTab state={state} diagnostics={diagnostics} locale="zh" />
      </IntlClientProvider>,
    );

  it('★编译通过但没有模块摘要 → 显示说明，而不是空白', () => {
    renderState('ok');
    expect(screen.getByText(EMPTY)).toBeTruthy();
  });

  it('编译中 → 显示说明', () => {
    renderState('pending');
    expect(screen.getByText(EMPTY)).toBeTruthy();
  });

  it('只有 info/hint 诊断 → 显示说明', () => {
    renderState('ok', [{ severity: 'info', message: 'i', startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 }]);
    expect(screen.getByText(EMPTY)).toBeTruthy();
  });

  it('有错误 → 显示错误列表，不显示空状态', () => {
    renderState('error', [{ severity: 'error', message: 'boom', startLine: 2, startColumn: 3, endLine: 2, endColumn: 4 }]);
    expect(screen.getByText('boom')).toBeTruthy();
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  it('有模块摘要 → 不显示空状态', () => {
    renderZh(base);
    expect(screen.queryByText(EMPTY)).toBeNull();
  });
});

describe('编辑器新增文案四语齐全（F6 / F30）', () => {
  it.each(['en', 'zh', 'de', 'hi'] as const)('%s 含 decisionEmpty 与 mobileReadOnlyNotice', (locale) => {
    const form = (DEMO_SUPPLEMENT[locale] as { policies: { form: Record<string, unknown> } }).policies.form;
    expect(typeof form.decisionEmpty === 'string' && form.decisionEmpty.length > 0).toBe(true);
    expect(typeof form.mobileReadOnlyNotice === 'string' && form.mobileReadOnlyNotice.length > 0).toBe(true);
  });

  const INPUT_REFS_KEYS = [
    'decisionInputRefs', 'decisionInputRefsUnknown', 'decisionInputRefsWholeInput', 'decisionInputRefsNone', 'decisionInputRefsVerifiedHint',
  ] as const;
  it.each(['en', 'zh', 'de', 'hi'] as const)('%s 含 decisionInputRefs* 全部文案', (locale) => {
    const form = (DEMO_SUPPLEMENT[locale] as { policies: { form: Record<string, unknown> } }).policies.form;
    expect(INPUT_REFS_KEYS.filter((k) => !(typeof form[k] === 'string' && (form[k] as string).length > 0))).toEqual([]);
  });
});

/* ADR 0051 §1 / 2026-10-30 生产复测 A4：词汇歧义诊断（含保存时服务端返回的诊断）带出写法与词汇页链接。 */
describe('DecisionTab 词汇诊断链接', () => {
  it('★E804 → 「在领域词汇中查看“Hoch”」链接；普通诊断不带链接', () => {
    render(
      <IntlClientProvider locale="zh" messages={messages as never}>
        <DecisionTab
          state="error"
          locale="zh"
          diagnostics={[
            { severity: 'error', code: 'E804', message: "Name 'Hoch' in MEMBER_REF position is ambiguous between: High (Hoch), high (hoch)", startLine: 9, startColumn: 14, endLine: 9, endColumn: 18 },
            { severity: 'error', code: 'E003', message: 'x', startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
          ]}
        />
      </IntlClientProvider>,
    );
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe('在领域词汇中查看“Hoch”');
    expect(links[0].getAttribute('href')).toBe('/zh/domain-vocabularies?q=Hoch');
  });
});
