import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

/**
 * AI 行内补全开关的接线测试——守的是「关掉之后真的不再发请求」。
 *
 * ★为什么单独成文件：开关的价值全在调用点。偏好存储、状态栏按钮各自测得再好，
 *   也证明不了 Monaco provider 在请求那一刻读的是**当前**开关值。
 *   provider 只在 onMount 注册一次，若读的是挂载时闭包里的 prop，
 *   编辑中途切换就会静默失效——本文件逐条锁住这些调用点。
 *
 * Monaco 探针结构沿用 monaco-policy-editor-wiring.test.tsx。
 */

// ── Monaco 探针：捕获注册的补全 provider ──────────────────────────────
type InlineResult = { items: Array<{ insertText: string }> };
type InlineProvider = {
  provideInlineCompletions: (model: unknown, position: unknown, ctx: unknown, token: unknown) => Promise<InlineResult> | InlineResult;
};
const inlineProviders: InlineProvider[] = [];
const registeredProviders: Array<{
  languageId: string;
  provider: { provideCompletionItems: (...a: unknown[]) => unknown };
}> = [];

const fakeMonaco = {
  languages: {
    register: vi.fn(),
    setMonarchTokensProvider: vi.fn(),
    setLanguageConfiguration: vi.fn(),
    registerCompletionItemProvider: vi.fn(
      (languageId: string, provider: { provideCompletionItems: (...a: unknown[]) => unknown }) => {
        registeredProviders.push({ languageId, provider });
        return { dispose: vi.fn() };
      },
    ),
    registerInlineCompletionsProvider: vi.fn((_lang: string, provider: InlineProvider) => {
      inlineProviders.push(provider);
      return { dispose: vi.fn() };
    }),
    registerHoverProvider: vi.fn(() => ({ dispose: vi.fn() })),
    CompletionItemKind: { Keyword: 17, Module: 8, Variable: 4, Function: 1, Snippet: 27 },
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
  },
  editor: {
    defineTheme: vi.fn(),
    setTheme: vi.fn(),
    setModelMarkers: vi.fn(),
    getModelMarkers: vi.fn(() => []),
  },
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
  Range: class {
    constructor(
      public startLineNumber: number,
      public startColumn: number,
      public endLineNumber: number,
      public endColumn: number,
    ) {}
  },
  KeyMod: { CtrlCmd: 2048, Shift: 1024 },
  KeyCode: { KeyG: 37, KeyE: 35 },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
};

// 编辑器实例探针：provider 回调只用到 getModel / getValue 等少数方法
const fakeModel = {
  getValue: () => 'Module demo.\n',
  getVersionId: () => 1,
  uri: { toString: () => 'inmemory://policy/default.aster' },
  getWordUntilPosition: () => ({ word: '', startColumn: 1, endColumn: 1 }),
  getValueInRange: () => '模块 demo。\n规则 ',
  getLinesContent: () => [''],
  getOffsetAt: () => 0,
  getPositionAt: () => ({ lineNumber: 1, column: 1 }),
  getLineContent: () => '',
  getLineCount: () => 1,
  onDidChangeContent: () => ({ dispose: vi.fn() }),
  deltaDecorations: () => [],
};
const fakeEditor = {
  getModel: () => fakeModel,
  getValue: () => 'Module demo.\n',
  onDidChangeModelContent: () => ({ dispose: vi.fn() }),
  onDidChangeCursorPosition: () => ({ dispose: vi.fn() }),
  addCommand: vi.fn(),
  addAction: vi.fn(),
  getPosition: () => ({ lineNumber: 1, column: 1 }),
  getSelection: () => null,
  deltaDecorations: () => [],
  createDecorationsCollection: () => ({ set: vi.fn(), clear: vi.fn() }),
  updateOptions: vi.fn(),
  layout: vi.fn(),
};

// @monaco-editor/react 的 Editor：挂载时同步回调 onMount，把探针交给组件
vi.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: ({ onMount }: { onMount?: (e: unknown, m: unknown) => void }) => {
    onMount?.(fakeEditor, fakeMonaco);
    return null;
  },
}));

