// 策略包下载代理（ADR 0059 P2，T18）：POST /api/policies/[id]/export/package。
// 开关、限流、请求体、访问、计划门、已批准版本、入口归一的拒绝顺序；Node 包先 prepare 再在 Worker 内复核（T27）；
// zip 字节与头原样转发；
// 上游 503 已登记码透传，entry_required 透传候选，其余 502 通用文案。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getSession: vi.fn(),
  findFirst: vi.fn(),
  findExecutable: vi.fn(),
  exportPackage: vi.fn(),
  createClient: vi.fn(),
  checkRateLimit: vi.fn(),
  flag: vi.fn(),
  planHolder: vi.fn(),
  hasFeature: vi.fn(),
  loadInput: vi.fn(),
  preparePackageExport: vi.fn(),
  nodeCheck: vi.fn(),
  recordEvent: vi.fn(),
  loadLayout: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ getSession: () => h.getSession() }));
vi.mock('@/lib/policy-access', async () =>
  (await import('@/__tests__/helpers/policy-access-mock')).policyAccessModule());
vi.mock('@/services/policy/default-executable-version', () => ({
  findDefaultExecutableVersion: (...a: unknown[]) => h.findExecutable(...a),
}));
vi.mock('@/lib/policy-api-identity', () => ({
  createPolicyApiClientForUser: (...a: unknown[]) => h.createClient(...a),
}));
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: (...a: unknown[]) => h.checkRateLimit(...a),
}));
vi.mock('@/lib/platform-settings', () => ({ isPolicyPackageExportEnabled: () => h.flag() }));
vi.mock('@/lib/team-plan', () => ({ planHolderForTeam: (...a: unknown[]) => h.planHolder(...a) }));
vi.mock('@/lib/usage', () => ({ hasFeatureAccess: (...a: unknown[]) => h.hasFeature(...a) }));
vi.mock('@/lib/package-export-input', () => ({ loadPackageExportInput: (...a: unknown[]) => h.loadInput(...a) }));
vi.mock('@/lib/package-node-check', () => ({ runNodeCheck: (...a: unknown[]) => h.nodeCheck(...a) }));
vi.mock('@/lib/package-export-layout', () => ({ loadExportLayout: (...a: unknown[]) => h.loadLayout(...a) }));
vi.mock('@/lib/product-events/server', () => ({
  recordProductEventAfterResponse: (...a: unknown[]) => h.recordEvent(...a),
}));

import { POST } from '@/app/api/policies/[id]/export/package/route';
import { PolicyApiError } from '@/services/policy/policy-api';
import { RateLimitPresets } from '@/lib/rate-limit';

