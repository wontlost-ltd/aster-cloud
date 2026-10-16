import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * proxyLlmSse（/api/llm/generate + /api/llm/suggest 共用）AI 配额门控 + 成功记账回归。
 *
 * 与 complete 路径同一缺陷：SSE 代理此前不检查配额且成功调用不记账。本测试锁定：
 * quota 拒绝 → 直接返回、不 fetch 上游；quota 放行 + 上游 2xx → 转发 SSE 流并记一笔 success
 * （驱动 checkAiQuota 的月配额/速率计数）。
 */

const { mockAuth, mockCheckAiQuota, mockRecordAiUsage, mockMarkFailed, mockSign, mockResolveByok, mockInjectByok } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockMarkFailed: vi.fn(),
  mockCheckAiQuota: vi.fn(),
  mockRecordAiUsage: vi.fn(),
  mockSign: vi.fn(),
  mockResolveByok: vi.fn(),
  mockInjectByok: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/ai-quota', () => ({
  checkAiQuota: mockCheckAiQuota,
  recordAiUsage: mockRecordAiUsage,
  markAiUsageFailed: mockMarkFailed,
}));
vi.mock('@/lib/api-signing', () => ({ signInternalCallerHeaders: mockSign }));
vi.mock('@/lib/byok-envelope', () => ({
  resolveByokEnvelope: mockResolveByok,
  injectByokEnvelope: mockInjectByok,
}));

function req(): Request {
  return new Request('http://cloud.test/api/llm/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal: 'x' }),
  });
}

/**
 * 消费整条 SSE 流——记账在**第一个 chunk** 到达时触发（issue #441），
 * 不读流就不会记账，正如真实的"用户秒取消"场景。
 */
async function drain(res: Response): Promise<string> {
  if (!res.body) return '';
  return await new Response(res.body).text();
}

