/**
 * LSP WebSocket 保活：Cloudflare 隧道约 100 秒无流量即断开 WebSocket，
 * 空闲编辑器因此反复断线重连，重试耗尽后报 "[LSP] Initialization failed: Disconnected"。
 * keepaliveTick 每轮对存活连接发 ping，并终止上一轮未回 pong 的死连接。
 */
import { describe, it, expect, vi } from 'vitest';
import { keepaliveTick, KEEPALIVE_INTERVAL_MS } from '../../../lsp-server.mjs';

function fakeSocket(isAlive?: boolean) {
  return { isAlive, ping: vi.fn(), terminate: vi.fn() };
}

describe('keepaliveTick', () => {
  it('对存活连接发 ping 并标记为待确认', () => {
    const ws = fakeSocket(true);
    keepaliveTick(new Set([ws]));
    expect(ws.ping).toHaveBeenCalledTimes(1);
    expect(ws.isAlive).toBe(false);
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it('上一轮未回 pong 的连接被终止且不再 ping', () => {
    const ws = fakeSocket(false);
    keepaliveTick(new Set([ws]));
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(ws.ping).not.toHaveBeenCalled();
  });

  it('保活间隔远小于 Cloudflare 的 100 秒空闲超时', () => {
    expect(KEEPALIVE_INTERVAL_MS).toBeLessThanOrEqual(30_000);
  });
});
