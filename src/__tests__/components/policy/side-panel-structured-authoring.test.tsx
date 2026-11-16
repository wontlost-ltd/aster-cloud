// 编辑器侧栏「模型 / 词汇」标签（ADR 0058 §8.3）：能力为假时 DOM 与接入前逐字节一致，为真时出现两个标签容器。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import zhBase from '@aster-cloud/ui-messages/zh-CN.json';
import { IntlClientProvider } from '@/i18n/intl-client-provider';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';

vi.mock('lucide-react', async () => ({ ...(await vi.importActual<Record<string, unknown>>('lucide-react')) }));
vi.mock('@/components/policy/ai-assistant-panel', () => ({ AIAssistantPanel: () => <div data-testid="legacy-ai" /> }));
vi.mock('@/components/policy/cnl-syntax-reference-panel', () => ({ CNLSyntaxReferencePanel: () => null }));
vi.mock('@/components/policy/policy-alias-panel', () => ({ PolicyAliasPanel: () => null }));

import { SidePanel, type SidePanelTab } from '@/components/policy/policy-form/side-panel';
import { EditorRail } from '@/components/policy/policy-form/editor-rail';
import type { StructuredAuthoringProps } from '@/lib/capabilities/types';

const messages = deepMergeMessages(zhBase as Record<string, unknown>, DEMO_SUPPLEMENT.zh);
const noop = () => {};
const EDITOR_TABS = (messages as { policyEditor: { tabModel: string; tabVocabulary: string } }).policyEditor;

const DENIED: StructuredAuthoringProps = { allowed: false, denial: 'not_granted', sources: [] };
const ALLOWED: StructuredAuthoringProps = { allowed: true, sources: [{ kind: 'admin' }] };

function panel(
  structuredAuthoring: StructuredAuthoringProps,
  initialTab: SidePanelTab = 'ai',
  extra: { compileSource?: string; aliasSet?: Record<string, string[]> } = {},
) {
  return (
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
        aliasSet={extra.aliasSet ?? {}}
        reservedSets={{} as never}
        allowStructuralAliases={false}
        onAliasSetChange={noop}
        onApplyContent={noop}
        onApplyTemplate={noop}
        onClose={noop}
        initialTab={initialTab}
        policyId="p1"
        aiWorkspace={null}
        structuredAuthoring={structuredAuthoring}
        compileSource={extra.compileSource}
      />
    </IntlClientProvider>
  );
}

function rail(structuredAuthoring: StructuredAuthoringProps) {
  return (
    <IntlClientProvider locale="zh" messages={messages as never}>
      <EditorRail open activeTab="ai" errorCount={0} onSelect={noop} structuredAuthoring={structuredAuthoring} />
    </IntlClientProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(min-width: 1024px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SidePanel structuredAuthoring', () => {
  it('allowed=false renders the same DOM as before', () => {
    const { container } = render(panel(DENIED));
    expect(container.innerHTML).toMatchInlineSnapshot(`"<aside class="flex h-full min-h-0 w-full min-w-0 flex-col rounded-xl border border-border bg-bg shadow-sm" aria-label="切换侧边栏"><header class="flex items-center justify-between gap-2 border-b border-border px-3 py-2"><div class="flex min-w-0 items-center gap-2"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sparkles size-4 shrink-0 text-fg-muted" aria-hidden="true"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"></path><path d="M20 2v4"></path><path d="M22 4h-4"></path><circle cx="4" cy="20" r="2"></circle></svg><span class="truncate text-sm font-medium text-fg">AI</span></div><button type="button" aria-label="切换侧边栏" class="shrink-0 rounded p-1 text-fg-muted hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:shadow-ring"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x size-4" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button></header><div class="min-h-0 flex-1 overflow-y-auto"><div class="p-3"><div data-testid="legacy-ai"></div></div></div></aside>"`);
  });

  it('allowed=false does not mount the model or vocabulary containers', () => {
    render(panel(DENIED, 'model'));
    expect(screen.queryByTestId('structured-authoring-model')).toBeNull();
    cleanup();
    render(panel(DENIED, 'vocabulary'));
    expect(screen.queryByTestId('structured-authoring-vocabulary')).toBeNull();
  });

  it('allowed=true mounts the model and vocabulary containers on their tabs', () => {
    render(panel(ALLOWED, 'model'));
    expect(screen.getByTestId('structured-authoring-model')).toBeTruthy();
    cleanup();
    render(panel(ALLOWED, 'vocabulary'));
    expect(screen.getByTestId('structured-authoring-vocabulary')).toBeTruthy();
  });
});

describe('SidePanel 模型标签', () => {
  it('按 compileSource 与 cnlLocale 渲染大纲', () => {
    render(panel(ALLOWED, 'model', { compileSource: '模块 演示。\n\n定义 申请人 包含 姓名 作为 文本。\n' }));
    expect(screen.getByRole('button', { name: /^申请人$/ })).toBeTruthy();
  });

  it('大纲解析带上策略关键词别名', () => {
    render(
      panel(ALLOWED, 'model', {
        compileSource: '模块 演示。\n\n声明 申请人 包含 姓名 作为 文本。\n',
        aliasSet: { TYPE_DEF: ['声明'] },
      }),
    );
    expect(screen.getByRole('button', { name: /^申请人$/ })).toBeTruthy();
  });
});

describe('EditorRail structuredAuthoring', () => {
  it('allowed=false renders no model or vocabulary buttons', () => {
    render(rail(DENIED));
    expect(screen.getAllByRole('button')).toHaveLength(6);
  });

  it('allowed=true shows Model and Vocabulary tab buttons', () => {
    render(rail(ALLOWED));
    expect(screen.getAllByRole('button')).toHaveLength(8);
    expect(screen.getByRole('button', { name: EDITOR_TABS.tabModel })).toBeTruthy();
    expect(screen.getByRole('button', { name: EDITOR_TABS.tabVocabulary })).toBeTruthy();
  });
});
