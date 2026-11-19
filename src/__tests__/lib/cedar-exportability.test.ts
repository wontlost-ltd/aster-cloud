// Cedar 可导出性（#786）：详情页据此决定是否显示「导出为 Cedar」。
// 走 aster-api 的轻量检查端点（不跑探针、不写审计），按编译输入的哈希缓存确定结果；失败一律「未知」且不缓存。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  check: vi.fn(),
  createClient: vi.fn(),
  compileContext: vi.fn(),
}));

vi.mock('@/lib/policy-api-identity', () => ({
  createPolicyApiClientForUser: (...a: unknown[]) => h.createClient(...a),
}));
vi.mock('@/lib/execution-input', () => ({
  loadStoredVersionCompileContext: (...a: unknown[]) => h.compileContext(...a),
}));

import { checkCedarExportability, clearCedarExportabilityCache, CEDAR_CHECK_TIMEOUT_MS } from '@/lib/cedar-exportability';
import { PolicyApiError } from '@/services/policy/policy-api';

const policy = { id: 'p1', userId: 'u1', teamId: null };
const version = (over: Record<string, unknown> = {}) => ({
  version: 1, source: 'Module m.', content: 'Module m.', aliasSet: null, status: 'APPROVED', createdBy: 'u1',
  policyId: 'p1', vocabularySnapshotIds: null, sourceEnvelopeSha256: null, sourceScopesJson: null, sourceToolchainId: null,
  embeddedVocabulary: null,
  ...over,
});
const run = (v = version()) => checkCedarExportability({ policy, version: v, userId: 'u1' });

beforeEach(() => {
  vi.clearAllMocks();
  clearCedarExportabilityCache();
  h.createClient.mockResolvedValue({ checkCedarExport: h.check });
  h.compileContext.mockResolvedValue({ locale: 'en-US', vocabulary: undefined });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('checkCedarExportability', () => {
  it('asks the check endpoint with the same compile input the export would send, with a short timeout', async () => {
    h.check.mockResolvedValue({ exportable: true, rules: ['decide'], diagnostics: [] });
    await expect(run(version({ aliasSet: '{"IF":["Wenn"]}' }))).resolves.toBe('exportable');
    expect(h.createClient).toHaveBeenCalledWith('u1', 'u1');
    expect(h.check).toHaveBeenCalledWith(
      { source: 'Module m.', locale: 'en-US', aliasSet: { IF: ['Wenn'] }, allowStructural: true },
      CEDAR_CHECK_TIMEOUT_MS,
    );
  });

  it('team policies are checked in the team tenant', async () => {
    h.check.mockResolvedValue({ exportable: true, rules: ['decide'], diagnostics: [] });
    await checkCedarExportability({ policy: { ...policy, teamId: 'team1' }, version: version(), userId: 'u2' });
    expect(h.createClient).toHaveBeenCalledWith('team1', 'u2');
  });

  it('not exportable when the check says so', async () => {
    h.check.mockResolvedValue({ exportable: false, rules: [], diagnostics: [{ code: 'E720', message: 'no rule has the guard request shape' }] });
    await expect(run()).resolves.toBe('not-exportable');
  });

  it('caches definite answers per compile input, so repeated page loads do not hit aster-api', async () => {
    h.check.mockResolvedValue({ exportable: false, rules: [], diagnostics: [] });
    await run();
    await run();
    expect(h.check).toHaveBeenCalledTimes(1);
    // 源码不同即不同的缓存键
    await run(version({ source: 'Module other.' }));
    expect(h.check).toHaveBeenCalledTimes(2);
  });

  it('concurrent loads of the same input share one request', async () => {
    let resolve!: (v: unknown) => void;
    h.check.mockReturnValue(new Promise((r) => { resolve = r; }));
    const both = Promise.all([run(), run()]);
    await vi.waitFor(() => expect(h.check).toHaveBeenCalledTimes(1));
    resolve({ exportable: true, rules: ['decide'], diagnostics: [] });
    await expect(both).resolves.toEqual(['exportable', 'exportable']);
    expect(h.check).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['older aster-api without the endpoint (404)', new PolicyApiError('Not Found', 404)],
    ['timeout', new PolicyApiError('Request timeout', 408, 'TIMEOUT')],
    ['upstream 5xx', new PolicyApiError('boom', 502)],
  ])('unknown (and not cached) on %s', async (_label, error) => {
    h.check.mockRejectedValue(error);
    await expect(run()).resolves.toBe('unknown');
    await expect(run()).resolves.toBe('unknown');
    expect(h.check).toHaveBeenCalledTimes(2);
  });

  it('unknown when the version vocabulary cannot be loaded (the export would refuse too)', async () => {
    h.compileContext.mockRejectedValue(new Error('vocabulary unavailable'));
    await expect(run()).resolves.toBe('unknown');
    expect(h.check).not.toHaveBeenCalled();
  });

  it('unknown on a malformed response', async () => {
    h.check.mockResolvedValue({ unexpected: true });
    await expect(run()).resolves.toBe('unknown');
  });
});
