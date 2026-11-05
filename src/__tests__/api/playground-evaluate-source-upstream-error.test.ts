// /api/playground/evaluate-source 上游不可达分支（#688）：fetch 异常原文（可能含内部主机名 / IP / 端口）只进服务端日志，
// 响应只给稳定 code、通用文案与 requestId。该端点可匿名调用。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api-signing', () => ({ signInternalCallerHeaders: vi.fn(async () => ({})) }));
vi.mock('@/lib/trial-metrics', () => ({
  observeTrialLatency: vi.fn(),
  recordTrialOutcome: vi.fn(),
  recordTrialUpstreamStatus: vi.fn(),
}));

import { POST } from '@/app/api/playground/evaluate-source/route';

const INTERNAL = 'connect ECONNREFUSED 10.42.7.13:8080';

function request(): NextRequest {
  const body = JSON.stringify({ source: 'Module X.', context: {} });
  return new NextRequest('http://localhost/api/playground/evaluate-source', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(body.length),
      origin: 'https://aster-lang.dev',
      'x-forwarded-for': '203.0.113.9',
    },
    body,
  });
}

describe('POST /api/playground/evaluate-source — 上游不可达', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(INTERNAL); }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('502 upstream_unreachable：不回传异常原文，带 requestId；原文与同一 requestId 只写日志', async () => {
    const res = await POST(request());
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain('10.42.7.13');
    expect(text).not.toContain('ECONNREFUSED');
    const body = JSON.parse(text);
    expect(body.error).toBe('upstream_unreachable');
    expect(body.code).toBe('upstream_unreachable');
    expect(body).not.toHaveProperty('detail');
    expect(typeof body.message).toBe('string');
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get('x-request-id')).toBe(body.requestId);
    // CORS 头仍在：营销站要能读到这个错误响应
    expect(res.headers.get('access-control-allow-origin')).toBe('https://aster-lang.dev');
    const logged = vi.mocked(console.error).mock.calls.map((c) => c.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
    expect(logged.some((line) => line.includes(body.requestId) && line.includes(INTERNAL))).toBe(true);
  });
});

// #711：上游非 2xx 的业务文案（可能是中文）不原样透传；HMAC 缺失不向匿名用户暴露环境变量名
describe('POST /api/playground/evaluate-source — 上游非 2xx 与配置缺失', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function upstream(status: number, body: unknown) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
    })));
  }

  it('上游 4xx：保留状态码与稳定 code，文案换成英文，带 requestId', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    upstream(400, { error: 'turnstile_failed', message: '人机验证失败，请刷新页面' });
    const res = await POST(request());
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ error: 'turnstile_failed', code: 'turnstile_failed' });
    expect(body.message).toBe('The policy engine rejected this trial request.');
    expect(JSON.stringify(body)).not.toMatch(/人机验证/);
    expect(res.headers.get('x-request-id')).toBe(body.requestId);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://aster-lang.dev');
  });

  it('上游 4xx 的 code 字段是句子：换成 http_<status>', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    upstream(422, { error: '编译失败：io.aster.Foo 第 3 行' });
    const res = await POST(request());
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.code).toBe('http_422');
    expect(JSON.stringify(body)).not.toMatch(/编译失败|io\.aster/);
  });

  it('上游 5xx：502 upstream_error，不回传原文', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    upstream(500, { message: 'NullPointerException at io.aster.policy.Foo' });
    const res = await POST(request());
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body).toMatchObject({ error: 'upstream_error', code: 'upstream_error' });
    expect(JSON.stringify(body)).not.toContain('NullPointerException');
  });

  it('上游 2xx 照常透传', async () => {
    upstream(200, { result: 'APPROVED', executionTimeMs: 3 });
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'APPROVED', executionTimeMs: 3 });
  });

  it('HMAC 密钥缺失：503 cloud_misconfigured，文案不含环境变量名', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const signing = await import('@/lib/api-signing');
    vi.mocked(signing.signInternalCallerHeaders).mockRejectedValueOnce(new Error('ASTER_PLAN_GATE_HMAC_KEY missing'));
    const res = await POST(request());
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.error).toBe('cloud_misconfigured');
    expect(JSON.stringify(body)).not.toContain('ASTER_PLAN_GATE_HMAC_KEY');
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
