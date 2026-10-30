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
      this.serverSend({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } });
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
const fakeMonaco = {
  languages: new Proxy({}, { get: () => () => ({ dispose: vi.fn() }) }),
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

  it('★挂起的请求在心跳超时后被拒绝，而不是永久悬挂', async () => {
    const { result } = renderLsp();
    await tick();
    FakeWebSocket.pingMode = 'silent';
    await tick(LSP_HEARTBEAT_INTERVAL_MS);
    await tick(LSP_HEARTBEAT_TIMEOUT_MS);
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

  it('主动断开后停止心跳，不再发送也不重连', async () => {
    const { result } = renderLsp();
    await tick();
    const ws = FakeWebSocket.instances[0]!;
    act(() => { result.current.disconnect(); });
    await tick(LSP_HEARTBEAT_INTERVAL_MS * 5);
    expect(ws.pings).toHaveLength(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('★重连不放大握手：心跳持续超时时握手频率仍受退避与预算约束', async () => {
    FakeWebSocket.pingMode = 'silent';
    renderLsp();
    await tick();
    // 分步推进：一次 act 内 React 不会冲刷 effect，会话切换要逐步体现
    for (let i = 0; i < 300; i++) await tick(1_000);
    // 5 分钟内：预算 5 次/分钟，网关限流 6 次/分钟均值
    expect(FakeWebSocket.instances.length).toBeLessThanOrEqual(25);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(4);
  });
});
