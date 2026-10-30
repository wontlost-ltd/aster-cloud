/**
 * useAsterLSP 协议行为：用假 WebSocket + 假 Monaco 驱动真实 hook。
 *
 * ★锁两个生产缺陷：
 *   1. provider 必须注册在调用方传入的 Monaco 实例上（编辑器那一份），
 *      而不是 hook 自行 import 的第二份——否则编辑器永远不调用它们。
 *   2. 服务端→客户端的请求（如 client/registerCapability）必须得到应答。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAsterLSP } from '@/hooks/useAsterLSP';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Sent = { jsonrpc: string; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };

const NEW_SERVER_CAPS = {
  hoverProvider: true, definitionProvider: true, referencesProvider: true, documentSymbolProvider: true,
  signatureHelpProvider: {}, codeActionProvider: {}, renameProvider: { prepareProvider: true },
  documentFormattingProvider: true, documentHighlightProvider: true,
  completionProvider: { resolveProvider: true, triggerCharacters: [' ', '.', ':'] },
  experimental: { aster: { localizedParsing: true, openDocumentNavigation: true } },
};
/** 生产 1.0.32 的能力：无 experimental 标志 */
const OLD_SERVER_CAPS = { ...NEW_SERVER_CAPS, experimental: undefined };

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  static serverCaps: Record<string, unknown> = NEW_SERVER_CAPS;
  static hoverFails = false;
  static prepareRename: 'null' | 'error' = 'null';
  static completion: unknown = null;
  readyState = 0;
  sent: Sent[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(data: string) {
    const msg = JSON.parse(data) as Sent;
    this.sent.push(msg);
    // 服务端模拟：initialize 应答后紧接着发一个 registerCapability 请求
    if (msg.method === 'initialize') {
      this.serverSend({ jsonrpc: '2.0', id: msg.id, result: { capabilities: FakeWebSocket.serverCaps } });
    }
    if (msg.method === 'initialized') {
      this.serverSend({ jsonrpc: '2.0', id: 'srv-1', method: 'client/registerCapability', params: { registrations: [] } });
    }
    if (msg.method === 'textDocument/hover') {
      this.serverSend(FakeWebSocket.hoverFails
        ? { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'boom' } }
        : { jsonrpc: '2.0', id: msg.id, result: { contents: { kind: 'markdown', value: '**规则** twice' } } });
    }
    if (msg.method === 'textDocument/prepareRename') {
      this.serverSend(FakeWebSocket.prepareRename === 'error'
        ? { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'boom' } }
        : { jsonrpc: '2.0', id: msg.id, result: null });
    }
    if (msg.method === 'textDocument/completion' && FakeWebSocket.completion !== 'hang') {
      this.serverSend({ jsonrpc: '2.0', id: msg.id, result: FakeWebSocket.completion });
    }
    if (msg.method === 'textDocument/codeAction') {
      this.serverSend({ jsonrpc: '2.0', id: msg.id, result: [] });
    }
  }
  serverSend(m: unknown) { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(m) })); }
  close() { this.readyState = 3; }
}

function makeFakeMonaco() {
  const providers: Record<string, {
    provideHover?: (...a: unknown[]) => unknown; provideCodeActions?: (...a: unknown[]) => unknown;
    resolveRenameLocation?: (...a: unknown[]) => unknown; provideCompletionItems?: (...a: unknown[]) => unknown;
    triggerCharacters?: string[];
  }> = {};
  const reg = (kind: string) => vi.fn((_lang: string, p: unknown) => { providers[kind] = p as never; return { dispose: vi.fn() }; });
  return {
    providers,
    languages: {
      registerHoverProvider: reg('hover'),
      registerDefinitionProvider: reg('definition'),
      registerReferenceProvider: reg('references'),
      registerDocumentSymbolProvider: reg('symbols'),
      registerSignatureHelpProvider: reg('signature'),
      registerCodeActionProvider: reg('codeAction'),
      registerRenameProvider: reg('rename'),
      registerDocumentFormattingEditProvider: reg('formatting'),
      registerDocumentHighlightProvider: reg('highlight'),
      registerCompletionItemProvider: reg('completion'),
      DocumentHighlightKind: { Text: 0 },
      CompletionItemKind: { Field: 3, Value: 13, EnumMember: 16, Property: 9, Text: 18 },
      CompletionTriggerKind: { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 },
      SymbolKind: {},
    },
    editor: { setModelMarkers: vi.fn() },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    Uri: { parse: (s: string) => ({ toString: () => s }) },
  };
}

