// 侧栏里的策略内嵌词汇（ADR 0060 §6.7、§7.5，计划 T11）：
// - 有能力：词汇标签页顶部是可编辑的「本策略」分组，下层被遮蔽的词条带「被本策略覆盖」；
// - 无能力：策略带词条时在别名面板上方显示只读列表；不带词条时别名标签的 DOM 与没有这个特性时完全相同。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import zhBase from '@aster-cloud/ui-messages/zh-CN.json';
import { IntlClientProvider } from '@/i18n/intl-client-provider';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';

vi.mock('lucide-react', async () => ({ ...(await vi.importActual<Record<string, unknown>>('lucide-react')) }));
vi.mock('@/components/policy/ai-assistant-panel', () => ({ AIAssistantPanel: () => <div data-testid="legacy-ai" /> }));
vi.mock('@/components/policy/cnl-syntax-reference-panel', () => ({ CNLSyntaxReferencePanel: () => null }));
vi.mock('@/components/policy/policy-alias-panel', () => ({ PolicyAliasPanel: () => <div data-testid="alias-panel" /> }));
vi.mock('@/hooks/useDomainVocabularyInvalidate', () => ({ pollDomainVocabularyNow: vi.fn() }));

import { SidePanel, type SidePanelTab } from '@/components/policy/policy-form/side-panel';
import type { StructuredAuthoringProps } from '@/lib/capabilities/types';
import type { EmbeddedVocabulary } from '@/lib/policy-embedded-vocabulary';
import type { VocabularyTabTerm } from '@/hooks/useUserVocabularyRegistration';

const messages = deepMergeMessages(zhBase as Record<string, unknown>, DEMO_SUPPLEMENT.zh) as {
  policyEditor: { embeddedTerms: Record<string, string> };
};
const M = messages.policyEditor.embeddedTerms;
const noop = () => {};
const DENIED: StructuredAuthoringProps = { allowed: false, denial: 'not_granted', sources: [] };
const ALLOWED: StructuredAuthoringProps = { allowed: true, sources: [{ kind: 'admin' }] };
const POEM: EmbeddedVocabulary = {
  v: 1,
  terms: [
    { kind: 'literal', localized: '思故乡', canonical: '静夜思' },
    { kind: 'struct', localized: '望明月', canonical: 'Text' },
  ],
};
const TERMS: VocabularyTabTerm[] = [
  { kind: 'struct', localized: '望明月', canonical: 'Moon', domain: 'd', locale: 'zh', shadowedByPolicy: true },
  { kind: 'struct', localized: '地上霜', canonical: 'Frost', domain: 'd', locale: 'zh' },
];

function renderPanel(structuredAuthoring: StructuredAuthoringProps, tab: SidePanelTab, embedded: EmbeddedVocabulary | null | undefined) {
  return render(
    <IntlClientProvider locale="zh" messages={messages as never}>
      <SidePanel
        editor={null}
        cnlLocale="zh-CN"
        uiLocale="zh"
        name=""
        description=""
        groupId={null}
        isPublic={false}
        onNameChange={noop}
        onDescriptionChange={noop}
        onGroupIdChange={noop}
        onIsPublicChange={noop}
        aliasSet={{}}
        reservedSets={{} as never}
        allowStructuralAliases={false}
        onAliasSetChange={noop}
        onApplyContent={noop}
        onApplyTemplate={noop}
        onClose={noop}
        initialTab={tab}
        policyId="p1"
        aiWorkspace={null}
        structuredAuthoring={structuredAuthoring}
        vocabularyTerms={TERMS}
        {...(embedded === undefined ? {} : { embeddedVocabulary: embedded, onEmbeddedVocabularyChange: noop })}
      />
    </IntlClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: noop, removeEventListener: noop }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SidePanel 内嵌词汇', () => {
  it('有能力：词汇标签页顶部是可编辑的「本策略」分组，排在作用域内词汇之前', () => {
    renderPanel(ALLOWED, 'vocabulary', POEM);
    const tab = screen.getByTestId('structured-authoring-vocabulary');
    const section = within(tab).getByTestId('embedded-vocabulary');
    expect(within(section).getAllByTestId('embedded-term')).toHaveLength(2);
    expect(within(section).getByRole('button', { name: M.add })).toBeTruthy();
    const firstGroup = within(tab).getByTestId('vocab-group-groupStruct');
    expect(section.compareDocumentPosition(firstGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('有能力：被内嵌词条遮蔽的下层词条带「被本策略覆盖」', () => {
    renderPanel(ALLOWED, 'vocabulary', POEM);
    const badges = screen.getAllByTestId('vocab-term-shadowed');
    expect(badges).toHaveLength(1);
    expect(badges[0]!.textContent).toBe(M.shadowedBadge);
    expect(badges[0]!.closest('li')!.textContent).toContain('望明月');
  });

  it('有能力：别名标签不显示只读列表（编辑入口在词汇标签）', () => {
    renderPanel(ALLOWED, 'aliases', POEM);
    expect(screen.queryByTestId('embedded-vocabulary')).toBeNull();
  });

  it('无能力且带词条：别名面板上方是只读列表，没有输入控件', () => {
    renderPanel(DENIED, 'aliases', POEM);
    const section = screen.getByTestId('embedded-vocabulary');
    expect(section.compareDocumentPosition(screen.getByTestId('alias-panel')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(section).getByText(M.readOnlyNote)).toBeTruthy();
    expect(section.querySelectorAll('input, select, button, form')).toHaveLength(0);
  });

  it('无能力且无词条：别名标签 DOM 与不传这个特性的 props 时逐字节相同', () => {
    const legacy = renderPanel(DENIED, 'aliases', undefined).container.innerHTML;
    cleanup();
    expect(renderPanel(DENIED, 'aliases', null).container.innerHTML).toBe(legacy);
    cleanup();
    expect(renderPanel(DENIED, 'aliases', { v: 1, terms: [] }).container.innerHTML).toBe(legacy);
  });
});
