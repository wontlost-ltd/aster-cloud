// 编辑器侧栏「模型 / 词汇」标签（ADR 0058 §8.3）：能力为假时 DOM 与接入前逐字节一致，为真时出现两个标签容器。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
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
const EDITOR_TABS = (messages as {
  policyEditor: {
    tabModel: string;
    tabVocabulary: string;
    canonicalPreview: Record<string, string>;
    modelTab: Record<string, string>;
    layoutTab: Record<string, string>;
  };
}).policyEditor;

const DENIED: StructuredAuthoringProps = { allowed: false, denial: 'not_granted', sources: [] };
const ALLOWED: StructuredAuthoringProps = { allowed: true, sources: [{ kind: 'admin' }] };

function panel(
  structuredAuthoring: StructuredAuthoringProps,
  initialTab: SidePanelTab = 'ai',
  extra: {
    compileSource?: string;
    aliasSet?: Record<string, string[]>;
    canonicalPreview?: { open: boolean; onToggle: () => void } | null;
    newStructRequested?: boolean;
    onNewStructRequestHandled?: () => void;
    layoutPanel?: ReactNode;
  } = {},
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
        canonicalPreview={extra.canonicalPreview}
        newStructRequested={extra.newStructRequested}
        onNewStructRequestHandled={extra.onNewStructRequestHandled}
        layoutPanel={extra.layoutPanel}
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

// 词汇规范预览开关（ADR 0058 §8.3）：只在父层传入（能力为真且 LSP 支持）时出现在词汇标签页顶部
describe('SidePanel 词汇规范预览开关', () => {
  it('未传 canonicalPreview（LSP 不支持）：词汇标签页没有开关', () => {
    render(panel(ALLOWED, 'vocabulary'));
    expect(screen.queryByRole('button', { name: EDITOR_TABS.canonicalPreview.show })).toBeNull();
  });

  it('传入时显示开关，点击切换；按下状态随 open', () => {
    const onToggle = vi.fn();
    render(panel(ALLOWED, 'vocabulary', { canonicalPreview: { open: false, onToggle } }));
    const btn = screen.getByRole('button', { name: EDITOR_TABS.canonicalPreview.show });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
    cleanup();
    render(panel(ALLOWED, 'vocabulary', { canonicalPreview: { open: true, onToggle } }));
    expect(screen.getByRole('button', { name: EDITOR_TABS.canonicalPreview.hide }).getAttribute('aria-pressed')).toBe('true');
  });

  it('能力为假时即使传入也不渲染（词汇标签页不挂载）', () => {
    render(panel(DENIED, 'vocabulary', { canonicalPreview: { open: false, onToggle: noop } }));
    expect(screen.queryByRole('button', { name: EDITOR_TABS.canonicalPreview.show })).toBeNull();
  });
});

describe('SidePanel 命令面板「新建结构体」', () => {
  it('请求打开时模型标签页显示新建结构体表单并回执', () => {
    const handled = vi.fn();
    render(panel(ALLOWED, 'model', { newStructRequested: true, onNewStructRequestHandled: handled }));
    expect(screen.getByRole('form', { name: EDITOR_TABS.modelTab.newStruct })).toBeTruthy();
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it('未请求时不打开表单', () => {
    render(panel(ALLOWED, 'model'));
    expect(screen.queryByRole('form', { name: EDITOR_TABS.modelTab.newStruct })).toBeNull();
  });
});

describe('EditorRail structuredAuthoring', () => {
  it('allowed=false renders no model or vocabulary buttons', () => {
    render(rail(DENIED));
    expect(screen.getAllByRole('button')).toHaveLength(6);
  });

  it('allowed=false renders the same rail DOM as before', () => {
    const { container } = render(rail(DENIED));
    expect(container.innerHTML).toMatchInlineSnapshot(`"<nav class="hidden h-full w-12 shrink-0 flex-col items-center gap-1 rounded-xl border border-border bg-bg p-1.5 shadow-sm lg:flex" aria-label="切换侧边栏"><button type="button" title="策略信息" aria-label="策略信息" aria-pressed="false" class="relative inline-flex size-9 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:shadow-ring text-fg-muted hover:bg-bg-subtle hover:text-fg"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-settings size-4" aria-hidden="true"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"></path><circle cx="12" cy="12" r="3"></circle></svg></button><button type="button" title="关键词别名" aria-label="关键词别名" aria-pressed="false" class="relative inline-flex size-9 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:shadow-ring text-fg-muted hover:bg-bg-subtle hover:text-fg"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-tags size-4" aria-hidden="true"><path d="M13.172 2a2 2 0 0 1 1.414.586l6.71 6.71a2.4 2.4 0 0 1 0 3.408l-4.592 4.592a2.4 2.4 0 0 1-3.408 0l-6.71-6.71A2 2 0 0 1 6 9.172V3a1 1 0 0 1 1-1z"></path><path d="M2 7v6.172a2 2 0 0 0 .586 1.414l6.71 6.71a2.4 2.4 0 0 0 3.191.193"></path><circle cx="10.5" cy="6.5" r=".5" fill="currentColor"></circle></svg></button><button type="button" title="决策预览" aria-label="决策预览" aria-pressed="false" class="relative inline-flex size-9 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:shadow-ring text-fg-muted hover:bg-bg-subtle hover:text-fg"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-triangle-alert size-4" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path></svg></button><button type="button" title="AI" aria-label="AI" aria-pressed="true" class="relative inline-flex size-9 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:shadow-ring bg-primary-subtle text-primary-hover"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sparkles size-4" aria-hidden="true"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"></path><path d="M20 2v4"></path><path d="M22 4h-4"></path><circle cx="4" cy="20" r="2"></circle></svg></button><button type="button" title="语法" aria-label="语法" aria-pressed="false" class="relative inline-flex size-9 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:shadow-ring text-fg-muted hover:bg-bg-subtle hover:text-fg"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-book-open size-4" aria-hidden="true"><path d="M12 5v16"></path><path d="M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z"></path></svg></button><button type="button" title="模板" aria-label="模板" aria-pressed="false" class="relative inline-flex size-9 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:shadow-ring text-fg-muted hover:bg-bg-subtle hover:text-fg"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-layout-template size-4" aria-hidden="true"><rect width="18" height="7" x="3" y="3" rx="1"></rect><rect width="9" height="7" x="3" y="14" rx="1"></rect><rect width="5" height="7" x="16" y="14" rx="1"></rect></svg></button></nav>"`);
  });

  it('allowed=true shows Model, Vocabulary and Layout tab buttons', () => {
    render(rail(ALLOWED));
    expect(screen.getAllByRole('button')).toHaveLength(9);
    expect(screen.getByRole('button', { name: EDITOR_TABS.tabModel })).toBeTruthy();
    expect(screen.getByRole('button', { name: EDITOR_TABS.tabVocabulary })).toBeTruthy();
    expect(screen.getByRole('button', { name: EDITOR_TABS.layoutTab.title })).toBeTruthy();
  });
});

// 「排版」标签（ADR 0058 §7.4，裁决 R11）：内容由 PolicyForm 传入，只在能力为真时挂载
describe('SidePanel 排版标签', () => {
  it('allowed=true：layout 标签渲染传入的内容，标题为「排版」', () => {
    render(panel(ALLOWED, 'layout', { layoutPanel: <div data-testid="layout-panel" /> }));
    expect(screen.getByTestId('layout-panel')).toBeTruthy();
    expect(screen.getByText(EDITOR_TABS.layoutTab.title)).toBeTruthy();
  });

  it('allowed=false：即使传入内容也不渲染', () => {
    render(panel(DENIED, 'layout', { layoutPanel: <div data-testid="layout-panel" /> }));
    expect(screen.queryByTestId('layout-panel')).toBeNull();
  });
});