function sseStreamResponse(): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('event: delta\ndata: hi\n\n'));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('proxyLlmSse — AI 配额门控 + 成功记账', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    mockAuth.mockReset();
    mockCheckAiQuota.mockReset();
    mockRecordAiUsage.mockReset().mockResolvedValue(undefined);
    mockMarkFailed.mockReset().mockResolvedValue(undefined);
    mockSign.mockReset().mockResolvedValue({ 'X-Internal-Caller': 'cloud-bff' });
    mockResolveByok.mockReset().mockResolvedValue(null);
    mockInjectByok.mockReset().mockImplementation((raw: string) => ({ body: raw, injected: false }));
    globalThis.fetch = vi.fn().mockResolvedValue(sseStreamResponse());
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('未登录 → 401，不检查配额也不转发', async () => {
    mockAuth.mockResolvedValue(null);
    const { proxyLlmSse } = await import('@/lib/llm-sse-proxy');
    const res = await proxyLlmSse(req() as never, { upstreamPath: '/api/v1/ai/generate' });
    expect(res.status).toBe(401);
    expect(mockCheckAiQuota).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('配额用尽 → 402，不 fetch 上游、不记账', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockCheckAiQuota.mockResolvedValue({
      allowed: false,
      reason: 'ai_quota_exhausted',
      message: '本月 AI 配额已用尽',
    });
    const { proxyLlmSse } = await import('@/lib/llm-sse-proxy');
    const res = await proxyLlmSse(req() as never, { upstreamPath: '/api/v1/ai/generate' });
    expect(res.status).toBe(402);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockRecordAiUsage).not.toHaveBeenCalled();
  });

  it('速率超限 → 429 + Retry-After，不转发', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockCheckAiQuota.mockResolvedValue({
      allowed: false,
      reason: 'ai_rate_limited',
      message: '太频繁',
      retryAfterSec: 60,
    });
    const { proxyLlmSse } = await import('@/lib/llm-sse-proxy');
    const res = await proxyLlmSse(req() as never, { upstreamPath: '/api/v1/ai/generate' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('放行 + 上游 2xx → 转发 SSE 流并记一笔 generate success', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });
    const { proxyLlmSse } = await import('@/lib/llm-sse-proxy');
    const res = await proxyLlmSse(req() as never, { upstreamPath: '/api/v1/ai/generate' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    // ★记账在首字节到达时触发，故须先消费流（真实客户端行为）。
    expect(mockRecordAiUsage).not.toHaveBeenCalled();
    expect(await drain(res)).toContain('data: hi');
    expect(mockRecordAiUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordAiUsage.mock.calls[0][0]).toMatchObject({
      userId: 'user-1',
      callKind: 'generate',
      status: 'success',
      usedByok: false,
    });
  });

  it('suggest 路径 → callKind 记为 suggest', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });
    const { proxyLlmSse } = await import('@/lib/llm-sse-proxy');
    const res = await proxyLlmSse(req() as never, { upstreamPath: '/api/v1/ai/suggest' });
    expect(res.status).toBe(200);
    await drain(res);
    expect(mockRecordAiUsage.mock.calls[0][0]).toMatchObject({ callKind: 'suggest' });
  });

  it('★用户秒取消（流建立但零产出）→ 不记账（issue #441）', async () => {
    // 核心回归：此前上游 2xx 响应头一到就乐观记 success——但 2xx 只说明上游**接受了请求**，
    // 流尚未转发也未产出任何内容。用户秒取消会让一次零产出的调用计入成功配额。
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });
    // 上游 2xx 但流**永不产出**（模拟建立后即被中断）
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(new ReadableStream({ start() { /* 不 enqueue、不 close */ } }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    );

    const { proxyLlmSse } = await import('@/lib/llm-sse-proxy');
    const res = await proxyLlmSse(req() as never, { upstreamPath: '/api/v1/ai/generate' });
    expect(res.status).toBe(200);
    // 客户端未读到任何内容就断开 —— 不得记账
    await res.body?.cancel();
    expect(mockRecordAiUsage).not.toHaveBeenCalled();
  });

  describe('★没到达 provider：HTTP 200 但只有 error 帧 → 不记账（#470）', () => {
    // aster-api 在 200 下用单条 error 帧报告这些失败；第一个字节就是这条 error。
    const cases: Array<[string, string]> = [
      ['未配置 key', 'data: {"type":"error","error":"未配置 LLM API Key"}\n\n'],
      ['BYOK 凭证无效', 'data: {"type":"error","error":"BYOK 凭证无效: bad"}\n\n'],
      ['连不上 provider', 'data: {"type":"error","error":"LLM 连接失败"}\n\n'],
      ['安全拒答', 'event: error\ndata: {"error":"out_of_scope","message":"超出范围","rule_id":"r1"}\n\n'],
    ];
    for (const [name, frame] of cases) {
      it(name, async () => {
        mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
        mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });
        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response(frame, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        );
        const { proxyLlmSse } = await import('@/lib/llm-sse-proxy');
        const res = await proxyLlmSse(req() as never, { upstreamPath: '/api/v1/ai/generate' });
        // 帧原样透传给前端（前端据此显示错误）
        expect(await drain(res)).toBe(frame);
        expect(mockRecordAiUsage).not.toHaveBeenCalled();
      });
    }
  });

  describe('★已到达 provider（upstream_reached）→ 记一笔，即便没有任何内容（#470）', () => {
    const REACHED = 'data: {"type":"upstream_reached"}\n\n';
    // 第三列：记账状态——到达 provider 后出现 error 帧记 api_error（仍计费，只是如实标失败）。
    const cases: Array<[string, string, 'success' | 'api_error']> = [
      ['provider 返回错误', REACHED + 'data: {"type":"error","error":"LLM API 错误 (500)"}\n\n', 'api_error'],
      ['provider 拒绝模型', REACHED + 'data: {"type":"error","error":"provider_rejected_model"}\n\n', 'api_error'],
      ['provider 沉默到读超时', REACHED + 'data: {"type":"error","error":"LLM 响应读取失败"}\n\n', 'api_error'],
      ['LLM 未生成内容', REACHED + 'data: {"type":"error","error":"LLM 未生成内容"}\n\n', 'api_error'],
      ['连上后流直接结束（用户断开）', REACHED, 'success'],
      ['中途失败（已有内容）', REACHED + 'data: {"type":"delta","data":"Rule"}\n\ndata: {"type":"error","error":"流式响应异常"}\n\n', 'api_error'],
    ];
    for (const [name, body, status] of cases) {
      it(name, async () => {
        mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
        mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });
        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        );
        const { proxyLlmSse } = await import('@/lib/llm-sse-proxy');
        const res = await proxyLlmSse(req() as never, { upstreamPath: '/api/v1/ai/generate' });
        expect(await drain(res)).toBe(body);
        await vi.waitFor(() => expect(mockRecordAiUsage).toHaveBeenCalledTimes(1));
        // 占位恒为 success（首个计费帧即入库，驱动并发配额门）；失败经定向 UPDATE 改为 api_error。
        expect(mockRecordAiUsage.mock.calls[0][0]).toMatchObject({ status: 'success', callKind: 'generate' });
        const requestId = mockRecordAiUsage.mock.calls[0][0].requestId;
        if (status === 'api_error') {
          await vi.waitFor(() => expect(mockMarkFailed).toHaveBeenCalledWith(requestId));
        } else {
          await new Promise((r) => setTimeout(r, 10));
          expect(mockMarkFailed).not.toHaveBeenCalled();
        }
      });
    }

    /** 上游先发给定帧后挂起（不 close），模拟客户端在流中途断开。 */
    const hangingAfter = (frames: string) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(frames));
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );

    it('★客户端中途断开（已到达 provider、无错误）→ 仍记一笔 success', async () => {
      mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
      mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });
      globalThis.fetch = vi.fn().mockResolvedValue(hangingAfter(REACHED + 'data: {"type":"delta","data":"Ru"}\n\n'));
      const { proxyLlmSse } = await import('@/lib/llm-sse-proxy');
      const res = await proxyLlmSse(req() as never, { upstreamPath: '/api/v1/ai/generate' });
      const reader = res.body!.getReader();
      await reader.read();
      await reader.cancel();
      await vi.waitFor(() => expect(mockRecordAiUsage).toHaveBeenCalledTimes(1));
      expect(mockRecordAiUsage.mock.calls[0][0]).toMatchObject({ status: 'success' });
    });

    it('★客户端在 error 帧之后断开 → 记一笔 api_error', async () => {
      mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
      mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });
      globalThis.fetch = vi.fn().mockResolvedValue(hangingAfter(REACHED + 'data: {"type":"error","error":"x"}\n\n'));
      const { proxyLlmSse } = await import('@/lib/llm-sse-proxy');
      const res = await proxyLlmSse(req() as never, { upstreamPath: '/api/v1/ai/generate' });
      const reader = res.body!.getReader();
      await reader.read();
      await reader.cancel();
      await vi.waitFor(() => expect(mockMarkFailed).toHaveBeenCalledTimes(1));
      expect(mockRecordAiUsage).toHaveBeenCalledTimes(1);
      expect(mockMarkFailed).toHaveBeenCalledWith(mockRecordAiUsage.mock.calls[0][0].requestId);
    });

    it('★首个计费帧即插入占位（流仍在进行），并发流立即计入配额门', async () => {
      mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
      mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });
      globalThis.fetch = vi.fn().mockResolvedValue(hangingAfter(REACHED));
      const { proxyLlmSse } = await import('@/lib/llm-sse-proxy');
      const res = await proxyLlmSse(req() as never, { upstreamPath: '/api/v1/ai/generate' });
      await res.body!.getReader().read();
      // 流尚未结束（上游挂起）就已入库
      await vi.waitFor(() => expect(mockRecordAiUsage).toHaveBeenCalledTimes(1));
      expect(mockRecordAiUsage.mock.calls[0][0]).toMatchObject({ status: 'success' });
    });

    it('★cancel 之后又 abort（两个终点先后触发）→ 只插一笔、只结算一次', async () => {
      mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
      mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });
      globalThis.fetch = vi.fn().mockResolvedValue(hangingAfter(REACHED + 'data: {"type":"error","error":"x"}\n\n'));
      const ac = new AbortController();
      const r = new Request('http://cloud.test/api/llm/generate', { method: 'POST', body: '{}', signal: ac.signal });
      const { proxyLlmSse } = await import('@/lib/llm-sse-proxy');
      const res = await proxyLlmSse(r as never, { upstreamPath: '/api/v1/ai/generate' });
      const reader = res.body!.getReader();
      await reader.read();
      await reader.cancel();
      ac.abort();
      await vi.waitFor(() => expect(mockMarkFailed).toHaveBeenCalledTimes(1));
      await new Promise((r2) => setTimeout(r2, 20));
      expect(mockRecordAiUsage).toHaveBeenCalledTimes(1);
      expect(mockMarkFailed).toHaveBeenCalledTimes(1);
    });

    it('★回填竞态：占位 → aster-api success 回填（upsert 保留首次 status）→ error 帧 → 行最终为 api_error', async () => {
      // 模拟 AiUsageRecord 一行：recordAiUsage = 首写定 status 的 upsert；markAiUsageFailed = 定向 UPDATE。
      const rows = new Map<string, { status: string; promptTokens: number }>();
      const upsert = (p: { requestId: string; status: string; promptTokens: number }) => {
        const prev = rows.get(p.requestId);
        rows.set(p.requestId, { status: prev?.status ?? p.status, promptTokens: p.promptTokens || prev?.promptTokens || 0 });
      };
      mockRecordAiUsage.mockImplementation(async (p) => upsert(p));
      mockMarkFailed.mockImplementation(async (id: string) => {
        const row = rows.get(id);
        if (row) row.status = 'api_error';
      });
      mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
      mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });

      let push!: (s: string) => void;
      let close!: () => void;
      const enc = new TextEncoder();
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(c) {
              push = (s) => c.enqueue(enc.encode(s));
              close = () => c.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      );
      const { proxyLlmSse } = await import('@/lib/llm-sse-proxy');
      const res = await proxyLlmSse(req() as never, { upstreamPath: '/api/v1/ai/generate' });
      const drained = drain(res);
      push(REACHED);
      await vi.waitFor(() => expect(mockRecordAiUsage).toHaveBeenCalledTimes(1));
      const requestId = mockRecordAiUsage.mock.calls[0][0].requestId as string;
      // aster-api 先回填 usage（恒为 success），之后才发 error 帧（「LLM 未生成内容」的真实顺序）
      upsert({ requestId, status: 'success', promptTokens: 42 });
      push('data: {"type":"error","error":"LLM 未生成内容"}\n\n');
      close();
      await drained;
      await vi.waitFor(() => expect(rows.get(requestId)?.status).toBe('api_error'));
      expect(rows.get(requestId)?.promptTokens).toBe(42);
    });

    it('★请求 signal 中止（运行时不回调 transformer.cancel 时的兜底）→ 已计费则记一笔', async () => {
      mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
      mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });
      globalThis.fetch = vi.fn().mockResolvedValue(hangingAfter(REACHED));
      const ac = new AbortController();
      const r = new Request('http://cloud.test/api/llm/generate', { method: 'POST', body: '{}', signal: ac.signal });
      const { proxyLlmSse } = await import('@/lib/llm-sse-proxy');
      const res = await proxyLlmSse(r as never, { upstreamPath: '/api/v1/ai/generate' });
      await res.body!.getReader().read();
      ac.abort();
      await vi.waitFor(() => expect(mockRecordAiUsage).toHaveBeenCalledTimes(1));
      expect(mockRecordAiUsage.mock.calls[0][0]).toMatchObject({ status: 'success' });
    });

    it('★meta + upstream_reached：占位记账的 model 为 meta 回传的实际 model（ADR 0048）', async () => {
      mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
      mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: true });
      const body = 'data: {"type":"meta","data":"gpt-4o"}\n\n' + REACHED;
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
      const { proxyLlmSse } = await import('@/lib/llm-sse-proxy');
      expect(await drain(await proxyLlmSse(req() as never, { upstreamPath: '/api/v1/ai/generate' }))).toBe(body);
      await vi.waitFor(() => expect(mockRecordAiUsage).toHaveBeenCalledTimes(1));
      expect(mockRecordAiUsage.mock.calls[0][0]).toMatchObject({ model: 'gpt-4o' });
    });

    it('旧版 api 只有 upstream_reached（无 meta）：仍记账，model 为 unknown', async () => {
      mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
      mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(REACHED, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
      const { proxyLlmSse } = await import('@/lib/llm-sse-proxy');
      await drain(await proxyLlmSse(req() as never, { upstreamPath: '/api/v1/ai/generate' }));
      await vi.waitFor(() => expect(mockRecordAiUsage).toHaveBeenCalledTimes(1));
      expect(mockRecordAiUsage.mock.calls[0][0]).toMatchObject({ model: 'unknown' });
    });

    it('repair 重试每个 attempt 各发一次 upstream_reached：仍只记一笔', async () => {
      mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
      mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });
      const body = REACHED + 'data: {"type":"delta","data":"x"}\n\n'
        + 'data: {"type":"repair_start","data":"2/3"}\n\n' + REACHED + 'data: {"type":"delta","data":"y"}\n\n';
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
      const { proxyLlmSse } = await import('@/lib/llm-sse-proxy');
      await drain(await proxyLlmSse(req() as never, { upstreamPath: '/api/v1/ai/generate' }));
      await vi.waitFor(() => expect(mockRecordAiUsage).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 20));
      expect(mockRecordAiUsage).toHaveBeenCalledTimes(1);
    });
  });

  it('★真实格式：delta 帧到达即记一笔', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });
    const body = 'data: {"type":"delta","data":"Rule"}\n\ndata: {"type":"final","data":"Rule x.","validated":true}\n\n';
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const { proxyLlmSse } = await import('@/lib/llm-sse-proxy');
    const res = await proxyLlmSse(req() as never, { upstreamPath: '/api/v1/ai/generate' });
    expect(await drain(res)).toBe(body);
    await vi.waitFor(() => expect(mockRecordAiUsage).toHaveBeenCalledTimes(1));
  });

  it('★末尾 final 没有空行收尾：流结束时记一笔', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('data: {"type":"final","data":"Module m.","validated":true}', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const { proxyLlmSse } = await import('@/lib/llm-sse-proxy');
    await drain(await proxyLlmSse(req() as never, { upstreamPath: '/api/v1/ai/generate' }));
    await vi.waitFor(() => expect(mockRecordAiUsage).toHaveBeenCalledTimes(1));
  });

  it('★多 chunk 的流只记一笔（防按 chunk 重复记账）', async () => {
    // TransformStream 的 transform 对**每个 chunk** 都会调用——不去重会把一次调用
    // 记成上千笔，比原来的「乐观多记一笔」严重得多。
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            for (let i = 0; i < 50; i++) {
              controller.enqueue(enc.encode(`event: delta\ndata: chunk-${i}\n\n`));
            }
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
    );

    const { proxyLlmSse } = await import('@/lib/llm-sse-proxy');
    const res = await proxyLlmSse(req() as never, { upstreamPath: '/api/v1/ai/generate' });
    const text = await drain(res);
    expect(text).toContain('chunk-0');
    expect(text).toContain('chunk-49');
    expect(mockRecordAiUsage).toHaveBeenCalledTimes(1);
  });

  it('★流内容原样透传，记账不得改动或吞掉任何字节', async () => {
    // 反向护栏：在流中插观察点绝不能改内容——没有这条，
    // 把 transform 写成「吞掉首个 chunk」也能让上面两条变绿。
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });

    const { proxyLlmSse } = await import('@/lib/llm-sse-proxy');
    const res = await proxyLlmSse(req() as never, { upstreamPath: '/api/v1/ai/generate' });
    expect(await drain(res)).toBe('event: delta\ndata: hi\n\n');
  });

  it('上游非 2xx → 透传错误，不记 success', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"error":"upstream"}', { status: 502, headers: { 'content-type': 'application/json' } })
    );
    const { proxyLlmSse } = await import('@/lib/llm-sse-proxy');
    const res = await proxyLlmSse(req() as never, { upstreamPath: '/api/v1/ai/generate' });
    expect(res.status).toBe(502);
    expect(mockRecordAiUsage).not.toHaveBeenCalled();
  });

  it('BYOK 用户 → checkAiQuota 收 usedByok=true、body 注入 _byok、记账 usedByok=true', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockResolveByok.mockResolvedValue({ provider: 'anthropic', apiKey: 'sk-ant', bindingId: 'b1' });
    mockInjectByok.mockImplementation((raw: string) => ({
      body: JSON.stringify({ ...JSON.parse(raw), _byok: { provider: 'anthropic', apiKey: 'sk-ant' } }),
      injected: true,
    }));
    mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: -1, limit: -1, usedByok: true });

    const { proxyLlmSse } = await import('@/lib/llm-sse-proxy');
    const res = await proxyLlmSse(req() as never, { upstreamPath: '/api/v1/ai/generate' });
    expect(res.status).toBe(200);
    expect(mockCheckAiQuota).toHaveBeenCalledWith('user-1', { usedByok: true });
    const forwardedBody = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
    expect(JSON.parse(forwardedBody)._byok).toEqual({ provider: 'anthropic', apiKey: 'sk-ant' });
    await drain(res);
    expect(mockRecordAiUsage.mock.calls[0][0]).toMatchObject({ usedByok: true });
  });
});