// 模型 URI 与 documentUri prop 故意不同：@monaco-editor/react 未传 path 时模型 URI 就是 inmemory://model/N
const MODEL_URI = 'inmemory://model/1';
const contentListeners: Array<() => void> = [];
const fakeModel = {
  uri: { toString: () => MODEL_URI },
  getValue: () => '模块 demo.p。',
  getVersionId: () => 1,
  onDidChangeContent: (fn: () => void) => { contentListeners.push(fn); return { dispose: vi.fn() }; },
  getWordAtPosition: () => ({ word: 'the', startColumn: 7, endColumn: 10 }),
  getWordUntilPosition: () => ({ word: '', startColumn: 20, endColumn: 20 }),
};
const otherModel = { ...fakeModel, uri: { toString: () => 'inmemory://model/2' } };
const fakeEditor = { getModel: () => fakeModel };

describe('useAsterLSP 协议', () => {
  beforeEach(() => {
    contentListeners.length = 0;
    FakeWebSocket.instances = [];
    FakeWebSocket.serverCaps = NEW_SERVER_CAPS;
    FakeWebSocket.hoverFails = false;
    FakeWebSocket.prepareRename = 'null';
    FakeWebSocket.completion = null;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    process.env.NEXT_PUBLIC_LSP_HOST = 'lsp.example.test';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NEXT_PUBLIC_LSP_HOST;
  });

  it('★provider 注册在传入的 monaco 实例上，hover 真的发出 textDocument/hover', async () => {
    const monaco = makeFakeMonaco();
    renderHook(() => useAsterLSP({
      editor: fakeEditor as never,
      monaco: monaco as never,
      documentUri: 'inmemory://policy/default.aster',
      locale: 'zh-CN',
    }));
    await waitFor(() => expect(monaco.languages.registerHoverProvider).toHaveBeenCalled());
    const ws = FakeWebSocket.instances[0];
    const hover = await monaco.providers.hover.provideHover!(fakeModel, { lineNumber: 1, column: 2 }) as { contents: Array<{ value: string }> };
    expect(ws.sent.some((m) => m.method === 'textDocument/hover')).toBe(true);
    expect(hover.contents[0].value).toContain('twice');
  });

  it('★回复服务端的 client/registerCapability 请求', async () => {
    const monaco = makeFakeMonaco();
    renderHook(() => useAsterLSP({
      editor: fakeEditor as never,
      monaco: monaco as never,
      documentUri: 'inmemory://policy/default.aster',
      locale: 'zh-CN',
    }));
    await waitFor(() => {
      const ws = FakeWebSocket.instances[0];
      expect(ws?.sent.find((m) => m.id === 'srv-1')).toEqual({ jsonrpc: '2.0', id: 'srv-1', result: null });
    });
  });

  /* ★服务端只从 settings 读 locale（server.js onDidChangeConfiguration → s.locale），
   *   ASTER_LOCALE 环境变量与 initializationOptions.locale 都不生效。客户端未声明
   *   workspace.configuration，服务端就用 didChangeConfiguration 推来的 settings。
   *   不推 → 服务端按英文解析 zh/de 文档，hover/跳转报「Unexpected character '模'」。 */
  it('★initialized 之后、didOpen 之前推送 locale 设置', async () => {
    const monaco = makeFakeMonaco();
    renderHook(() => useAsterLSP({
      editor: fakeEditor as never,
      monaco: monaco as never,
      documentUri: 'inmemory://policy/default.aster',
      locale: 'zh-CN',
    }));
    await waitFor(() => expect(FakeWebSocket.instances[0]?.sent.some((m) => m.method === 'textDocument/didOpen')).toBe(true));
    const methods = FakeWebSocket.instances[0].sent.map((m) => m.method);
    const cfg = FakeWebSocket.instances[0].sent.find((m) => m.method === 'workspace/didChangeConfiguration');
    // ★完整设置：1.0.32 对推送的设置整体替换，只推 locale 会丢掉 format.reflow 等默认值
    const pushed = (cfg?.params as { settings: { asterLanguageServer: Record<string, unknown> } }).settings.asterLanguageServer;
    expect(pushed.locale).toBe('zh-CN');
    expect(pushed.format).toEqual({ mode: 'lossless', reflow: true });
    expect(pushed.index).toEqual({ persist: false });
    expect(methods.indexOf('workspace/didChangeConfiguration')).toBeGreaterThan(methods.indexOf('initialized'));
    expect(methods.indexOf('workspace/didChangeConfiguration')).toBeLessThan(methods.indexOf('textDocument/didOpen'));
  });

  /* ★生产配置（2026-10-30 复测 A4）：host 取自已提交的 .env.production，token 由构建期内联。
   *   两者齐备时必须真的向 wss://<host>/lsp 发起握手，并带上 locale 与 token。 */
  it('★生产配置（.env.production 的 host + 构建期 token）发起 wss 握手', async () => {
    const envProduction = readFileSync(join(__dirname, '..', '..', '..', '.env.production'), 'utf-8');
    const host = /^NEXT_PUBLIC_LSP_HOST=(.+)$/m.exec(envProduction)?.[1]?.trim();
    expect(host).toBe('lsp.aster-lang.dev');
    process.env.NEXT_PUBLIC_LSP_HOST = host;
    process.env.NEXT_PUBLIC_LSP_TOKEN = 'tok/+=';
    try {
      const monaco = makeFakeMonaco();
      renderHook(() => useAsterLSP({
        editor: fakeEditor as never,
        monaco: monaco as never,
        documentUri: 'inmemory://policy/default.aster',
        locale: 'de-DE',
      }));
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      expect(FakeWebSocket.instances[0].url).toBe('wss://lsp.aster-lang.dev/lsp?locale=de-DE&token=tok%2F%2B%3D');
    } finally {
      delete process.env.NEXT_PUBLIC_LSP_TOKEN;
    }
  });

  it('未传 monaco 时不连接（不自行加载第二份 Monaco）', async () => {
    renderHook(() => useAsterLSP({
      editor: fakeEditor as never,
      monaco: null,
      documentUri: 'inmemory://policy/default.aster',
      locale: 'zh-CN',
    }));
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  const mount = (locale: 'zh-CN' | 'en-US' | 'de-DE' = 'zh-CN', extra: Record<string, unknown> = {}) => {
    const monaco = makeFakeMonaco();
    renderHook(() => useAsterLSP({
      editor: fakeEditor as never,
      monaco: monaco as never,
      documentUri: 'inmemory://policy/default.aster',
      locale,
      ...extra,
    }));
    return monaco;
  };
  const opened = () => waitFor(() => expect(FakeWebSocket.instances[0]?.sent.some((m) => m.method === 'textDocument/didOpen')).toBe(true));

  /* ★C9：补全归本地 provider（按 locale 与别名给词）。LSP 补全只有关键字 + 英文类型名，
   *   注册了就会重复/给 zh 用户错词——hook 绝不能注册补全。 */
  /* 第 4 轮生产复测：服务端声明了 completionProvider，编辑器却从不发 textDocument/completion，
   *   `x.` 后只有本地关键字。现在注册 LSP 补全，但只取上下文相关的结果（字段 / 控制点键等），
   *   通用的关键字与英文类型名仍归本地 provider（按 locale 与别名给词），避免重复与错词。 */
  it('★注册 LSP 补全 provider，触发字符为 "."', async () => {
    const monaco = mount();
    await opened();
    await waitFor(() => expect(monaco.languages.registerCompletionItemProvider).toHaveBeenCalled());
    expect(monaco.providers.completion.triggerCharacters).toEqual(['.']);
  });

  /** 只有一行文本的模型：getWordUntilPosition 按 Monaco 规则取光标前的单词（字母数字下划线） */
  const lineModel = (text: string) => ({
    ...fakeModel,
    getLineContent: () => text,
    getLineMaxColumn: () => text.length + 1,
    getWordUntilPosition: (pos: { column: number }) => {
      const before = text.slice(0, pos.column - 1);
      const word = /[\p{L}\p{N}_]*$/u.exec(before)![0];
      return { word, startColumn: pos.column - word.length, endColumn: pos.column };
    },
  });
  type Suggestions = { suggestions: Array<{ label: string; kind: number; detail?: string; insertText: string; range: unknown }>; incomplete?: boolean } | null;
  const complete = async (monaco: ReturnType<typeof mount>, text: string, column: number, context: Record<string, unknown>) =>
    await monaco.providers.completion.provideCompletionItems!(lineModel(text), { lineNumber: 3, column }, context, { isCancellationRequested: false }) as Suggestions;
  const completionRequests = () => FakeWebSocket.instances[0].sent.filter((m) => m.method === 'textDocument/completion');

  it('★`x.前缀` 处发出 textDocument/completion，并只渲染所属 struct 的字段', async () => {
    FakeWebSocket.completion = [
      { label: 'alter', kind: 5, detail: 'age' },
      { label: 'stufe', kind: 5, detail: 'level' },
    ];
    const monaco = mount('en-US');
    await opened();
    await waitFor(() => expect(monaco.providers.completion).toBeDefined());
    const text = '  gib zurueck fahrer.st';
    const res = await complete(monaco, text, text.length + 1, { triggerKind: 0 });
    expect(completionRequests()[0]?.params).toMatchObject({ position: { line: 2, character: text.length }, context: { triggerKind: 1 } });
    expect(res!.suggestions.map((x) => [x.label, x.kind, x.detail, x.insertText])).toEqual([
      ['alter', 3, 'age', 'alter'],
      ['stufe', 3, 'level', 'stufe'],
    ]);
  });

  it('`x.` 后面还有内容（行中间）时，"." 触发即发请求', async () => {
    FakeWebSocket.completion = [{ label: 'alter', kind: 5 }];
    const monaco = mount('en-US');
    await opened();
    await waitFor(() => expect(monaco.providers.completion).toBeDefined());
    const res = await complete(monaco, '  Return fahrer. plus 1.', 17, { triggerKind: 1, triggerCharacter: '.' });
    expect(completionRequests()[0]?.params).toMatchObject({ context: { triggerKind: 2, triggerCharacter: '.' } });
    expect(res!.suggestions.map((x) => x.label)).toEqual(['alter']);
  });

  /* 审查 M4：en / de 的句末 "." 不是成员访问——`Return applicant.` 后回车必须换行，不能接受字段补全 */
  it('★行尾刚输入 "."（可能是句末）：不发请求、不给建议，标记 incomplete 以便继续输入时再查', async () => {
    FakeWebSocket.completion = [{ label: 'age', kind: 5 }];
    const monaco = mount('en-US');
    await opened();
    await waitFor(() => expect(monaco.providers.completion).toBeDefined());
    const text = '  Return applicant.';
    const res = await complete(monaco, text, text.length + 1, { triggerKind: 1, triggerCharacter: '.' });
    expect(res).toEqual({ suggestions: [], incomplete: true });
    expect(completionRequests()).toHaveLength(0);
  });

  /* 复审 N1：句末拦截只针对句末是 "." 的语言（en-US / de-DE）且仅限 "." 自动触发；
   *   zh-CN 句末是 "。"，行尾 `x.` 一定是成员访问；手动 Ctrl+Space（Invoke）在任何语言下都照常请求。 */
  it('★zh-CN 行尾 `返回 x.`（"." 触发）照常请求并弹出字段', async () => {
    FakeWebSocket.completion = [{ label: '年龄', kind: 5, detail: 'age' }];
    const monaco = mount('zh-CN');
    await opened();
    await waitFor(() => expect(monaco.providers.completion).toBeDefined());
    const text = '  返回 驾驶员.';
    const res = await complete(monaco, text, text.length + 1, { triggerKind: 1, triggerCharacter: '.' });
    expect(completionRequests()).toHaveLength(1);
    expect(res!.suggestions.map((x) => x.label)).toEqual(['年龄']);
  });

  it('★en-US 行尾 `x.` 手动 Ctrl+Space（Invoke）照常请求并弹出字段', async () => {
    FakeWebSocket.completion = [{ label: 'age', kind: 5 }];
    const monaco = mount('en-US');
    await opened();
    await waitFor(() => expect(monaco.providers.completion).toBeDefined());
    const text = '  Return applicant.';
    const res = await complete(monaco, text, text.length + 1, { triggerKind: 0 });
    expect(completionRequests()).toHaveLength(1);
    expect(res!.suggestions.map((x) => x.label)).toEqual(['age']);
  });

  it('de-DE 行尾 `x.`（"." 触发）同样按句末处理：不发请求', async () => {
    const monaco = mount('de-DE');
    await opened();
    await waitFor(() => expect(monaco.providers.completion).toBeDefined());
    const text = '  gib zurueck fahrer.';
    const res = await complete(monaco, text, text.length + 1, { triggerKind: 1, triggerCharacter: '.' });
    expect(res).toEqual({ suggestions: [], incomplete: true });
    expect(completionRequests()).toHaveLength(0);
  });

  /* 审查 M1：只在上下文补全可能有结果的位置发请求；其余位置立即返回，不拖慢本地关键字补全 */
  it('★非成员访问、非字符串位置：不发请求，立即返回', async () => {
    const monaco = mount('en-US');
    await opened();
    await waitFor(() => expect(monaco.providers.completion).toBeDefined());
    const res = await complete(monaco, '  Return ab', 12, { triggerKind: 0 });
    expect(res).toBeNull();
    expect(completionRequests()).toHaveLength(0);
  });

  it('★服务端不应答：800ms 后返回空，清掉挂起请求并发 $/cancelRequest（可控时钟）', async () => {
    FakeWebSocket.completion = 'hang';
    const monaco = mount('en-US');
    await opened();
    await waitFor(() => expect(monaco.providers.completion).toBeDefined());
    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = complete(monaco, '  Return fahrer.a', 18, { triggerKind: 0 }).then((r) => { settled = true; return r; });
      await vi.advanceTimersByTimeAsync(799);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBeNull();
      const id = completionRequests()[0]!.id;
      expect(FakeWebSocket.instances[0].sent.find((m) => m.method === '$/cancelRequest')?.params).toEqual({ id });
    } finally {
      vi.useRealTimers();
    }
  });

  /* 审查 M2：服务端用 textEdit 指定替换范围（如 @control("GDPR: 覆盖引号后到光标），客户端不得按单词边界替换 */
  it('★使用服务端 textEdit 的范围与 newText：@control("GDPR: 不会插入重复前缀', async () => {
    const text = '@control("GDPR:';
    FakeWebSocket.completion = [{
      label: 'GDPR:ART22', kind: 12,
      textEdit: { range: { start: { line: 2, character: 10 }, end: { line: 2, character: text.length } }, newText: 'GDPR:ART22' },
    }];
    const monaco = mount('en-US');
    await opened();
    await waitFor(() => expect(monaco.providers.completion).toBeDefined());
    const res = await complete(monaco, text, text.length + 1, { triggerKind: 0 });
    expect(completionRequests()).toHaveLength(1);
    expect(res!.suggestions[0]).toMatchObject({
      insertText: 'GDPR:ART22',
      range: { startLineNumber: 3, startColumn: 11, endLineNumber: 3, endColumn: text.length + 1 },
    });
  });

  it('InsertReplaceEdit：插入用 insert 范围、替换用 replace 范围', async () => {
    const text = '  Return fahrer.al';
    FakeWebSocket.completion = [{
      label: 'alter', kind: 5,
      textEdit: {
        newText: 'alter',
        insert: { start: { line: 2, character: 16 }, end: { line: 2, character: 18 } },
        replace: { start: { line: 2, character: 16 }, end: { line: 2, character: 20 } },
      },
    }];
    const monaco = mount('en-US');
    await opened();
    await waitFor(() => expect(monaco.providers.completion).toBeDefined());
    const res = await complete(monaco, text, text.length + 1, { triggerKind: 0 });
    expect(res!.suggestions[0]!.range).toEqual({
      insert: { startLineNumber: 3, startColumn: 17, endLineNumber: 3, endColumn: 19 },
      replace: { startLineNumber: 3, startColumn: 17, endLineNumber: 3, endColumn: 21 },
    });
  });

  it('通用结果（关键字 / 类型名）被丢弃，交给本地 provider', async () => {
    FakeWebSocket.completion = { isIncomplete: false, items: [
      { label: 'Return', kind: 14 }, { label: 'Int', kind: 7 }, { label: 'EU_AI_ACT:ART14', kind: 12 },
    ] };
    const monaco = mount('en-US');
    await opened();
    await waitFor(() => expect(monaco.providers.completion).toBeDefined());
    const res = await complete(monaco, '@control("EU', 13, { triggerKind: 0 });
    expect(res!.suggestions.map((x) => x.label)).toEqual(['EU_AI_ACT:ART14']);
  });

  it('服务端未声明 completionProvider 时不注册', async () => {
    FakeWebSocket.serverCaps = { ...NEW_SERVER_CAPS, completionProvider: undefined };
    const monaco = mount();
    await opened();
    await waitFor(() => expect(monaco.languages.registerHoverProvider).toHaveBeenCalled());
    expect(monaco.languages.registerCompletionItemProvider).not.toHaveBeenCalled();
  });

  it('★didOpen 用编辑器模型的真实 URI（而不是 documentUri prop）', async () => {
    mount();
    await opened();
    const open = FakeWebSocket.instances[0].sent.find((m) => m.method === 'textDocument/didOpen');
    expect((open?.params as { textDocument: { uri: string } }).textDocument.uri).toBe(MODEL_URI);
  });

  it('★旧服务端 + zh：基于解析的 provider 一个都不注册', async () => {
    FakeWebSocket.serverCaps = OLD_SERVER_CAPS;
    const monaco = mount('zh-CN');
    await opened();
    await new Promise((r) => setTimeout(r, 20));
    for (const fn of Object.values(monaco.languages).filter((v) => typeof v === 'function')) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('★旧服务端 + en：有 hover，没有重命名 / 引用（实测一个恒空、一个报错）', async () => {
    FakeWebSocket.serverCaps = OLD_SERVER_CAPS;
    const monaco = mount('en-US');
    await waitFor(() => expect(monaco.languages.registerHoverProvider).toHaveBeenCalled());
    expect(monaco.languages.registerRenameProvider).not.toHaveBeenCalled();
    expect(monaco.languages.registerReferenceProvider).not.toHaveBeenCalled();
  });

  it('★非 LSP 文档的模型（如 AI diff 预览）不发请求、返回空', async () => {
    const monaco = mount();
    await waitFor(() => expect(monaco.languages.registerHoverProvider).toHaveBeenCalled());
    const before = FakeWebSocket.instances[0].sent.length;
    expect(await monaco.providers.hover.provideHover!(otherModel, { lineNumber: 1, column: 1 })).toBeNull();
    expect(FakeWebSocket.instances[0].sent.length).toBe(before);
  });

  it('★代码操作把诊断 code 原样带给服务端', async () => {
    const monaco = mount();
    await waitFor(() => expect(monaco.languages.registerCodeActionProvider).toHaveBeenCalled());
    await monaco.providers.codeAction.provideCodeActions!(fakeModel, { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, {
      markers: [{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1, message: '缺少模块头', severity: 4, code: 'missing-module-header' }],
    });
    const req = FakeWebSocket.instances[0].sent.find((m) => m.method === 'textDocument/codeAction');
    const diag = (req?.params as { context: { diagnostics: Array<{ code?: string }> } }).context.diagnostics[0];
    expect(diag.code).toBe('missing-module-header');
  });

  it('★同一功能的失败只告警一次（provider 随按键频繁触发）', async () => {
    FakeWebSocket.hoverFails = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const monaco = mount('zh-CN', { suppressErrors: false });
    await waitFor(() => expect(monaco.languages.registerHoverProvider).toHaveBeenCalled());
    for (let i = 0; i < 5; i++) await monaco.providers.hover.provideHover!(fakeModel, { lineNumber: 1, column: 1 });
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('Hover'))).toHaveLength(1);
    expect(err.mock.calls.filter((c) => String(c[0]).includes('Hover'))).toHaveLength(0);
    warn.mockRestore(); err.mockRestore();
  });

  /* ★N12：didChange 也必须用模型 URI。若只改了 didOpen，服务端会把编辑当成另一份文档，
   *   之后的跳转/重命名都基于打开时的旧内容。 */
  it('★didChange 用编辑器模型的真实 URI', async () => {
    mount();
    await opened();
    await waitFor(() => expect(contentListeners.length).toBeGreaterThan(0));
    contentListeners.forEach((fn) => fn());
    await waitFor(() => expect(FakeWebSocket.instances[0].sent.some((m) => m.method === 'textDocument/didChange')).toBe(true));
    const change = FakeWebSocket.instances[0].sent.find((m) => m.method === 'textDocument/didChange');
    expect((change?.params as { textDocument: { uri: string } }).textDocument.uri).toBe(MODEL_URI);
  });

  /* ★服务端 prepareRename 回 null 表示「这里不能重命名」（冠词、关键字、词汇词）。客户端若也回 null，
   *   Monaco 视为「没有意见」，照样对光标下的词调用 provideRenameEdits（monaco rename.js）。
   *   必须回 { rejectReason } 让 Monaco 拒绝，且提示按 locale 本地化。 */
  it.each([
    ['zh-CN', 'null', '此处无法重命名'],
    ['en-US', 'null', 'cannot be renamed'],
    ['zh-CN', 'error', '此处无法重命名'],
  ] as const)('★%s / prepareRename=%s：resolveRenameLocation 返回 rejectReason', async (locale, mode, expected) => {
    FakeWebSocket.prepareRename = mode;
    const monaco = mount(locale);
    await waitFor(() => expect(monaco.languages.registerRenameProvider).toHaveBeenCalled());
    const loc = await monaco.providers.rename.resolveRenameLocation!(fakeModel, { lineNumber: 1, column: 8 }) as { rejectReason?: string } | null;
    expect(loc?.rejectReason).toContain(expected);
  });
});