// ── useAsterLSP 探针：捕获组件传下去的入参 ────────────────────────────
const lspCalls: Array<Record<string, unknown>> = [];
vi.mock('@/hooks/useAsterLSP', () => ({
  useAsterLSP: (opts: Record<string, unknown>) => {
    lspCalls.push(opts);
    return { connected: false, connecting: false, error: null,
      connect: vi.fn(), disconnect: vi.fn(), reconnect: vi.fn() };
  },
}));

// 编译器不参与本文件的断言，桩掉以免拉起真实 wasm/worker
vi.mock('@/hooks/useAsterCompiler', () => ({
  useAsterCompiler: () => ({ diagnostics: [], compileResult: null }),
}));

const TENANT = 'tenant-under-test';
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: TENANT } }, status: 'authenticated' }),
}));

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));

/* 领域词汇：本文件不断言词汇内容，故返回 undefined 让组件回落到内置词汇。
 * ★不自造形状——DomainVocabulary 有 structs 等被真实代码迭代的字段，
 *   随手编一个 `{terms: []}` 会以 "structs is not iterable" 炸在无关的地方。 */
vi.mock('@/hooks/useUserVocabularyRegistration', () => ({
  useUserVocabularyRegistration: () => ({ vocabulary: undefined, domain: undefined, registrationKey: '' }),
}));
vi.mock('@/hooks/useDomainVocabularyInvalidate', () => ({
  useDomainVocabularyInvalidate: () => 0,
}));
vi.mock('@/hooks/useAsterModuleCatalog', () => ({
  useAsterModuleCatalog: () => ({ modules: [], error: null }),
}));
vi.mock('@/components/policy/use-entry-rule-decorations', () => ({
  useEntryRuleDecorations: () => undefined,
}));

import { MonacoPolicyEditor } from '@/components/policy/monaco-policy-editor';

const token = () => ({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) });
const position = { lineNumber: 2, column: 4 };

