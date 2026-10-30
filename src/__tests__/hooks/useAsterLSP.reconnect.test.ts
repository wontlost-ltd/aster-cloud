/**
 * useAsterLSP 断线重连（生产复测第 6 轮：会话以 1000 "Client disconnect" 关闭后不再重连，补全只剩单词建议）。
 *
 * 用假 WebSocket + 假时钟驱动真实 hook：
 *   - 服务端关闭会话（含 1000 "Language server stopped"）后按退避重连；只有本端主动断开才不重连。
 *   - 连接未完成时 effect 重跑（词汇加载完成等），旧会话的关闭不能波及新会话。
 *   - 网关限流关闭（4429 + retry-after）期间不握手；页面重新可见 / 网络恢复时立即重试。
 *   - 断线期间补全立即返回，不阻塞本地补全。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAsterLSP } from '@/hooks/useAsterLSP';
import { HandshakeBudget, LSP_RATE_LIMITED_CLOSE_CODE } from '@/lib/lsp-reconnect';

type Sent = { jsonrpc: string; id?: number | string; method?: string };
type CloseEvent = { code: number; reason: string };

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeWebSocket[] = [];
  /** 新连接的行为：open 正常握手；refuse 握手失败（error + close 1006） */
  static mode: 'open' | 'refuse' = 'open';
  readyState = 0;
  sent: Sent[] = [];
  closedByClient: CloseEvent | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    const mode = FakeWebSocket.mode;
    queueMicrotask(() => {
      if (this.readyState === 3) return;
      if (mode === 'refuse') {
        this.readyState = 3;
        this.onerror?.({});
        queueMicrotask(() => this.onclose?.({ code: 1006, reason: '' }));
        return;
      }
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(data: string) {
    const msg = JSON.parse(data) as Sent;
    this.sent.push(msg);
    if (msg.method === 'initialize') {
      this.serverSend({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { completionProvider: { triggerCharacters: ['.'] } } } });
    }
    if (msg.method === 'textDocument/completion') {
      this.serverSend({ jsonrpc: '2.0', id: msg.id, result: [] });
    }
  }
  serverSend(m: unknown) { queueMicrotask(() => { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(m) }); }); }
  /** 服务端关闭会话 */
  serverClose(code: number, reason = '') {
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.closedByClient = { code, reason };
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }
  get initialized() { return this.sent.some((m) => m.method === 'textDocument/didOpen'); }
}

