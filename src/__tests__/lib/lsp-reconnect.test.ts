// LSP 断线重连策略（生产复测第 6 轮）：指数退避封顶、Retry-After、握手预算不触发网关限流、
// 页面隐藏 / 离线时挂起，恢复后立即重试。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  backoffDelay,
  parseRetryAfter,
  HandshakeBudget,
  ReconnectScheduler,
  LSP_RECONNECT_MAX_MS,
} from '@/lib/lsp-reconnect';

describe('backoffDelay', () => {
  it('1s → 2s → 4s … 封顶 30s（无抖动的上界）', () => {
    const top = (a: number) => backoffDelay(a, { random: () => 1 });
    expect([0, 1, 2, 3, 4, 5, 6, 20, 1000].map(top)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
  });

  it('抖动落在上界的后一半区间', () => {
    expect(backoffDelay(3, { random: () => 0 })).toBe(4000);
    expect(backoffDelay(10, { random: () => 0 })).toBe(LSP_RECONNECT_MAX_MS / 2);
  });
});

describe('parseRetryAfter', () => {
  it('取网关关闭原因里的 retry-after 秒数', () => {
    expect(parseRetryAfter('Rate limit exceeded; retry-after=12')).toBe(12_000);
    expect(parseRetryAfter('Retry-After=3')).toBe(3_000);
  });
  it('没有或非法时为 null', () => {
    expect(parseRetryAfter('Too many sessions from this client')).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('retry-after=abc')).toBeNull();
  });
});

describe('HandshakeBudget', () => {
  it('窗口内满额后给出等待时间，最早一次滑出窗口后恢复', () => {
    let t = 0;
    const budget = new HandshakeBudget(2, 60_000, () => t);
    budget.record();
    t = 10_000;
    expect(budget.waitMs()).toBe(0);
    budget.record();
    expect(budget.waitMs()).toBe(50_000);
    t = 60_000;
    expect(budget.waitMs()).toBe(0);
  });
});

describe('ReconnectScheduler', () => {
  let paused: boolean;
  let connect: ReturnType<typeof vi.fn<() => void>>;
  let budget: HandshakeBudget;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    paused = false;
    budget = new HandshakeBudget(5, 60_000, () => Date.now());
    connect = vi.fn<() => void>(() => budget.record());
  });
  afterEach(() => vi.useRealTimers());

  const make = (over: Partial<ConstructorParameters<typeof ReconnectScheduler>[0]> = {}) =>
    new ReconnectScheduler({ connect, budget, shouldPause: () => paused, random: () => 1, ...over });

  it('★持续失败时一直按指数退避重试（不再三次后放弃），间隔封顶 30s', () => {
    const s = make();
    const gaps: number[] = [];
    let last = Date.now();
    connect.mockImplementation(() => {
      budget.record();
      gaps.push(Date.now() - last);
      last = Date.now();
      s.failed();
    });
    s.failed();
    vi.advanceTimersByTime(10 * 60_000);
    expect(gaps.length).toBeGreaterThan(10);
    expect(gaps.slice(0, 3)).toEqual([1000, 2000, 4000]);
    expect(Math.max(...gaps.slice(3))).toBeLessThanOrEqual(30_000);
  });

  it('★任意 60 秒窗口内的握手不超过预算（网关 6/分钟、突发 10 不会被触发）', () => {
    // 无抖动下界：random=0 时退避最短，最容易超额
    const s = make({ random: () => 0 });
    const stamps: number[] = [];
    connect.mockImplementation(() => {
      budget.record();
      stamps.push(Date.now());
      s.failed();
    });
    s.failed();
    // 期间反复「页面可见 / 网络恢复」也不能突破预算
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(5_000);
      s.retryNow();
    }
    for (const start of stamps) {
      expect(stamps.filter((x) => x >= start && x < start + 60_000).length).toBeLessThanOrEqual(5);
    }
    expect(stamps.length).toBeGreaterThan(5);
  });

  it('★Retry-After：限流后在要求的时间内不握手，retryNow 也不提前', () => {
    const s = make();
    s.failed(20_000);
    vi.advanceTimersByTime(5_000);
    s.retryNow();
    vi.advanceTimersByTime(14_000);
    expect(connect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('retryNow 把等待中的退避提前到立即', () => {
    const s = make();
    s.failed();
    s.failed();
    s.failed();
    s.failed(); // 下一次本应 8s 后
    s.retryNow();
    vi.advanceTimersByTime(0);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('没有待执行的重连时 retryNow 不做任何事（已连上时页面切回不会多握手）', () => {
    const s = make();
    s.retryNow();
    vi.advanceTimersByTime(60_000);
    expect(connect).not.toHaveBeenCalled();
  });

  it('★页面隐藏 / 离线时挂起不握手，恢复时（retryNow）立即重试', () => {
    const onPause = vi.fn();
    const s = make({ onPause });
    paused = true;
    s.failed();
    vi.advanceTimersByTime(60_000);
    expect(connect).not.toHaveBeenCalled();
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(s.pending).toBe(true);
    paused = false;
    s.retryNow();
    vi.advanceTimersByTime(0);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('succeeded 清零退避并取消待执行的重连', () => {
    const s = make();
    s.failed();
    s.failed();
    s.succeeded();
    expect(s.pending).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(connect).not.toHaveBeenCalled();
    s.failed();
    vi.advanceTimersByTime(1_000);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('maxAttempts>0 时达到次数后放弃并通知', () => {
    const onGiveUp = vi.fn();
    const s = make({ maxAttempts: 2, onGiveUp });
    s.failed();
    s.failed();
    s.failed();
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(s.pending).toBe(false);
  });
});
