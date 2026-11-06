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

  it('上游 4xx 的 code 未登记（句子 / 未知码）：换成 http_<status>', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const error of ['编译失败：io.aster.Foo 第 3 行', 'some_internal_code']) {
      upstream(422, { error });
      const res = await POST(request());
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(body.code).toBe('http_422');
      expect(JSON.stringify(body)).not.toMatch(/编译失败|io\.aster|some_internal_code/);
    }
  });

  // 审查 Medium-1：面向用户的结构化诊断（入口不唯一的候选、模块错误、invalid_agent）按字段白名单透传
  it('上游 4xx 的结构化诊断按白名单透传：code / message / candidates，丢弃其余字段', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    upstream(400, {
      result: null,
      executionTimeMs: 0,
      error: '入口函数不唯一',
      diagnostics: [
        { code: 'ENTRY_AMBIGUOUS', message: '未指定入口函数，候选函数不唯一', candidates: ['approve', 'deny'], stack: 'at io.aster.X' },
        { code: 'MODULE_VERSION_NOT_FOUND', message: 'Module m@2 not found', candidates: ['1'], internal: { host: '10.0.0.1' } },
      ],
      code: 'missing_input_field',
      field: 'applicant.creditScore',
      decisionTrace: { secret: 'x' },
    });
    const res = await POST(request());
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body).toMatchObject({
      error: 'missing_input_field',
      code: 'missing_input_field',
      field: 'applicant.creditScore',
      diagnostics: [
        { code: 'ENTRY_AMBIGUOUS', message: '未指定入口函数，候选函数不唯一', candidates: ['approve', 'deny'] },
        { code: 'MODULE_VERSION_NOT_FOUND', message: 'Module m@2 not found', candidates: ['1'] },
      ],
    });
    expect(Object.keys(body.diagnostics[0]).sort()).toEqual(['candidates', 'code', 'message']);
    expect(JSON.stringify(body)).not.toMatch(/io\.aster|10\.0\.0\.1|decisionTrace|secret/);
  });

  it('只有诊断时 code 取首个已登记的诊断码（如 invalid_agent）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    upstream(400, { error: 'agent id too long', diagnostics: [{ code: 'invalid_agent', message: 'agent id too long', candidates: [] }] });
    const body = await (await POST(request())).json();
    expect(body.code).toBe('invalid_agent');
    expect(body.diagnostics).toEqual([{ code: 'invalid_agent', message: 'agent id too long', candidates: [] }]);
  });

  it('未登记诊断码的诊断条目整条丢弃', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    upstream(400, { diagnostics: [{ code: 'java.lang.IllegalStateException', message: 'boom' }] });
    const body = await (await POST(request())).json();
    expect(body).not.toHaveProperty('diagnostics');
  });

  it('模块诊断的 reason（aster-api#455）：已知且与 code 对应的透传，未知 / 与 code 不符的丢弃，无 reason 时不出现该字段', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    upstream(400, {
      diagnostics: [
        { code: 'MODULE_VERSION_NOT_FOUND', message: 'Module m@2 not found', candidates: ['1'], reason: 'VERSION_NOT_FOUND' },
        { code: 'MODULE_CYCLE', message: 'cycle', candidates: [], reason: 'IMPORT_CYCLE' },
        { code: 'MODULE_NOT_VISIBLE', message: 'not visible', candidates: [], reason: 'SOMETHING_NEW' },
        { code: 'MODULE_NOT_VISIBLE', message: 'not visible', candidates: [], reason: 'IMPORT_CYCLE' },
        { code: 'MODULE_NOT_VISIBLE', message: 'not visible', candidates: [], reason: 42 },
        { code: 'ENTRY_AMBIGUOUS', message: 'ambiguous', candidates: ['a', 'b'] },
      ],
    });
    const body = await (await POST(request())).json();
    expect(body.diagnostics).toEqual([
      { code: 'MODULE_VERSION_NOT_FOUND', message: 'Module m@2 not found', candidates: ['1'], reason: 'VERSION_NOT_FOUND' },
      { code: 'MODULE_CYCLE', message: 'cycle', candidates: [], reason: 'IMPORT_CYCLE' },
      { code: 'MODULE_NOT_VISIBLE', message: 'not visible', candidates: [] },
      { code: 'MODULE_NOT_VISIBLE', message: 'not visible', candidates: [] },
      { code: 'MODULE_NOT_VISIBLE', message: 'not visible', candidates: [] },
      { code: 'ENTRY_AMBIGUOUS', message: 'ambiguous', candidates: ['a', 'b'] },
    ]);
  });

  it('reason 映射：每个对外原因只在所属 code 下透传；MODULE_NOT_VISIBLE 的服务端细分原因（ADR 0015）即使 code 匹配也丢弃', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const passed: Array<[string, string]> = [
      ['IMPORT_VERSION_REQUIRED', 'VERSION_REQUIRED'],
      ['MODULE_VERSION_NOT_FOUND', 'EMPTY_PATH'],
      ['MODULE_VERSION_NOT_FOUND', 'VERSION_NOT_FOUND'],
      ['MODULE_NOT_VISIBLE', 'NOT_VISIBLE'],
      ['MODULE_CYCLE', 'IMPORT_CYCLE'],
      ['MODULE_CYCLE', 'LINK_FAILED'],
    ];
    const hidden = ['TENANT_REQUIRED', 'ALIASES_UNSUPPORTED', 'PARSE_FAILED', 'RESOLVER_UNAVAILABLE'];
    upstream(400, {
      diagnostics: [
        ...passed.map(([code, reason]) => ({ code, message: 'm', candidates: [], reason })),
        ...hidden.map((reason) => ({ code: 'MODULE_NOT_VISIBLE', message: 'm', candidates: [], reason })),
      ],
    });
    const body = await (await POST(request())).json();
    expect(body.diagnostics).toEqual([
      ...passed.map(([code, reason]) => ({ code, message: 'm', candidates: [], reason })),
      ...hidden.map(() => ({ code: 'MODULE_NOT_VISIBLE', message: 'm', candidates: [] })),
    ]);
  });

  it('上游 429：透传 Retry-After', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'too_many_requests' }), {
      status: 429, headers: { 'content-type': 'application/json', 'retry-after': '17' },
    })));
    const res = await POST(request());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('17');
    expect((await res.json()).code).toBe('too_many_requests');
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
