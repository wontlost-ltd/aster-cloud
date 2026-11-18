// 策略包可导出性（ADR 0059 P2，T17）：详情页据此决定「导出」菜单里的包选项。
// 走 aster-api 的 check 端点（不跑探针、不写审计），按请求体哈希缓存确定结果；失败一律「未知」且不缓存。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  check: vi.fn(),
  createClient: vi.fn(),
  compileContext: vi.fn(),
  approvalFindFirst: vi.fn(),
  nodeRuntime: vi.fn(),
}));

vi.mock('@/lib/policy-api-identity', () => ({
  createPolicyApiClientForUser: (...a: unknown[]) => h.createClient(...a),
}));
vi.mock('@/lib/execution-input', () => ({
  loadStoredVersionCompileContext: (...a: unknown[]) => h.compileContext(...a),
}));
vi.mock('@/lib/prisma', () => ({
  db: { query: { policyApprovals: { findFirst: (...a: unknown[]) => h.approvalFindFirst(...a) } } },
  policyApprovals: { versionId: { name: 'versionId' }, decision: { name: 'decision' }, createdAt: { name: 'createdAt' } },
}));
vi.mock('drizzle-orm', () => ({
  eq: (col: { name: string }, v: unknown) => ({ eq: [col.name, v] }),
  and: (...c: unknown[]) => ({ and: c }),
  desc: (col: { name: string }) => ({ desc: col.name }),
}));
vi.mock('@/lib/package-node-runtime', () => ({ nodePackageRuntime: () => h.nodeRuntime() }));

import {
  checkPackageExportability,
  clearPackageExportabilityCache,
  PACKAGE_CHECK_TIMEOUT_MS,
} from '@/lib/package-exportability';
import { PolicyApiError } from '@/services/policy/policy-api';

