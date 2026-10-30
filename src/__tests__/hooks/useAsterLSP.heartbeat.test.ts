/**
 * useAsterLSP 应用层心跳（生产复测第 7 轮：网络静默中断时套接字不关闭，状态栏不显示断开，请求悬挂）。
 *
 * 用假 WebSocket + 假时钟驱动真实 hook：连接后每 LSP_HEARTBEAT_INTERVAL_MS 发一次 `$/aster/ping`，
 * LSP_HEARTBEAT_TIMEOUT_MS 内无回应就主动关闭会话并走退避重连。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAsterLSP } from '@/hooks/useAsterLSP';
import {
  HandshakeBudget,
  LSP_HEARTBEAT_INTERVAL_MS,
  LSP_HEARTBEAT_METHOD,
  LSP_HEARTBEAT_TIMEOUT_MS,
} from '@/lib/lsp-reconnect';

type Sent = { jsonrpc: string; id?: number | string; method?: string };

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeWebSocket[] = [];
  /** 对心跳的行为：pong 回空结果；error 回 MethodNotFound（旧网关转发给语言服务器）；silent 不回（静默断网） */
  static pingMode: 'pong' | 'error' | 'silent' = 'pong';
  readyState = 0;
  sent: Sent[] = [];
  closedByClient: { code: number; reason: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState === 3) return;
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(data: string) {
    const msg = JSON.parse(data) as Sent;
    this.sent.push(msg);
    if (msg.method === 'initialize') {
      this.serverSend({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { hoverProvider: true } } });
    }
    if (msg.method === LSP_HEARTBEAT_METHOD) {
      if (FakeWebSocket.pingMode === 'pong') this.serverSend({ jsonrpc: '2.0', id: msg.id, result: null });
      if (FakeWebSocket.pingMode === 'error') this.serverSend({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
  serverSend(m: unknown) { queueMicrotask(() => { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(m) }); }); }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.closedByClient = { code, reason };
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }
  get pings() { return this.sent.filter((m) => m.method === LSP_HEARTBEAT_METHOD); }
}

const fakeModel = {
  uri: { toString: () => 'inmemory://model/1' },
  getValue: () => 'Module demo.',
  getVersionId: () => 1,
  onDidChangeContent: () => ({ dispose: vi.fn() }),
};
const fakeEditor = { getModel: () => fakeModel };
/** 捕获 hover provider：业务请求（textDocument/hover）经它发出，假服务器从不应答 */
const providers: { hover?: { provideHover: (model: unknown, pos: unknown) => Promise<unknown> } } = {};
const fakeMonaco = {
  languages: new Proxy({}, {
    get: (_t, name) => (_lang: string, p: never) => {
      if (name === 'registerHoverProvider') providers.hover = p;
      return { dispose: vi.fn() };
    },
  }),
  editor: { setModelMarkers: vi.fn() },
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
};