function provider(): InlineProvider {
  const p = inlineProviders.at(-1);
  if (!p) throw new Error('inline provider 未注册');
  return p;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  inlineProviders.length = 0;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ completion: '包含' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const llmCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/llm/complete'));

describe('AI 行内补全开关：调用点', () => {
  it('★开关关闭时不发任何 /api/llm/complete 请求', async () => {
    render(<MonacoPolicyEditor value="" onChange={() => {}} locale="zh" enableAICompletion={false} />);
    await waitFor(() => expect(inlineProviders.length).toBeGreaterThan(0));
    const res = await provider().provideInlineCompletions(fakeModel, position, {}, token());
    await vi.advanceTimersByTimeAsync(1000);
    expect(res.items).toEqual([]);
    expect(llmCalls()).toHaveLength(0);
  });

  it('★开关开启时停顿 500ms 后请求并返回建议', async () => {
    render(<MonacoPolicyEditor value="" onChange={() => {}} locale="zh" enableAICompletion />);
    await waitFor(() => expect(inlineProviders.length).toBeGreaterThan(0));
    const pending = provider().provideInlineCompletions(fakeModel, position, {}, token());
    await vi.advanceTimersByTimeAsync(600);
    const res = await pending;
    expect(llmCalls()).toHaveLength(1);
    expect(res.items[0]?.insertText).toBe('包含');
  });

  it('★编辑中途关闭：同一个已注册的 provider 立刻停止请求（读挂载时 prop 则变红）', async () => {
    const { rerender } = render(<MonacoPolicyEditor value="" onChange={() => {}} locale="zh" enableAICompletion />);
    await waitFor(() => expect(inlineProviders.length).toBeGreaterThan(0));
    const registered = provider();
    rerender(<MonacoPolicyEditor value="" onChange={() => {}} locale="zh" enableAICompletion={false} />);
    const res = await registered.provideInlineCompletions(fakeModel, position, {}, token());
    await vi.advanceTimersByTimeAsync(1000);
    expect(res.items).toEqual([]);
    expect(llmCalls()).toHaveLength(0);
  });

  it('★编辑中途打开：挂载时关闭的编辑器也能开始请求（按挂载时 prop 决定是否注册则变红）', async () => {
    const { rerender } = render(<MonacoPolicyEditor value="" onChange={() => {}} locale="zh" enableAICompletion={false} />);
    await waitFor(() => expect(inlineProviders.length).toBeGreaterThan(0));
    const registered = provider();
    rerender(<MonacoPolicyEditor value="" onChange={() => {}} locale="zh" enableAICompletion />);
    const pending = registered.provideInlineCompletions(fakeModel, position, {}, token());
    await vi.advanceTimersByTimeAsync(600);
    await pending;
    expect(llmCalls()).toHaveLength(1);
  });

  it('★已排队的请求在关闭开关后不再发出，且以空结果结束', async () => {
    const { rerender } = render(<MonacoPolicyEditor value="" onChange={() => {}} locale="zh" enableAICompletion />);
    await waitFor(() => expect(inlineProviders.length).toBeGreaterThan(0));
    const pending = provider().provideInlineCompletions(fakeModel, position, {}, token());
    rerender(<MonacoPolicyEditor value="" onChange={() => {}} locale="zh" enableAICompletion={false} />);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({ items: [] });
    expect(llmCalls()).toHaveLength(0);
  });

  it('★连续输入时被取消的那次请求以空结果结束（不再留下永不结束的 Promise）', async () => {
    render(<MonacoPolicyEditor value="" onChange={() => {}} locale="zh" enableAICompletion />);
    await waitFor(() => expect(inlineProviders.length).toBeGreaterThan(0));
    const first = provider().provideInlineCompletions(fakeModel, position, {}, token());
    let firstSettled = false;
    void Promise.resolve(first).then(() => { firstSettled = true; });
    const second = provider().provideInlineCompletions(fakeModel, position, {}, token());
    await vi.advanceTimersByTimeAsync(0);
    expect(firstSettled).toBe(true);
    await expect(first).resolves.toEqual({ items: [] });
    await vi.advanceTimersByTimeAsync(600);
    await second;
    expect(llmCalls()).toHaveLength(1);
  });

  it('★关闭开关时排队中的请求立即结束（不等定时器触发）', async () => {
    const { rerender } = render(<MonacoPolicyEditor value="" onChange={() => {}} locale="zh" enableAICompletion />);
    await waitFor(() => expect(inlineProviders.length).toBeGreaterThan(0));
    const pending = provider().provideInlineCompletions(fakeModel, position, {}, token());
    let settled = false;
    void Promise.resolve(pending).then(() => { settled = true; });
    rerender(<MonacoPolicyEditor value="" onChange={() => {}} locale="zh" enableAICompletion={false} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(llmCalls()).toHaveLength(0);
  });

  it('★请求已发出后关闭开关：中止该请求并丢弃结果', async () => {
    let signal: AbortSignal | undefined;
    let respond: (r: Response) => void = () => {};
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((res) => { respond = res; });
    });
    const { rerender } = render(<MonacoPolicyEditor value="" onChange={() => {}} locale="zh" enableAICompletion />);
    await waitFor(() => expect(inlineProviders.length).toBeGreaterThan(0));
    const pending = provider().provideInlineCompletions(fakeModel, position, {}, token());
    await vi.advanceTimersByTimeAsync(600);
    expect(llmCalls()).toHaveLength(1);
    rerender(<MonacoPolicyEditor value="" onChange={() => {}} locale="zh" enableAICompletion={false} />);
    expect(signal?.aborted).toBe(true);
    respond(new Response(JSON.stringify({ completion: 'GHOST' }), { status: 200 }));
    await expect(pending).resolves.toEqual({ items: [] });
  });

  it('卸载时排队中的请求以空结果结束且不发请求', async () => {
    const view = render(<MonacoPolicyEditor value="" onChange={() => {}} locale="zh" enableAICompletion />);
    await waitFor(() => expect(inlineProviders.length).toBeGreaterThan(0));
    const pending = provider().provideInlineCompletions(fakeModel, position, {}, token());
    view.unmount();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({ items: [] });
    expect(llmCalls()).toHaveLength(0);
  });

  it('只读编辑器不注册 inline provider', async () => {
    render(<MonacoPolicyEditor value="" onChange={() => {}} locale="zh" readOnly enableAICompletion />);
    await vi.advanceTimersByTimeAsync(50);
    expect(inlineProviders).toHaveLength(0);
  });
});