const policy = { id: 'p1', userId: 'u1', teamId: null };
const version = (over: Record<string, unknown> = {}) => ({
  id: 'v-row-1', version: 3, source: 'Module m.', content: 'Module m.', aliasSet: null, status: 'APPROVED', createdBy: 'u1',
  policyId: 'p1', vocabularySnapshotIds: null, sourceEnvelopeSha256: null, sourceScopesJson: null, sourceToolchainId: null,
  ...over,
});
const run = (v = version()) => checkPackageExportability({ policy, version: v, userId: 'u1' });
const target = (exportable: boolean, unavailable: string | null = null, diagnostics: unknown[] = []) => ({ exportable, unavailable, diagnostics });
const response = (over: Record<string, unknown> = {}) => ({
  targets: { jre: target(true), node: target(true) },
  defaultEntry: 'decide',
  entryCandidates: ['decide'],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  clearPackageExportabilityCache();
  h.createClient.mockResolvedValue({ checkPackageExport: h.check });
  h.compileContext.mockResolvedValue({ locale: 'en-US', vocabulary: undefined });
  h.approvalFindFirst.mockResolvedValue({ createdAt: new Date('2026-11-17T08:00:00.000Z') });
  h.nodeRuntime.mockReturnValue(null);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('checkPackageExportability', () => {
  it('以导出会提交的同一请求体（含 claimedRef 与批准时间）调用 check，并用短超时', async () => {
    h.check.mockResolvedValue(response());
    await expect(run(version({ aliasSet: '{"IF":["Wenn"]}' }))).resolves.toMatchObject({ jre: 'exportable', defaultEntry: 'decide' });
    expect(h.createClient).toHaveBeenCalledWith('u1', 'u1');
    expect(h.check).toHaveBeenCalledWith({
      source: 'Module m.', locale: 'en-US', aliasSet: { IF: ['Wenn'] }, allowStructural: true,
      mode: 'b', target: 'jre', uiLocale: 'en',
      claimedRef: { policyId: 'p1', version: 3, status: 'APPROVED', approvedAt: '2026-11-17T08:00:00.000Z' },
    }, PACKAGE_CHECK_TIMEOUT_MS);
    // 批准时间取该版本行最近一条 APPROVED 决定
    expect(h.approvalFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { and: [{ eq: ['versionId', 'v-row-1'] }, { eq: ['decision', 'APPROVED'] }] },
      orderBy: [{ desc: 'createdAt' }],
    }));
  });

  it('没有批准记录时 approvedAt 为 null', async () => {
    h.approvalFindFirst.mockResolvedValue(undefined);
    h.check.mockResolvedValue(response());
    await run();
    expect(h.check.mock.calls[0][0].claimedRef.approvedAt).toBeNull();
  });

  it('团队策略在团队租户下检查', async () => {
    h.check.mockResolvedValue(response());
    await checkPackageExportability({ policy: { ...policy, teamId: 'team1' }, version: version(), userId: 'u2' });
    expect(h.createClient).toHaveBeenCalledWith('team1', 'u2');
  });

  it('不可导出时给出该 target 的诊断', async () => {
    const diag = { severity: 'error', code: 'E730', message: 'IO', startLine: 2, startColumn: 1, endLine: 2, endColumn: 1 };
    h.check.mockResolvedValue(response({ targets: { jre: target(false, null, [diag]), node: target(false, null, [diag]) } }));
    const res = await run();
    expect(res.jre).toBe('not-exportable');
    expect(res.diagnostics.jre).toEqual([diag]);
  });

  it('多入口：defaultEntry 为 null 时带出候选', async () => {
    h.check.mockResolvedValue(response({ defaultEntry: null, entryCandidates: ['a', 'b'] }));
    await expect(run()).resolves.toMatchObject({ defaultEntry: null, entryCandidates: ['a', 'b'] });
  });

  describe('node 不可用的两种来源', () => {
    it('C3 之前 cloud 本地无法复核 Node 包：即使 check 说可导出也为 unavailable', async () => {
      h.check.mockResolvedValue(response());
      await expect(run()).resolves.toMatchObject({ jre: 'exportable', node: 'unavailable' });
    });

    it('本地可复核，但 check 给出 unavailable 码（锁文件 node 为 null）', async () => {
      h.nodeRuntime.mockReturnValue({ tsVersion: '3.3.0' });
      h.check.mockResolvedValue(response({ targets: { jre: target(true), node: target(false, 'export_runtime_unavailable') } }));
      await expect(run()).resolves.toMatchObject({ node: 'unavailable' });
    });

    it('本地可复核且 check 可导出时为 exportable；check 未给 node 项时为 unavailable', async () => {
      h.nodeRuntime.mockReturnValue({ tsVersion: '3.3.0' });
      h.check.mockResolvedValue(response());
      await expect(run()).resolves.toMatchObject({ node: 'exportable' });
      clearPackageExportabilityCache();
      h.check.mockResolvedValue(response({ targets: { jre: target(true) } }));
      await expect(run()).resolves.toMatchObject({ node: 'unavailable' });
    });
  });

  it('jre 带 unavailable 码时为 unavailable', async () => {
    h.check.mockResolvedValue(response({ targets: { jre: target(false, 'export_runtime_unavailable'), node: target(true) } }));
    await expect(run()).resolves.toMatchObject({ jre: 'unavailable' });
  });

  it('按请求体缓存确定结果，重复渲染不再请求 aster-api', async () => {
    h.check.mockResolvedValue(response());
    await run();
    await run();
    expect(h.check).toHaveBeenCalledTimes(1);
    await run(version({ source: 'Module other.' }));
    expect(h.check).toHaveBeenCalledTimes(2);
  });

  it('同一输入的并发加载共用一次请求', async () => {
    let resolve!: (v: unknown) => void;
    h.check.mockReturnValue(new Promise((r) => { resolve = r; }));
    const both = Promise.all([run(), run()]);
    await vi.waitFor(() => expect(h.check).toHaveBeenCalledTimes(1));
    resolve(response());
    const [a, b] = await both;
    expect(a.jre).toBe('exportable');
    expect(b.jre).toBe('exportable');
    expect(h.check).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['旧版 aster-api 无该端点（404）', new PolicyApiError('Not Found', 404)],
    ['开关关（404）', new PolicyApiError('Not Found', 404)],
    ['超时', new PolicyApiError('Request timeout', 408, 'TIMEOUT')],
    ['上游 5xx', new PolicyApiError('boom', 500)],
  ])('%s → jre unknown（node 在 C3 之前仍 unavailable）且不缓存', async (_label, error) => {
    h.check.mockRejectedValueOnce(error);
    await expect(run()).resolves.toMatchObject({ jre: 'unknown', node: 'unavailable', defaultEntry: null });
    h.check.mockResolvedValueOnce(response());
    await expect(run()).resolves.toMatchObject({ jre: 'exportable' });
    expect(h.check).toHaveBeenCalledTimes(2);
  });

  it('检查失败且本地可复核 Node 包时 node 为 unknown', async () => {
    h.nodeRuntime.mockReturnValue({ tsVersion: '3.3.0' });
    h.check.mockRejectedValueOnce(new PolicyApiError('boom', 500));
    await expect(run()).resolves.toMatchObject({ jre: 'unknown', node: 'unknown' });
  });

  it('诊断在边界处收窄：丢弃畸形条目，缺失的行列记 0', async () => {
    h.check.mockResolvedValue(response({ targets: { jre: target(false, null, [
      null, 'E730', { code: 7 }, { code: 'E730', message: 'IO' }, { code: 'E731', message: 'await', startLine: 2, startColumn: 4, severity: 'weird' },
    ]) } }));
    const res = await run();
    expect(res.diagnostics.jre).toEqual([
      { severity: 'error', message: 'IO', code: 'E730', startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
      { severity: 'error', message: 'await', code: 'E731', startLine: 2, startColumn: 4, endLine: 0, endColumn: 0 },
    ]);
  });

  it('响应形状不对 → unknown 且不缓存', async () => {
    h.check.mockResolvedValueOnce({ exportable: true });
    await expect(run()).resolves.toMatchObject({ jre: 'unknown' });
    h.check.mockResolvedValueOnce(response());
    await expect(run()).resolves.toMatchObject({ jre: 'exportable' });
  });

  it('编译输入加载失败（词汇不可用）→ unknown，不调用 check', async () => {
    h.compileContext.mockRejectedValue(new Error('vocabulary unavailable'));
    await expect(run()).resolves.toMatchObject({ jre: 'unknown' });
    expect(h.check).not.toHaveBeenCalled();
  });
});
