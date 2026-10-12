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

type Sent = { jsonrpc: string; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };

const NEW_SERVER_CAPS = {
  hoverProvider: true, definitionProvider: true, referencesProvider: true, documentSymbolProvider: true,
  signatureHelpProvider: {}, codeActionProvider: {}, renameProvider: { prepareProvider: true },
  documentFormattingProvider: true, documentHighlightProvider: true,
  experimental: { aster: { localizedParsing: true, openDocumentNavigation: true } },
};
/** 生产 1.0.32 的能力：无 experimental 标志 */
const OLD_SERVER_CAPS = { ...NEW_SERVER_CAPS, experimental: undefined };

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  static serverCaps: Record<string, unknown> = NEW_SERVER_CAPS;
  static hoverFails = false;
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
    if (msg.method === 'textDocument/codeAction') {
      this.serverSend({ jsonrpc: '2.0', id: msg.id, result: [] });
    }
  }
  serverSend(m: unknown) { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(m) })); }
  close() { this.readyState = 3; }
}

function makeFakeMonaco() {
  const providers: Record<string, { provideHover?: (...a: unknown[]) => unknown; provideCodeActions?: (...a: unknown[]) => unknown }> = {};
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
      SymbolKind: {},
    },
    editor: { setModelMarkers: vi.fn() },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    Uri: { parse: (s: string) => ({ toString: () => s }) },
  };
}

// 模型 URI 与 documentUri prop 故意不同：@monaco-editor/react 未传 path 时模型 URI 就是 inmemory://model/N
const MODEL_URI = 'inmemory://model/1';
const fakeModel = {
  uri: { toString: () => MODEL_URI },
  getValue: () => '模块 demo.p。',
  getVersionId: () => 1,
  onDidChangeContent: () => ({ dispose: vi.fn() }),
};
const otherModel = { ...fakeModel, uri: { toString: () => 'inmemory://model/2' } };
const fakeEditor = { getModel: () => fakeModel };

describe('useAsterLSP 协议', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeWebSocket.serverCaps = NEW_SERVER_CAPS;
    FakeWebSocket.hoverFails = false;
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

  const mount = (locale: 'zh-CN' | 'en-US' = 'zh-CN', extra: Record<string, unknown> = {}) => {
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
  it('★不注册 LSP 补全 provider', async () => {
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
});
