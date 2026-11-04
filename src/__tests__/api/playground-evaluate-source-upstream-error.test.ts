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