async function tick(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

function renderLsp() {
  const budget = new HandshakeBudget(5, 60_000);
  return renderHook(() => useAsterLSP({
    editor: fakeEditor as never,
    monaco: fakeMonaco as never,
    documentUri: 'inmemory://policy/default.aster',
    locale: 'en-US',
    handshakeBudget: budget,
  } as never));
}

describe('useAsterLSP 应用层心跳', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    FakeWebSocket.pingMode = 'pong';
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => 'visible');
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => true);
    process.env.NEXT_PUBLIC_LSP_HOST = 'lsp.example.test';
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.NEXT_PUBLIC_LSP_HOST;
  });

  it('连接后按间隔发心跳，有回应则保持连接', async () => {
    const { result } = renderLsp();
    await tick();
    expect(result.current.status).toBe('connected');
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.pings).toHaveLength(0);
    await tick(LSP_HEARTBEAT_INTERVAL_MS);
    expect(ws.pings).toHaveLength(1);
    await tick(LSP_HEARTBEAT_INTERVAL_MS * 3);
    expect(ws.pings).toHaveLength(4);
    expect(result.current.status).toBe('connected');
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('★静默断网：心跳超时未回，主动关闭会话、状态栏转 reconnecting，并按退避重连', async () => {
    const { result } = renderLsp();
    await tick();
    FakeWebSocket.pingMode = 'silent';
    const ws = FakeWebSocket.instances[0]!;
    await tick(LSP_HEARTBEAT_INTERVAL_MS);
    expect(result.current.status).toBe('connected');
    await tick(LSP_HEARTBEAT_TIMEOUT_MS - 1);
    expect(result.current.status).toBe('connected');
    await tick(1);
    expect(result.current.status).toBe('reconnecting');
    expect(result.current.connected).toBe(false);
    expect(result.current.error).toMatch(/heartbeat/i);
    expect(ws.closedByClient).not.toBeNull();

    FakeWebSocket.pingMode = 'pong';
    await tick(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await tick();
    expect(result.current.status).toBe('connected');
  });

  it('★挂起的业务请求在心跳超时后结束，而不是永久悬挂', async () => {
    const { result } = renderLsp();
    await tick();
    FakeWebSocket.pingMode = 'silent';
    await tick(LSP_HEARTBEAT_INTERVAL_MS);
    // hover 不设自身超时，假服务器不应答：只能靠心跳失败（dropSession 拒绝挂起项）结束
    let settled = false;
    const hover = providers.hover!.provideHover(fakeModel, { lineNumber: 1, column: 1 }).then((r) => { settled = true; return r; });
    await tick(LSP_HEARTBEAT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await tick(1);
    await expect(hover).resolves.toBeNull();
    expect(settled).toBe(true);
    expect(FakeWebSocket.instances[0]!.sent.some((m) => m.method === 'textDocument/hover')).toBe(true);
    expect(result.current.status).toBe('reconnecting');
  });

  it('旧网关把心跳转给语言服务器并回 MethodNotFound：同样视为存活', async () => {
    FakeWebSocket.pingMode = 'error';
    const { result } = renderLsp();
    await tick();
    await tick(LSP_HEARTBEAT_INTERVAL_MS * 3 + LSP_HEARTBEAT_TIMEOUT_MS);
    expect(result.current.status).toBe('connected');
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('★已发出过心跳后主动断开：定时器被清除，不再发送也不重连', async () => {
    const { result } = renderLsp();
    await tick();
    const ws = FakeWebSocket.instances[0]!;
    await tick(LSP_HEARTBEAT_INTERVAL_MS);
    expect(ws.pings).toHaveLength(1);
    act(() => { result.current.disconnect(); });
    await tick(LSP_HEARTBEAT_INTERVAL_MS * 5);
    expect(ws.pings).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('★已发出过心跳后卸载：不再发送也不重连', async () => {
    const { unmount } = renderLsp();
    await tick();
    const ws = FakeWebSocket.instances[0]!;
    await tick(LSP_HEARTBEAT_INTERVAL_MS);
    expect(ws.pings).toHaveLength(1);
    unmount();
    await tick(LSP_HEARTBEAT_INTERVAL_MS * 5);
    expect(ws.pings).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('★会话重建（词汇 / 租户变化）：旧会话停止心跳，新会话各自心跳，不叠加定时器', async () => {
    const budget = new HandshakeBudget(5, 60_000);
    const { rerender } = renderHook((props: { tenantId?: string; domainVocabularies?: unknown[] }) => useAsterLSP({
      editor: fakeEditor as never,
      monaco: fakeMonaco as never,
      documentUri: 'inmemory://policy/default.aster',
      locale: 'en-US',
      handshakeBudget: budget,
      ...props,
    } as never), { initialProps: {} as { tenantId?: string; domainVocabularies?: unknown[] } });
    await tick();
    const first = FakeWebSocket.instances[0]!;
    await tick(LSP_HEARTBEAT_INTERVAL_MS);
    expect(first.pings).toHaveLength(1);
    rerender({ domainVocabularies: [{ id: 'd' }], tenantId: 't1' });
    await tick();
    await tick(LSP_HEARTBEAT_INTERVAL_MS * 2);
    const live = FakeWebSocket.instances.filter((w) => w.readyState === 1);
    expect(live).toHaveLength(1);
    expect(live[0]!.pings).toHaveLength(2);
    expect(first.pings).toHaveLength(1);
  });

  it('documentUri 切换不重建会话：心跳节奏不变，定时器不叠加', async () => {
    const budget = new HandshakeBudget(5, 60_000);
    const { rerender } = renderHook((props: { uri: string }) => useAsterLSP({
      editor: fakeEditor as never,
      monaco: fakeMonaco as never,
      documentUri: props.uri,
      locale: 'en-US',
      handshakeBudget: budget,
    } as never), { initialProps: { uri: 'inmemory://policy/a.aster' } });
    await tick();
    rerender({ uri: 'inmemory://policy/b.aster' });
    await tick(LSP_HEARTBEAT_INTERVAL_MS * 4);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]!.pings).toHaveLength(4);
  });

  it('★首个心跳成功前不清零退避：连上即心跳超时的会话，重连间隔持续递增', async () => {
    FakeWebSocket.pingMode = 'silent';
    renderLsp();
    const openedAt: number[] = [];
    let seen = 0;
    let elapsed = 0;
    // 分步推进：一次 act 内 React 不会冲刷 effect，会话切换要逐步体现
    for (let i = 0; i < 400; i++) {
      await tick(1_000);
      elapsed += 1_000;
      while (seen < FakeWebSocket.instances.length) { openedAt.push(elapsed); seen++; }
    }
    // 每个会话存活 25s（15s 间隔 + 10s 超时）后被杀；其后的等待 = 退避，应逐步增大
    const gaps = openedAt.slice(1).map((t, i) => t - openedAt[i]! - (LSP_HEARTBEAT_INTERVAL_MS + LSP_HEARTBEAT_TIMEOUT_MS));
    expect(gaps.length).toBeGreaterThanOrEqual(4);
    expect(gaps[3]!).toBeGreaterThan(gaps[0]!);
    // 400s 内握手次数明显少于「退避被清零」时的约 15 次（每次约 26s）
    expect(FakeWebSocket.instances.length).toBeLessThanOrEqual(11);
  });

  it('首个心跳得到回应后退避清零：之后掉线按最短退避重连', async () => {
    const { result } = renderLsp();
    await tick();
    FakeWebSocket.pingMode = 'silent';
    await tick(LSP_HEARTBEAT_INTERVAL_MS);
    await tick(LSP_HEARTBEAT_TIMEOUT_MS);
    expect(result.current.status).toBe('reconnecting');
    FakeWebSocket.pingMode = 'pong';
    await tick(2_000);
    await tick(LSP_HEARTBEAT_INTERVAL_MS);
    expect(result.current.status).toBe('connected');
    const before = FakeWebSocket.instances.length;
    FakeWebSocket.instances[before - 1]!.close(1006, 'lost');
    await tick(1_100);
    expect(FakeWebSocket.instances.length).toBe(before + 1);
  });

  it('页面隐藏时心跳超时：不握手，停在 disconnected，重新可见后恢复', async () => {
    let visibility: 'visible' | 'hidden' = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const { result } = renderLsp();
    await tick();
    visibility = 'hidden';
    FakeWebSocket.pingMode = 'silent';
    await tick(LSP_HEARTBEAT_INTERVAL_MS);
    await tick(LSP_HEARTBEAT_TIMEOUT_MS);
    await tick(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(result.current.status).toBe('disconnected');
    visibility = 'visible';
    FakeWebSocket.pingMode = 'pong';
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await tick();
    expect(FakeWebSocket.instances).toHaveLength(2);
    await tick();
    expect(result.current.status).toBe('connected');
  });

  it('★冻结唤醒：超时与迟到的 pong 竞争，旧会话的迟到 pong 不引发第二次重连', async () => {
    const { result } = renderLsp();
    await tick();
    FakeWebSocket.pingMode = 'silent';
    const old = FakeWebSocket.instances[0]!;
    await tick(LSP_HEARTBEAT_INTERVAL_MS);
    const pingId = old.pings[0]!.id;
    await tick(LSP_HEARTBEAT_TIMEOUT_MS);
    expect(result.current.status).toBe('reconnecting');
    // 唤醒后旧会话排队的 pong 才送达（readyState 已关闭，不会投递）
    old.readyState = 1;
    old.serverSend({ jsonrpc: '2.0', id: pingId, result: null });
    old.readyState = 3;
    FakeWebSocket.pingMode = 'pong';
    await tick(1_000);
    await tick(LSP_HEARTBEAT_INTERVAL_MS * 2);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(result.current.status).toBe('connected');
  });

  it('★重连不放大握手：心跳持续超时时握手频率仍受退避与预算约束', async () => {
    FakeWebSocket.pingMode = 'silent';
    renderLsp();
    await tick();
    // 分步推进：一次 act 内 React 不会冲刷 effect，会话切换要逐步体现
    for (let i = 0; i < 300; i++) await tick(1_000);
    // 5 分钟内：预算 5 次/分钟，网关限流 6 次/分钟均值
    expect(FakeWebSocket.instances.length).toBeLessThanOrEqual(25);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(2);
  });
});