const { policyAccessState } = await import('@/__tests__/helpers/policy-access-mock');
const owned = (over: Record<string, unknown> = {}) => ({ id: 'p1', userId: 'u1', teamId: null, ...over });
const twoRules = 'Module m.\n\nRule allowRead given request:\n  Return true.\n\nRule allowWrite given request:\n  Return false.\n';
const claimedRef = { policyId: 'p1', version: 3, status: 'APPROVED', approvedAt: '2026-11-17T08:00:00.000Z' };
const inputRequest = { source: twoRules, locale: 'en-US', aliasSet: null, mode: 'b', claimedRef };
const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9]);
const disposition = `attachment; filename="m-v3-jre-b.zip"; filename*=UTF-8''m-v3-jre-b.zip`;
const zipResult = (over: Record<string, unknown> = {}) => ({
  kind: 'zip', bytes: zipBytes.buffer.slice(0), sha256: 'cd'.repeat(32), filename: 'm-v3-jre-b.zip',
  contentDisposition: disposition, signed: true, layout: { status: 'absent', reason: null }, ...over,
});
const nodeProbes = { probesSha256: 'ef'.repeat(32), count: 4, agreed: 4, tsVersion: '3.6.0' };
const LAYOUT = '{"v":1,"spans":[{"text":"Module m."}]}';
const preparedOk = {
  exportable: true, diagnostics: [], entry: 'allowRead', coreIr: '{}', coreIrSha256: 'aa'.repeat(32),
  positionFreeSha256: 'bb'.repeat(32), probes: { probes: [] }, probesJson: '{"probes":[]}', probesSha256: 'ef'.repeat(32),
  probeCount: 4, runtime: { cliName: '@aster-cloud/aster-lang-ts', cliVersion: '3.6.0', ecosystem: '1.0.53' },
};
const req = (body: unknown = { target: 'jre' }) => new Request('http://localhost/api/policies/p1/export/package', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.getSession.mockResolvedValue({ user: { id: 'u1' } });
  h.flag.mockResolvedValue(true);
  policyAccessState.loader = (id) => h.findFirst({ id });
  policyAccessState.teamRole = 'viewer';
  h.findFirst.mockResolvedValue(owned());
  h.checkRateLimit.mockReturnValue({ allowed: true, remaining: 19, resetAt: Date.now() + 60_000 });
  h.planHolder.mockImplementation(async (userId: string) => userId);
  h.hasFeature.mockResolvedValue(true);
  h.findExecutable.mockResolvedValue({ id: 'v-row', version: 3, source: twoRules, content: twoRules, aliasSet: null, status: 'APPROVED' });
  h.loadInput.mockResolvedValue({ request: inputRequest, source: twoRules, vocabulary: undefined });
  h.createClient.mockResolvedValue({ exportPackage: h.exportPackage, preparePackageExport: h.preparePackageExport });
  h.preparePackageExport.mockResolvedValue(preparedOk);
  h.nodeCheck.mockReturnValue({ ok: true, nodeProbes, layoutOk: true });
  h.loadLayout.mockResolvedValue({ kind: 'absent' });
  h.exportPackage.mockResolvedValue(zipResult());
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('POST /api/policies/[id]/export/package', () => {
  it('401 无会话', async () => {
    h.getSession.mockResolvedValue(null);
    expect((await POST(req(), ctx('p1'))).status).toBe(401);
    expect(h.flag).not.toHaveBeenCalled();
  });

  it('404 开关关（缺行即关），不限流、不查策略', async () => {
    h.flag.mockResolvedValue(false);
    expect((await POST(req(), ctx('p1'))).status).toBe(404);
    expect(h.checkRateLimit).not.toHaveBeenCalled();
    expect(h.findFirst).not.toHaveBeenCalled();
  });

  it('429 限流，按用户与 EVALUATE_SOURCE 计', async () => {
    h.checkRateLimit.mockReturnValue({ allowed: false, remaining: 0, resetAt: Date.now() + 1000, retryAfterSeconds: 3 });
    const res = await POST(req(), ctx('p1'));
    expect(res.status).toBe(429);
    expect(h.checkRateLimit).toHaveBeenCalledWith('policy-package-export:u1', RateLimitPresets.EVALUATE_SOURCE);
    expect(h.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ['无请求体', ''],
    ['非 JSON', '{'],
    ['未知 target', { target: 'wasm' }],
    ['缺 target', {}],
  ])('400 invalid_target：%s', async (_label, body) => {
    const res = await POST(req(body), ctx('p1'));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_target' });
    expect(h.findFirst).not.toHaveBeenCalled();
  });

  it('400 invalid_entry：entry 为空串或非字符串', async () => {
    for (const entry of ['  ', 42]) {
      const res = await POST(req({ target: 'jre', entry }), ctx('p1'));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_entry' });
    }
  });

  it('非成员 / 他人个人策略 → 404，不导出', async () => {
    h.findFirst.mockResolvedValue(owned({ userId: 'someone-else' }));
    expect((await POST(req(), ctx('p1'))).status).toBe(404);
    h.findFirst.mockResolvedValue(owned({ teamId: 't9' }));
    policyAccessState.teamRole = null;
    expect((await POST(req(), ctx('p1'))).status).toBe(404);
    expect(h.exportPackage).not.toHaveBeenCalled();
  });

  it('403 policy_export_requires_plan：free 套餐的团队 owner 是套餐持有人', async () => {
    h.findFirst.mockResolvedValue(owned({ teamId: 't9', userId: 'creator' }));
    h.planHolder.mockResolvedValue('owner-free');
    h.hasFeature.mockResolvedValue(false);
    const res = await POST(req(), ctx('p1'));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'policy_export_requires_plan', upgrade: true });
    expect(h.planHolder).toHaveBeenCalledWith('u1', 't9');
    expect(h.hasFeature).toHaveBeenCalledWith('owner-free', 'policyExport');
    expect(h.exportPackage).not.toHaveBeenCalled();
  });

  it('团队 viewer（非创建者）在付费团队下可导出（只读）', async () => {
    h.findFirst.mockResolvedValue(owned({ teamId: 't9', userId: 'creator' }));
    h.planHolder.mockResolvedValue('owner-pro');
    const res = await POST(req(), ctx('p1'));
    expect(res.status).toBe(200);
    expect(h.createClient).toHaveBeenCalledWith('t9', 'u1');
  });

  it('409 无已批准版本（草稿永不导出）', async () => {
    h.findExecutable.mockResolvedValue(null);
    const res = await POST(req(), ctx('p1'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'no executable version' });
    expect(h.exportPackage).not.toHaveBeenCalled();
  });

  it('jre 成功：zip 字节与 aster-api 的头原样转发，记录 product event', async () => {
    const res = await POST(req({ target: 'jre', uiLocale: 'de' }), ctx('p1'));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(zipBytes);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    expect(res.headers.get('Content-Disposition')).toBe(disposition);
    expect(res.headers.get('X-Aster-Package-Sha256')).toBe('cd'.repeat(32));
    expect(res.headers.get('X-Aster-Package-Signed')).toBe('true');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(h.loadInput).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), expect.objectContaining({ id: 'v-row', version: 3 }));
    expect(h.exportPackage).toHaveBeenCalledWith({ ...inputRequest, target: 'jre', uiLocale: 'de' });
    expect(h.recordEvent).toHaveBeenCalledWith('policy_package_exported', expect.objectContaining({
      userId: 'u1', properties: { target: 'jre', signed: true },
    }));
  });

  it('无签名包：X-Aster-Package-Signed=false 照转发', async () => {
    h.exportPackage.mockResolvedValue(zipResult({ signed: false }));
    const res = await POST(req(), ctx('p1'));
    expect(res.headers.get('X-Aster-Package-Signed')).toBe('false');
    expect(h.recordEvent.mock.calls[0][1].properties).toEqual({ target: 'jre', signed: false });
  });

  it('uiLocale 缺省或不支持时为 en', async () => {
    await POST(req({ target: 'jre', uiLocale: 'fr' }), ctx('p1'));
    expect(h.exportPackage.mock.calls[0][0].uiLocale).toBe('en');
  });

  it('不可导出：200 {exportable:false, diagnostics}，不记事件', async () => {
    const diagnostics = [{ severity: 'error', code: 'E734', message: 'Package size 2000000 bytes exceeds the 1048576-byte limit', startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }];
    h.exportPackage.mockResolvedValue({ kind: 'refused', diagnostics });
    const res = await POST(req(), ctx('p1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ exportable: false, diagnostics });
    expect(h.recordEvent).not.toHaveBeenCalled();
  });

  describe('entry', () => {
    it('属于该版本的规则名去空白后转发', async () => {
      await POST(req({ target: 'jre', entry: ' allowWrite ' }), ctx('p1'));
      expect(h.exportPackage.mock.calls[0][0]).toMatchObject({ entry: 'allowWrite' });
    });

    it('不属于该版本 → 400 unknown_function，不转发', async () => {
      const res = await POST(req({ target: 'jre', entry: 'deleteEverything' }), ctx('p1'));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'unknown_function' });
      expect(h.exportPackage).not.toHaveBeenCalled();
    });

    it('未给 entry 时不带该键', async () => {
      await POST(req(), ctx('p1'));
      expect(h.exportPackage.mock.calls[0][0]).not.toHaveProperty('entry');
    });

    it('上游 400 entry_required 透传候选', async () => {
      h.exportPackage.mockRejectedValue(new PolicyApiError('choose', 400, 'entry_required', undefined,
        { error: 'entry_required', entryCandidates: ['allowRead', 'allowWrite', 7] }));
      const res = await POST(req(), ctx('p1'));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'entry_required', entryCandidates: ['allowRead', 'allowWrite'] });
    });
  });

  describe('显示排版（ADR 0059 修订 4 D11）', () => {
    it('读同一版本的排版：版本 id、实际编译的源码、编译 locale 与冻结 aliasSet', async () => {
      await POST(req({ target: 'jre' }), ctx('p1'));
      expect(h.loadLayout).toHaveBeenCalledWith({ id: 'v-row', source: twoRules, locale: 'en-US', aliasSet: null });
    });

    it('版本无排版：请求体不带 layout，头为 absent', async () => {
      const res = await POST(req({ target: 'jre' }), ctx('p1'));
      expect(h.exportPackage.mock.calls[0][0]).not.toHaveProperty('layout');
      expect(res.headers.get('X-Aster-Package-Layout')).toBe('absent');
      expect(res.headers.get('X-Aster-Package-Layout-Reason')).toBeNull();
    });

    it('jre 带排版：请求体含 layout（不经 Node 复核），上游 included 原样转发；prepare 不带 layout', async () => {
      h.loadLayout.mockResolvedValue({ kind: 'included', layout: LAYOUT });
      h.exportPackage.mockResolvedValue(zipResult({ layout: { status: 'included', reason: null } }));
      const res = await POST(req({ target: 'jre' }), ctx('p1'));
      expect(res.status).toBe(200);
      expect(h.exportPackage).toHaveBeenCalledWith({ ...inputRequest, target: 'jre', uiLocale: 'en', layout: LAYOUT });
      expect(res.headers.get('X-Aster-Package-Layout')).toBe('included');
      expect(res.headers.get('X-Aster-Package-Layout-Reason')).toBeNull();
    });

    it('node 带排版且 Worker 复核通过：nodeProbes 与 layout 一起发送；prepare 与复核的请求体都不带 layout', async () => {
      h.loadLayout.mockResolvedValue({ kind: 'included', layout: LAYOUT });
      h.exportPackage.mockResolvedValue(zipResult({ layout: { status: 'included', reason: null } }));
      const res = await POST(req({ target: 'node' }), ctx('p1'));
      const sent = { ...inputRequest, target: 'node', uiLocale: 'en' };
      expect(h.preparePackageExport).toHaveBeenCalledWith(sent);
      expect(h.nodeCheck).toHaveBeenCalledWith(preparedOk, inputRequest, LAYOUT);
      expect(h.exportPackage).toHaveBeenCalledWith({ ...sent, nodeProbes, layout: LAYOUT });
      expect(res.headers.get('X-Aster-Package-Layout')).toBe('included');
    });

    it('node 且 layoutOk:false：不带 layout 照常导出，头改写为 omitted / node_display_check_failed', async () => {
      h.loadLayout.mockResolvedValue({ kind: 'included', layout: LAYOUT });
      h.nodeCheck.mockReturnValue({ ok: true, nodeProbes, layoutOk: false });
      const res = await POST(req({ target: 'node' }), ctx('p1'));
      expect(res.status).toBe(200);
      expect(h.exportPackage).toHaveBeenCalledWith({ ...inputRequest, target: 'node', uiLocale: 'en', nodeProbes });
      expect(res.headers.get('X-Aster-Package-Layout')).toBe('omitted');
      expect(res.headers.get('X-Aster-Package-Layout-Reason')).toBe('node_display_check_failed');
    });

    it.each(['layout_export_disabled', 'layout_inconsistent', 'layout_invalid'])(
      'cloud 侧省略（%s）：不发送 layout，cloud 的原因优先于上游的 absent', async (reason) => {
        h.loadLayout.mockResolvedValue({ kind: 'omitted', reason });
        const res = await POST(req({ target: 'node' }), ctx('p1'));
        expect(h.nodeCheck).toHaveBeenCalledWith(preparedOk, inputRequest, undefined);
        expect(h.exportPackage.mock.calls[0][0]).not.toHaveProperty('layout');
        expect(res.headers.get('X-Aster-Package-Layout')).toBe('omitted');
        expect(res.headers.get('X-Aster-Package-Layout-Reason')).toBe(reason);
      });

    it('上游省略（aster-api 签名前规则或锁文件）：原因原样转发', async () => {
      h.loadLayout.mockResolvedValue({ kind: 'included', layout: LAYOUT });
      for (const reason of ['display_rules_failed', 'cli_unsupported']) {
        h.exportPackage.mockResolvedValue(zipResult({ layout: { status: 'omitted', reason } }));
        const res = await POST(req({ target: 'jre' }), ctx('p1'));
        expect(res.headers.get('X-Aster-Package-Layout')).toBe('omitted');
        expect(res.headers.get('X-Aster-Package-Layout-Reason')).toBe(reason);
      }
    });
  });

  describe('target=node（T27：prepare → Worker 内复核 → 带 nodeProbes 导出）', () => {
    it('通过：用同一编译输入复核，把 nodeProbes 交给 exportPackage', async () => {
      h.exportPackage.mockResolvedValue(zipResult({ filename: 'm-v3-node-b.zip' }));
      const res = await POST(req({ target: 'node', entry: 'allowRead' }), ctx('p1'));
      expect(res.status).toBe(200);
      const sent = { ...inputRequest, target: 'node', uiLocale: 'en', entry: 'allowRead' };
      expect(h.preparePackageExport).toHaveBeenCalledWith(sent);
      expect(h.nodeCheck).toHaveBeenCalledWith(preparedOk, inputRequest, undefined);
      expect(h.exportPackage).toHaveBeenCalledWith({ ...sent, nodeProbes });
      expect(h.recordEvent.mock.calls[0][1].properties).toEqual({ target: 'node', signed: true });
    });

    it('jre 不走 prepare，也不带 nodeProbes', async () => {
      await POST(req({ target: 'jre' }), ctx('p1'));
      expect(h.preparePackageExport).not.toHaveBeenCalled();
      expect(h.nodeCheck).not.toHaveBeenCalled();
      expect(h.exportPackage.mock.calls[0][0]).not.toHaveProperty('nodeProbes');
    });

    it('本地 ts 版本与锁文件不等 → 503 export_runtime_skew，不导出', async () => {
      h.nodeCheck.mockReturnValue({ ok: false, skew: true });
      const res = await POST(req({ target: 'node' }), ctx('p1'));
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'export_runtime_skew' });
      expect(h.exportPackage).not.toHaveBeenCalled();
      expect(h.recordEvent).not.toHaveBeenCalled();
    });

    it.each(['E735', 'E739'])('%s → 200 {exportable:false, diagnostics}，不导出、不记事件', async (code) => {
      const diagnostics = [{ severity: 'error', code, message: 'x', startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }];
      h.nodeCheck.mockReturnValue({ ok: false, diagnostics });
      const res = await POST(req({ target: 'node' }), ctx('p1'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ exportable: false, diagnostics });
      expect(h.exportPackage).not.toHaveBeenCalled();
      expect(h.recordEvent).not.toHaveBeenCalled();
    });

    it('prepare 判不可导出 → 原样返回平台诊断，不复核', async () => {
      const diagnostics = [{ severity: 'error', code: 'E730', message: 'IO', startLine: 2, startColumn: 3, endLine: 2, endColumn: 9 }];
      h.preparePackageExport.mockResolvedValue({ ...preparedOk, exportable: false, diagnostics });
      const res = await POST(req({ target: 'node' }), ctx('p1'));
      expect(await res.json()).toEqual({ exportable: false, diagnostics });
      expect(h.nodeCheck).not.toHaveBeenCalled();
      expect(h.exportPackage).not.toHaveBeenCalled();
    });

    it('prepare 503 package_export_busy 照常透传', async () => {
      h.preparePackageExport.mockRejectedValue(new PolicyApiError('x', 503, 'package_export_busy', undefined, { error: 'package_export_busy' }, '1'));
      const res = await POST(req({ target: 'node' }), ctx('p1'));
      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('1');
    });

    it('复核本身抛错（平台 IR 不可读、prepare 缺字段）→ 502 package_export_failed，不导出', async () => {
      h.nodeCheck.mockImplementation(() => { throw new Error('missing fields'); });
      const res = await POST(req({ target: 'node' }), ctx('p1'));
      expect(res.status).toBe(502);
      expect(h.exportPackage).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['package_export_busy', '1'],
    ['export_signing_unavailable', undefined],
    ['export_signing_kid_unanchored', undefined],
    ['export_runtime_unavailable', undefined],
  ])('上游 503 %s 透传码与 Retry-After', async (code, retryAfter) => {
    h.exportPackage.mockRejectedValue(new PolicyApiError('internal detail host:8080', 503, code, undefined, { error: code }, retryAfter));
    const res = await POST(req(), ctx('p1'));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ code });
    expect(JSON.stringify(body)).not.toContain('host:8080');
    expect(res.headers.get('Retry-After')).toBe(retryAfter ?? null);
  });

  it('登记过的上游 4xx（别名集过大）透传码与英文文案', async () => {
    h.exportPackage.mockRejectedValue(new PolicyApiError('x', 400, 'alias_set_too_large'));
    const res = await POST(req(), ctx('p1'));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'alias_set_too_large' });
  });

  it.each([
    ['上游 500', new PolicyApiError('stack at io.aster…', 500)],
    ['未登记的 503', new PolicyApiError('x', 503, 'weird')],
    ['未登记的 400', new PolicyApiError('x', 400, 'claimed_ref_invalid')],
    ['超时', new PolicyApiError('Request timeout', 408, 'TIMEOUT')],
    ['非 PolicyApiError', new Error('boom')],
  ])('%s → 502 package_export_failed + requestId', async (_label, error) => {
    h.exportPackage.mockRejectedValue(error);
    const res = await POST(req(), ctx('p1'));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'package_export_failed' });
    expect(body.requestId).toBeTruthy();
    expect(res.headers.get('x-request-id')).toBe(body.requestId);
  });

  it('词汇不可用 → 503 vocabulary_unavailable，不导出', async () => {
    h.loadInput.mockRejectedValue(Object.assign(new Error('Domain vocabulary could not be loaded.'), {
      name: 'VersionVocabularyUnavailableError', code: 'vocabulary_unavailable',
    }));
    const res = await POST(req(), ctx('p1'));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'vocabulary_unavailable' });
    expect(h.exportPackage).not.toHaveBeenCalled();
  });
});
