import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

/**
 * 编辑器**接线层**的测试 —— 守的是「组件真的把对的东西传下去了」。
 *
 * ★为什么必须有这一组：纯函数（collectKeywordLabels / buildKeywordSuggestions /
 *   buildLspInitOptions）本身测得很充分，但**那证明不了调用方用了它们**。
 *
 *   交叉审查实测：把组件里的取词换成 `baseLexicon`、把补全结果 `.slice(0,0)`、
 *   把 LSP 的 tenantId 传 `undefined`、把 lspEnabled 恒设 true ——
 *   **五处语义破坏，5967 条测试全绿、tsc 与 eslint 均干净**。
 *
 *   这与 aster-lang-ts#162（第16种假绿）是同一个坑：
 *   「抽了纯函数、测了纯函数，却没测调用点」。
 *   本文件把 Monaco 与 useAsterLSP 换成探针，直接断言调用点。
 */

// ── Monaco 探针：捕获注册的补全 provider ──────────────────────────────
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
    registerInlineCompletionsProvider: vi.fn(() => ({ dispose: vi.fn() })),
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
  getValueInRange: () => '',
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
  useUserVocabularyRegistration: () => ({ vocabulary: undefined, epoch: 1 }),
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

/** 取出补全 provider 并在「非 Use 行」位置求值。 */
async function completionsAt(line = 'Mod') {
  const p = registeredProviders.at(-1);
  if (!p) throw new Error('补全 provider 未注册——onMount 未被调用？');
  const model = { ...fakeModel, getLineContent: () => line, getValue: () => line };
  const res = (await p.provider.provideCompletionItems(
    model,
    { lineNumber: 1, column: line.length + 1 },
    {},
    {},
  )) as { suggestions: Array<{ label: string; kind: number; insertText: string }> };
  return res?.suggestions ?? [];
}

beforeEach(() => {
  registeredProviders.length = 0;
  lspCalls.length = 0;
});

describe('编辑器接线：关键词补全', () => {
  it('★非 Use 行返回非空补全（恒空 = PR 价值归零）', async () => {
    render(<MonacoPolicyEditor value="" onChange={() => {}} locale="zh" />);
    await waitFor(() => expect(registeredProviders.length).toBeGreaterThan(0));
    const s = await completionsAt('模');
    expect(s.length).toBeGreaterThan(50);
  });

  it('★取的是当前 locale 的词（zh 不得给英文）', async () => {
    render(<MonacoPolicyEditor value="" onChange={() => {}} locale="zh" />);
    await waitFor(() => expect(registeredProviders.length).toBeGreaterThan(0));
    const labels = (await completionsAt('模')).map((x) => x.label);
    expect(labels).toContain('模块');
    expect(labels.filter((w) => /^[A-Za-z][A-Za-z ]*$/.test(w))).toEqual([]);
  });

  /* ★这条专杀「用 baseLexicon 而非含别名的 effective lexicon」：
   *   别名是用户策略层配置，取错来源时它静默消失，而其余断言都还是绿的。 */
  it('★用户别名进入补全（错用 baseLexicon 时此条变红）', async () => {
    render(
      <MonacoPolicyEditor
        value=""
        onChange={() => {}}
        locale="zh"
        aliasSet={{ MODULE_IS: ['模組'] }}
      />,
    );
    await waitFor(() => expect(registeredProviders.length).toBeGreaterThan(0));
    expect((await completionsAt('模')).map((x) => x.label)).toContain('模組');
  });
});

describe('编辑器接线：LSP 参数下发', () => {
  it('★tenantId 与领域词汇成对下发（回到 #162 缺陷时变红）', async () => {
    process.env.NEXT_PUBLIC_LSP_HOST = 'lsp.example.test';
    render(<MonacoPolicyEditor value="" onChange={() => {}} locale="zh" domain="insurance.auto" />);
    await waitFor(() => expect(lspCalls.length).toBeGreaterThan(0));
    expect(lspCalls.at(-1)!.tenantId).toBe(TENANT);
    delete process.env.NEXT_PUBLIC_LSP_HOST;
  });

  /* ★诊断必须丢弃：Monaco marker 按 owner 分桶，本 hook 写 'aster-lsp'、
   *   useAsterCompiler 写 'aster-compiler'——owner 不同**保证两套同时渲染**，
   *   用户会看到每个错误两条红波浪线。这条防止有人"顺手"去掉该开关。 */
  it('★必须丢弃 LSP 诊断（否则红波浪线双份）', async () => {
    process.env.NEXT_PUBLIC_LSP_HOST = 'lsp.example.test';
    render(<MonacoPolicyEditor value="" onChange={() => {}} locale="zh" />);
    await waitFor(() => expect(lspCalls.length).toBeGreaterThan(0));
    expect(lspCalls.at(-1)!.suppressDiagnostics).toBe(true);
    delete process.env.NEXT_PUBLIC_LSP_HOST;
  });

  /* ★lspEnabled 恒 true 会让生产站（Cloudflare Workers，无 /api/lsp 路由）
   *   陷入 reconnect 风暴；readOnly 视图也不该连。 */
  it('★未配 LSP_HOST 时不自动连接', async () => {
    delete process.env.NEXT_PUBLIC_LSP_HOST;
    render(<MonacoPolicyEditor value="" onChange={() => {}} locale="zh" />);
    await waitFor(() => expect(lspCalls.length).toBeGreaterThan(0));
    expect(lspCalls.at(-1)!.autoConnect).toBe(false);
  });

  it('★readOnly 视图不连接 LSP', async () => {
    process.env.NEXT_PUBLIC_LSP_HOST = 'lsp.example.test';
    render(<MonacoPolicyEditor value="" onChange={() => {}} locale="zh" readOnly />);
    await waitFor(() => expect(lspCalls.length).toBeGreaterThan(0));
    expect(lspCalls.at(-1)!.autoConnect).toBe(false);
    delete process.env.NEXT_PUBLIC_LSP_HOST;
  });
});
