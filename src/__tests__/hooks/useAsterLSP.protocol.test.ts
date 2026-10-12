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

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
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
      this.serverSend({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { hoverProvider: true } } });
    }
    if (msg.method === 'initialized') {
      this.serverSend({ jsonrpc: '2.0', id: 'srv-1', method: 'client/registerCapability', params: { registrations: [] } });
    }
    if (msg.method === 'textDocument/hover') {
      this.serverSend({ jsonrpc: '2.0', id: msg.id, result: { contents: { kind: 'markdown', value: '**规则** twice' } } });
    }
  }
  serverSend(m: unknown) { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(m) })); }
  close() { this.readyState = 3; }
}

function makeFakeMonaco() {
  const providers: Record<string, { provideHover?: (...a: unknown[]) => unknown }> = {};
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
      DocumentHighlightKind: { Text: 0 },
      SymbolKind: {},
    },
    editor: { setModelMarkers: vi.fn() },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    Uri: { parse: (s: string) => ({ toString: () => s }) },
  };
}

const fakeModel = {
  getValue: () => '模块 demo.p。',
  getVersionId: () => 1,
  onDidChangeContent: () => ({ dispose: vi.fn() }),
};
const fakeEditor = { getModel: () => fakeModel };

describe('useAsterLSP 协议', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
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
    expect(cfg?.params).toEqual({ settings: { asterLanguageServer: { locale: 'zh-CN' } } });
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
});