function makeFakeMonaco() {
  const providers: Record<string, { provideCompletionItems?: (...a: unknown[]) => unknown }> = {};
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

const fakeModel = {
  uri: { toString: () => 'inmemory://model/1' },
  getValue: () => 'Module demo.',
  getVersionId: () => 1,
  onDidChangeContent: () => ({ dispose: vi.fn() }),
  getLineContent: () => 'Return d.',
  getLineMaxColumn: () => 10,
  getWordUntilPosition: () => ({ word: '', startColumn: 10, endColumn: 10 }),
};
const fakeEditor = { getModel: () => fakeModel };

/** 推进假时钟并冲刷 hook 里的 promise 链 */
async function tick(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

let visibility: 'visible' | 'hidden';
let online: boolean;

function renderLsp(extra: Record<string, unknown> = {}) {
  const monaco = makeFakeMonaco();
  const budget = new HandshakeBudget(5, 60_000);
  const view = renderHook((props: Record<string, unknown>) => useAsterLSP({
    editor: fakeEditor as never,
    monaco: monaco as never,
    documentUri: 'inmemory://policy/default.aster',
    locale: 'en-US',
    handshakeBudget: budget,
    ...props,
  } as never), { initialProps: extra });
  return { ...view, monaco };
}

describe('useAsterLSP 断线重连', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    FakeWebSocket.mode = 'open';
    visibility = 'visible';
    online = true;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
    process.env.NEXT_PUBLIC_LSP_HOST = 'lsp.example.test';
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.NEXT_PUBLIC_LSP_HOST;
  });

  it('★服务端关闭会话（1000 Language server stopped）后自动重连并重新初始化', async () => {
    const { result } = renderLsp();
    await tick();
    expect(result.current.status).toBe('connected');
    FakeWebSocket.instances[0]!.serverClose(1000, 'Language server stopped');
    await tick();
    expect(result.current.status).toBe('reconnecting');
    expect(result.current.connected).toBe(false);
    await tick(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]!.initialized).toBe(true);
    expect(result.current.status).toBe('connected');
  });

  it('★连接中 effect 重跑（词汇加载完成）：旧会话的 1000 Client disconnect 不波及新会话', async () => {
    const { result, rerender } = renderLsp({ domainVocabularies: undefined });
    // 第一条握手尚未完成就因 deps 变化重连
    rerender({ domainVocabularies: [{ id: 'd' }], tenantId: 't1' });
    await tick();
    await tick(60_000);
    const live = FakeWebSocket.instances.filter((ws) => ws.readyState === 1);
    expect(live).toHaveLength(1);
    expect(live[0]!.initialized).toBe(true);
    expect(result.current.connected).toBe(true);
    expect(result.current.status).toBe('connected');
  });

  it('★已连上后 effect 重跑：新会话保持连接，不因旧会话关闭而掉线', async () => {
    const { result, rerender } = renderLsp({ domainVocabularies: undefined });
    await tick();
    rerender({ domainVocabularies: [{ id: 'd' }], tenantId: 't1' });
    await tick();
    await tick(60_000);
    expect(FakeWebSocket.instances[0]!.closedByClient?.code).toBe(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]!.initialized).toBe(true);
    expect(result.current.connected).toBe(true);
  });

  it('★握手持续失败时按指数退避一直重试（不再三次后静默放弃）', async () => {
    FakeWebSocket.mode = 'refuse';
    const { result } = renderLsp();
    await tick();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(result.current.status).toBe('reconnecting');
    await tick(5 * 60_000);
    const attempts = FakeWebSocket.instances.length;
    expect(attempts).toBeGreaterThan(4);
    // 5 分钟、退避封顶 30s 且预算 5 次/分钟：不会是紧循环
    expect(attempts).toBeLessThanOrEqual(25);
    FakeWebSocket.mode = 'open';
    await tick(30_000);
    expect(result.current.status).toBe('connected');
  });

  it('★网关限流关闭（4429 retry-after）：期间不握手，页面重新可见也不提前', async () => {
    const { result } = renderLsp();
    await tick();
    FakeWebSocket.instances[0]!.serverClose(LSP_RATE_LIMITED_CLOSE_CODE, 'Rate limit exceeded; retry-after=20');
    await tick(5_000);
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await tick(14_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await tick(1_100);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await tick();
    expect(result.current.status).toBe('connected');
  });

  // #665 审查 M2：同一 IP 会话数超限时不能持续握手，挤掉其他标签页的重连
  it('★会话数超限（4429 Too many sessions）：按 retry-after 等待，状态为 tooManySessions', async () => {
    const { result } = renderLsp();
    await tick();
    FakeWebSocket.instances[0]!.serverClose(LSP_RATE_LIMITED_CLOSE_CODE, 'Too many sessions from this client; retry-after=30');
    await tick();
    expect(result.current.status).toBe('tooManySessions');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await tick(29_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await tick(1_100);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await tick();
    expect(result.current.status).toBe('connected');
  });

  it('★4429 不带 retry-after（旧网关）：直接退到退避上限 30s，不持续握手', async () => {
    const { result } = renderLsp();
    await tick();
    FakeWebSocket.instances[0]!.serverClose(LSP_RATE_LIMITED_CLOSE_CODE, 'Too many sessions from this client');
    await tick();
    expect(result.current.status).toBe('tooManySessions');
    await tick(29_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await tick(1_100);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('★页面隐藏时不重连；重新可见时立即重试', async () => {
    const { result } = renderLsp();
    await tick();
    visibility = 'hidden';
    FakeWebSocket.instances[0]!.serverClose(1006);
    await tick(5 * 60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(result.current.status).toBe('disconnected');
    visibility = 'visible';
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await tick();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(result.current.status).toBe('connected');
  });

  it('★离线时不重连；网络恢复（online）时立即重试', async () => {
    const { result } = renderLsp();
    await tick();
    online = false;
    FakeWebSocket.instances[0]!.serverClose(1006);
    await tick(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    online = true;
    act(() => { window.dispatchEvent(new Event('online')); });
    await tick();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(result.current.status).toBe('connected');
  });

  it('已连上时页面切回可见不会多握手', async () => {
    renderLsp();
    await tick();
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    act(() => { window.dispatchEvent(new Event('online')); });
    await tick(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('★断线期间成员访问补全立即返回、不发请求（本地补全不被拖慢）', async () => {
    const { monaco } = renderLsp();
    await tick();
    const ws = FakeWebSocket.instances[0]!;
    ws.serverClose(1006);
    await tick();
    const started = Date.now();
    const out = await monaco.providers.completion!.provideCompletionItems!(
      fakeModel, { lineNumber: 1, column: 9 }, { triggerKind: 0 }, { isCancellationRequested: false });
    expect(out).toBeNull();
    expect(Date.now() - started).toBe(0);
    expect(ws.sent.some((m) => m.method === 'textDocument/completion')).toBe(false);
  });

  it('卸载后不再重连', async () => {
    const { unmount } = renderLsp();
    await tick();
    const ws = FakeWebSocket.instances[0]!;
    unmount();
    ws.serverClose(1006);
    await tick(5 * 60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('本端主动 disconnect 后不重连', async () => {
    const { result } = renderLsp();
    await tick();
    act(() => result.current.disconnect());
    await tick(5 * 60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(result.current.status).toBe('idle');
  });
});
