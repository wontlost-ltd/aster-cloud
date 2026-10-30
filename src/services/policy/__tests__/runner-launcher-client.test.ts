import { describe, it, expect, beforeEach, vi } from 'vitest';
import { launchRunnerJob } from '../runner-launcher-client';

describe('launchRunnerJob', () => {
  beforeEach(() => {
    process.env.ASTER_RUNNER_LAUNCHER_HMAC_KEY = 'k';
    process.env.ASTER_RUNNER_LAUNCHER_URL = 'https://launcher.test';
  });

  it('成功响应（outcome SUCCESS 200）→ {ok:true, replayMetadata}', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      outcome: 'SUCCESS',
      replayMetadata: { canonicalInputHash: 'i', canonicalOutputHash: 'o',
        canonicalizationVersion: 'v1', replayabilityStatus: 'REPLAYABLE', traceHash: 't' },
    }), { status: 200 }));
    const r = await launchRunnerJob({ tenantId: 't', source: 's', input: {}, locale: 'en-US', functionName: 'f', aliasSet: null, role: 'ADMIN' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.replayMetadata.canonicalInputHash).toBe('i');
  });

  it('runner 业务错（outcome ERROR 200）→ {ok:false, kind:runner-error}（按 outcome 非 HTTP status）', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      outcome: 'ERROR', errorCode: 'MODULE', message: 'boom', phase: 'execute' }), { status: 200 }));
    const r = await launchRunnerJob({ tenantId: 't', source: 's', input: {}, locale: 'en-US', functionName: 'f', aliasSet: null, role: 'ADMIN' });
    expect(r.ok).toBe(false);
    // ★用 if (kind==='runner-error') 而非 expect().toBe() 收窄——后者不是类型守卫，
    //   tsc --strict 下访问 r.errorCode 会报"不存在于 unavailable 分支"。
    if (!r.ok && r.kind === 'runner-error') { expect(r.errorCode).toBe('MODULE'); }
    else { throw new Error('expected kind=runner-error'); }
  });

  it('HTTP 非 200 / 网络错 → {ok:false, kind:unavailable}', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('nope', { status: 503 }));
    const r = await launchRunnerJob({ tenantId: 't', source: 's', input: {}, locale: 'en-US', functionName: 'f', aliasSet: null, role: 'ADMIN' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('unavailable');
  });

  // launcher 在建 Job 前预检请求体（aster-api#408/#410）：超出 ConfigMap 1 MiB 上限返回 413。
  // 这是调用方可修正的问题（缩减词汇或源码），不能与集群不可用混为 unavailable（#692）。
  it('413（请求体超 ConfigMap 上限）→ runner-error/REQUEST_TOO_LARGE，message 取 launcher 正文 error', async () => {
    const error = 'runner request too large for configmap (limit 1MiB), reduce vocabulary or source';
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error }), { status: 413 }));
    const r = await launchRunnerJob({ tenantId: 't', source: 's', input: {}, locale: 'en-US', functionName: 'f', aliasSet: null, role: 'ADMIN' });
    expect(r).toEqual({ ok: false, kind: 'runner-error', errorCode: 'REQUEST_TOO_LARGE', phase: 'launch', message: error });
  });

  it('413 正文不是 JSON 或缺 error 字段 → 仍归 REQUEST_TOO_LARGE，message 用固定说明', async () => {
    for (const body of ['too large', JSON.stringify({}), JSON.stringify({ error: 42 })]) {
      global.fetch = vi.fn().mockResolvedValue(new Response(body, { status: 413 }));
      const r = await launchRunnerJob({ tenantId: 't', source: 's', input: {}, locale: 'en-US', functionName: 'f', aliasSet: null, role: 'ADMIN' });
      if (!r.ok && r.kind === 'runner-error') {
        expect(r.errorCode).toBe('REQUEST_TOO_LARGE');
        expect(r.phase).toBe('launch');
        expect(r.message).toBe('runner request too large');
      } else {
        throw new Error(`expected kind=runner-error for body ${body}`);
      }
    }
  });

  // 读 413 正文也在超时保护内：正文迟迟不来时由 abort 打断，而不是让 parity 校验无限挂起
  it('413 正文卡住 → 超时后仍返回 REQUEST_TOO_LARGE（固定说明），不挂起', async () => {
    process.env.ASTER_RUNNER_LAUNCHER_TIMEOUT = '50';
    try {
      global.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const body = new ReadableStream({
          start(controller) {
            // 只在请求被 abort 时结束正文，模拟一直不写完的 413 响应
            init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
          },
        });
        return new Response(body, { status: 413 });
      });
      const r = await launchRunnerJob({ tenantId: 't', source: 's', input: {}, locale: 'en-US', functionName: 'f', aliasSet: null, role: 'ADMIN' });
      expect(r).toEqual({ ok: false, kind: 'runner-error', errorCode: 'REQUEST_TOO_LARGE', phase: 'launch', message: 'runner request too large' });
    } finally {
      delete process.env.ASTER_RUNNER_LAUNCHER_TIMEOUT;
    }
  }, 2000);

  it('其余非 2xx（500/502/401）仍归 unavailable', async () => {
    for (const status of [500, 502, 401]) {
      global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'x' }), { status }));
      const r = await launchRunnerJob({ tenantId: 't', source: 's', input: {}, locale: 'en-US', functionName: 'f', aliasSet: null, role: 'ADMIN' });
      expect(r).toEqual({ ok: false, kind: 'unavailable', reason: `HTTP ${status}` });
    }
  });

  it('超时（AbortError）→ unavailable，不抛', async () => {
    global.fetch = vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const r = await launchRunnerJob({ tenantId: 't', source: 's', input: {}, locale: 'en-US', functionName: 'f', aliasSet: null, role: 'ADMIN' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('unavailable');
  });
});
