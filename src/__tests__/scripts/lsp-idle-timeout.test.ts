/**
 * LSP 网关闲置超时（#657）：浏览器会自动回 pong，协议级保活让闲置的编辑器标签页无限期占着一个
 * 约 80 MiB 的语言服务器子进程。一段时间内没有任何 LSP 消息（ping/pong 不算）就以 4408 关闭会话，
 * 子进程随会话关闭而退出、工作目录随之删除；客户端在用户回到页面时按需重连。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  idleTick,
  idleTimeoutFromEnv,
  idleCheckIntervalMs,
  LSP_IDLE_CLOSE_CODE,
  DEFAULT_IDLE_TIMEOUT_MS,
  KEEPALIVE_INTERVAL_MS,
} from '../../../lsp-server.mjs';
import { LSP_IDLE_CLOSE_CODE as CLIENT_IDLE_CLOSE_CODE } from '@/lib/lsp-reconnect';

function fakeSocket(lastActivityAt: number) {
  return { lastActivityAt, close: vi.fn() };
}

describe('idleTick', () => {
  it('超过闲置时长的会话以 4408 关闭，仍活跃的不受影响', () => {
    const idle = fakeSocket(0);
    const active = fakeSocket(9_000);
    idleTick(new Set([idle, active]), { now: 10_000, idleTimeoutMs: 5_000 });
    expect(idle.close).toHaveBeenCalledWith(LSP_IDLE_CLOSE_CODE, 'Idle timeout');
    expect(active.close).not.toHaveBeenCalled();
  });

  it('恰好到达闲置时长即关闭', () => {
    const ws = fakeSocket(5_000);
    idleTick(new Set([ws]), { now: 10_000, idleTimeoutMs: 5_000 });
    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it('闲置超时为 0（关闭该功能）时不关闭任何会话', () => {
    const ws = fakeSocket(0);
    idleTick(new Set([ws]), { now: 10 ** 9, idleTimeoutMs: 0 });
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('尚未记录活动时间的连接（握手中）不关闭', () => {
    const ws = { close: vi.fn() };
    idleTick(new Set([ws]), { now: 10 ** 9, idleTimeoutMs: 1 });
    expect(ws.close).not.toHaveBeenCalled();
  });
});

describe('闲置超时配置', () => {
  it('默认 15 分钟；LSP_IDLE_TIMEOUT_MS 可覆盖；0 关闭；非法值回落默认', () => {
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(15 * 60_000);
    expect(idleTimeoutFromEnv(undefined)).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(idleTimeoutFromEnv('60000')).toBe(60_000);
    expect(idleTimeoutFromEnv('0')).toBe(0);
    expect(idleTimeoutFromEnv('abc')).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(idleTimeoutFromEnv('-5')).toBe(DEFAULT_IDLE_TIMEOUT_MS);
  });

  it('检查间隔不超过保活间隔，也不超过闲置时长的四分之一（最少 250ms）', () => {
    expect(idleCheckIntervalMs(DEFAULT_IDLE_TIMEOUT_MS)).toBe(KEEPALIVE_INTERVAL_MS);
    expect(idleCheckIntervalMs(2_000)).toBe(500);
    expect(idleCheckIntervalMs(100)).toBe(250);
  });

  it('网关与客户端使用同一个关闭码', () => {
    expect(LSP_IDLE_CLOSE_CODE).toBe(4408);
    expect(CLIENT_IDLE_CLOSE_CODE).toBe(LSP_IDLE_CLOSE_CODE);
  });
});
