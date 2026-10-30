/**
 * LSP 会话断线重连策略（生产复测第 6 轮：会话断开后不再重连）。
 *
 * - 指数退避：1s、2s、4s … 封顶 30s，带抖动（同一网络下多个标签页不同时重连）。
 * - 网关按客户端 IP 限制握手速率（lsp-server.mjs createClientLimiter：平均 6 次/分钟、突发 10，cloud#658）。
 *   客户端自带握手预算（同一页面内所有编辑器共享，每 60 秒至多 5 次，低于网关的平均速率），自动重连从不超出它；
 *   稳态下退避封顶 30s，即每个标签页每分钟约 2 次握手，给同一 IP 的其他标签页留余量。
 * - 被网关限流时（关闭码 4429，原因带 `retry-after=N`）在 N 秒内不再握手，页面恢复可见 / 网络恢复也不例外。
 * - 页面隐藏或离线时不握手，挂起到页面重新可见或网络恢复（retryNow）时立即重试。
 *
 * 纯逻辑，计时与环境经依赖注入，便于用假时钟测试。
 */

/** 网关因限流拒绝会话时的 WebSocket 关闭码（4000–4999 为应用自定义区间，429 取自 HTTP 语义）。 */
export const LSP_RATE_LIMITED_CLOSE_CODE = 4429;

export const LSP_RECONNECT_BASE_MS = 1_000;
export const LSP_RECONNECT_MAX_MS = 30_000;

/** 第 attempt 次（从 0 起）重连前的等待：base·2^attempt 封顶 max，取其后一半区间内的随机值（equal jitter）。 */
export function backoffDelay(
  attempt: number,
  { baseMs = LSP_RECONNECT_BASE_MS, maxMs = LSP_RECONNECT_MAX_MS, random = Math.random } = {},
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

/** 从网关关闭原因中取 Retry-After（`… retry-after=N`，秒）→ 毫秒；没有或非法时返回 null。 */
export function parseRetryAfter(reason: string | undefined): number | null {
  const match = /retry-after=(\d{1,6})/i.exec(reason ?? '');
  return match ? Number(match[1]) * 1000 : null;
}

/** 滑动窗口内的握手计数：每次握手 record，waitMs 给出下一次握手还需等多久。 */
export class HandshakeBudget {
  private stamps: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  record(): void {
    this.prune();
    this.stamps.push(this.now());
  }

  waitMs(): number {
    this.prune();
    if (this.stamps.length < this.limit) return 0;
    return this.stamps[this.stamps.length - this.limit]! + this.windowMs - this.now();
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.stamps.length > 0 && this.stamps[0]! <= cutoff) this.stamps.shift();
  }
}

/** 同一页面内所有 LSP 会话共享的握手预算（网关按 IP 计数，同页多个编辑器共用同一 IP 的额度）。 */
export const sharedHandshakeBudget = new HandshakeBudget(5, 60_000);

export interface ReconnectSchedulerDeps {
  /** 发起一次连接（握手由调用方记入预算）；也可之后经 setConnect 绑定 */
  connect?: () => void;
  budget: Pick<HandshakeBudget, 'waitMs'>;
  /** 页面隐藏或离线时为 true：此时不握手，等 retryNow */
  shouldPause: () => boolean;
  /** 挂起（等页面可见 / 网络恢复）时通知调用方 */
  onPause?: () => void;
  baseMs?: number;
  maxMs?: number;
  /** 连续失败多少次后放弃，0 为不限 */
  maxAttempts?: number;
  /** 放弃时通知调用方 */
  onGiveUp?: () => void;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** 断线重连调度：failed 安排下一次，retryNow 提前到最早允许的时刻，succeeded 清零。 */
export class ReconnectScheduler {
  private attempt = 0;
  private notBefore = 0;
  private timer: unknown = null;
  private paused = false;
  private connect: () => void;

  constructor(private readonly deps: ReconnectSchedulerDeps) {
    this.connect = deps.connect ?? (() => {});
  }

  /** 绑定（或更新）发起连接的函数：React hook 的 connect 随依赖变化，由 effect 同步过来 */
  setConnect(connect: () => void): void {
    this.connect = connect;
  }

  /** 是否有待执行的重连（已排定或挂起中） */
  get pending(): boolean {
    return this.timer !== null || this.paused;
  }

  /** 一次连接失败或会话丢失；retryAfterMs 为网关要求的最短等待。 */
  failed(retryAfterMs?: number | null): void {
    const now = this.now();
    if (retryAfterMs) this.notBefore = Math.max(this.notBefore, now + retryAfterMs);
    const { maxAttempts = 0 } = this.deps;
    if (maxAttempts > 0 && this.attempt >= maxAttempts) {
      this.cancel();
      this.deps.onGiveUp?.();
      return;
    }
    const backoff = backoffDelay(this.attempt, { baseMs: this.deps.baseMs, maxMs: this.deps.maxMs, random: this.deps.random });
    this.attempt++;
    this.schedule(Math.max(backoff, this.earliestMs()));
  }

  /** 页面重新可见 / 网络恢复：有待执行的重连时，在限流与预算允许的最早时刻重试。 */
  retryNow(): void {
    if (!this.pending) return;
    this.schedule(this.earliestMs());
  }

  succeeded(): void {
    this.attempt = 0;
    this.cancel();
  }

  cancel(): void {
    if (this.timer !== null) (this.deps.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>);
    this.timer = null;
    this.paused = false;
  }

  private earliestMs(): number {
    return Math.max(0, this.notBefore - this.now(), this.deps.budget.waitMs());
  }

  private schedule(ms: number): void {
    this.cancel();
    this.timer = (this.deps.setTimer ?? setTimeout)(() => this.fire(), ms);
  }

  private fire(): void {
    this.timer = null;
    if (this.deps.shouldPause()) {
      this.paused = true;
      this.deps.onPause?.();
      return;
    }
    // 预算可能已被同页其他会话用掉：顺延而不是超额握手
    const wait = this.earliestMs();
    if (wait > 0) {
      this.schedule(wait);
      return;
    }
    this.connect();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
