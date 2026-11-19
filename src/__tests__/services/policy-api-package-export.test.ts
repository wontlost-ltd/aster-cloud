import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 策略包导出客户端（ADR 0059 P2，修订 3 P2-R8 / P2-R10）：三个端点 check / prepare / export/package，
// 只接受 cloud 的 HMAC 内部调用；export/package 成功时是 application/zip 字节，不可导出时是 200 JSON。

vi.mock('@/lib/trace-context', () => ({
  newTraceContext: () => ({ traceparent: '00-abc-def-01' }),
}));

import { PolicyApiClient, PolicyApiError, type PackageExportRequest } from '@/services/policy/policy-api';

const baseRequest: PackageExportRequest = {
  source: 'Module m.',
  locale: 'en-US',
  aliasSet: null,
  target: 'jre',
  mode: 'b',
  uiLocale: 'en',
  claimedRef: { policyId: 'p1', version: 2, status: 'APPROVED', approvedAt: '2026-11-17T08:00:00.000Z' },
};

const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
const zipResponse = (headers: Record<string, string> = {}) =>
  new Response(zipBytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="m-v2-jre-b.zip"; filename*=UTF-8''m-v2-jre-b.zip`,
      'X-Aster-Package-Sha256': 'ab'.repeat(32),
      'X-Aster-Package-Signed': 'true',
      ...headers,
    },
  });

describe('PolicyApiClient 策略包导出', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const prevKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;

  beforeEach(() => {
    process.env.ASTER_PLAN_GATE_HMAC_KEY = 'test-internal-key';
    fetchMock = vi.fn(async () => zipResponse());
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevKey === undefined) delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    else process.env.ASTER_PLAN_GATE_HMAC_KEY = prevKey;
  });

  it('checkPackageExport：POST …/export/package/check，带内部签名与超时', async () => {
    const body = {
      targets: { jre: { exportable: true, diagnostics: [], unavailable: null }, node: { exportable: false, diagnostics: [], unavailable: 'export_runtime_unavailable' } },
      defaultEntry: 'decide',
      entryCandidates: ['decide'],
    };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const res = await new PolicyApiClient('t1', 'u1').checkPackageExport(baseRequest, 2_000);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/api/v1/policies/export/package/check');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(baseRequest);
    expect((init.headers as Record<string, string>)['X-Internal-Signature']).toBeTruthy();
    expect(res).toEqual(body);
  });

  it('preparePackageExport：POST …/export/package/prepare', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ exportable: true, diagnostics: [], probeCount: 0 }), { status: 200 }));
    await new PolicyApiClient('t1', 'u1').preparePackageExport(baseRequest);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/api/v1/policies/export/package/prepare');
    expect((init.headers as Record<string, string>)['X-Internal-Signature']).toBeTruthy();
  });

  it('preparePackageExport：probesJson 保留数字原文（超出 2⁵³ 的 Long 不经 JS number 往返）', async () => {
    const text = '{"exportable":true,"diagnostics":[],"entry":"decide","probeCount":1,'
      + '"probes":{"probes":[{"entry":"decide","expected":{"ok":true,"value":9007199254740993},"input":{"d":1.0E10}}]}}';
    fetchMock.mockResolvedValue(new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const res = await new PolicyApiClient('t1', 'u1').preparePackageExport(baseRequest);
    expect(res.entry).toBe('decide');
    expect(res.probesJson).toBe(
      '{"probes":[{"entry":"decide","expected":{"ok":true,"value":9007199254740993},"input":{"d":1.0E10}}]}');
  });

  it('preparePackageExport：不可导出（无 probes）时 probesJson 为 null', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ exportable: false, diagnostics: [], probeCount: 0 }), { status: 200 }));
    const res = await new PolicyApiClient('t1', 'u1').preparePackageExport(baseRequest);
    expect(res.exportable).toBe(false);
    expect(res.probesJson).toBeNull();
  });

  it('exportPackage：zip 响应返回字节、SHA-256、文件名与签名标记', async () => {
    const res = await new PolicyApiClient('t1', 'u1').exportPackage(baseRequest);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/api/v1/policies/export/package');
    expect(JSON.parse(init.body as string)).toEqual(baseRequest);
    expect((init.headers as Record<string, string>)['X-Internal-Signature']).toBeTruthy();
    expect(res.kind).toBe('zip');
    if (res.kind !== 'zip') return;
    expect(new Uint8Array(res.bytes)).toEqual(zipBytes);
    expect(res.sha256).toBe('ab'.repeat(32));
    expect(res.signed).toBe(true);
    expect(res.filename).toBe('m-v2-jre-b.zip');
    expect(res.contentDisposition).toContain('attachment;');
  });

  it('exportPackage：filename* 优先并按 UTF-8 解码（中文模块名）', async () => {
    fetchMock.mockResolvedValue(zipResponse({
      'Content-Disposition': `attachment; filename="_-v1-jre-b.zip"; filename*=UTF-8''${encodeURIComponent('块.遮蔽-v1-jre-b')}.zip`,
      'X-Aster-Package-Signed': 'false',
    }));
    const res = await new PolicyApiClient('t1', 'u1').exportPackage(baseRequest);
    expect(res).toMatchObject({ kind: 'zip', filename: '块.遮蔽-v1-jre-b.zip', signed: false });
  });

  it('exportPackage：只有 filename 时取它；都没有时回退通用名', async () => {
    fetchMock.mockResolvedValue(zipResponse({ 'Content-Disposition': 'attachment; filename="only-ascii.zip"' }));
    expect(await new PolicyApiClient('t1', 'u1').exportPackage(baseRequest)).toMatchObject({ filename: 'only-ascii.zip' });
    fetchMock.mockResolvedValue(zipResponse({ 'Content-Disposition': '' }));
    expect(await new PolicyApiClient('t1', 'u1').exportPackage(baseRequest)).toMatchObject({ filename: 'policy-package.zip' });
  });

  it('exportPackage：200 {exportable:false} 返回 refused 与诊断', async () => {
    const diagnostics = [{ severity: 'error', code: 'E730', message: "Function 'f' declares IO capability Http; exported packages cannot perform IO", startLine: 3, startColumn: 1, endLine: 3, endColumn: 1 }];
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ exportable: false, diagnostics }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const res = await new PolicyApiClient('t1', 'u1').exportPackage(baseRequest);
    expect(res).toEqual({ kind: 'refused', diagnostics });
  });

  it('exportPackage：zip 头缺 SHA-256 视为上游错误（不把无法核对的字节交给浏览器）', async () => {
    fetchMock.mockResolvedValue(zipResponse({ 'X-Aster-Package-Sha256': '' }));
    const err = await new PolicyApiClient('t1', 'u1').exportPackage(baseRequest).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyApiError);
    expect(err).toMatchObject({ statusCode: 502, code: 'package_response_invalid' });
  });

  it.each(['', 'yes'])('exportPackage：X-Aster-Package-Signed 缺失或取值不明（%j）视为上游错误', async (signed) => {
    fetchMock.mockResolvedValue(zipResponse({ 'X-Aster-Package-Signed': signed }));
    const err = await new PolicyApiClient('t1', 'u1').exportPackage(baseRequest).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 502, code: 'package_response_invalid' });
  });

  it('exportPackage：既非 zip 也非 {exportable:false} 的 200 视为上游错误', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const err = await new PolicyApiClient('t1', 'u1').exportPackage(baseRequest).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 502, code: 'package_response_invalid' });
  });

  it.each([
    ['package_export_busy', '1'],
    ['export_signing_unavailable', undefined],
    ['export_signing_kid_unanchored', undefined],
  ])('exportPackage：503 %s 抛带 code 与 Retry-After 的 PolicyApiError', async (code, retryAfter) => {
    const body = { error: code, message: 'unavailable' };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), {
      status: 503,
      headers: retryAfter ? { 'Retry-After': retryAfter } : {},
    }));
    const err = await new PolicyApiClient('t1', 'u1').exportPackage(baseRequest).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyApiError);
    expect(err).toMatchObject({ statusCode: 503, code, details: body, retryAfter });
  });

  it('exportPackage：400 entry_required 的错误体（含 entryCandidates）保留在 details', async () => {
    const body = { error: 'entry_required', message: 'choose an entry', entryCandidates: ['a', 'b'] };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 400 }));
    const err = await new PolicyApiClient('t1', 'u1').exportPackage(baseRequest).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 400, code: 'entry_required', details: body });
  });

  it('exportPackage：超时抛 408 TIMEOUT', async () => {
    // 超时可能在 fetch 被调用之前就已触发（签名与 trace 头是异步的），先查 aborted 再挂监听
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener('abort', abort);
    }));
    const err = await new PolicyApiClient('t1', 'u1').exportPackage(baseRequest, 5).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 408, code: 'TIMEOUT' });
  });
});
