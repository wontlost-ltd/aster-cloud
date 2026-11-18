// 详情页包选项的服务端判定（ADR 0059 P2，T19 loadPackageExportState）：
// 开关关、套餐持有人无 policyExport、没有已批准版本时返回 null 且不调 aster-api 的 check。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ flag: vi.fn(), planHolder: vi.fn(), hasFeature: vi.fn(), check: vi.fn() }));

vi.mock('@/lib/platform-settings', () => ({ isPolicyPackageExportEnabled: () => h.flag() }));
vi.mock('@/lib/team-plan', () => ({ planHolderForTeam: (...a: unknown[]) => h.planHolder(...a) }));
vi.mock('@/lib/usage', () => ({ hasFeatureAccess: (...a: unknown[]) => h.hasFeature(...a) }));
vi.mock('@/lib/package-exportability', () => ({ checkPackageExportability: (...a: unknown[]) => h.check(...a) }));

import { loadPackageExportState } from '@/lib/package-export-state';

const policy = { id: 'p1', userId: 'owner', teamId: 't1' };
const version = { id: 'v-row', version: 2, source: 'Module m.', content: 'Module m.', aliasSet: null, status: 'APPROVED', createdBy: 'owner' };
const result = (over: Record<string, unknown> = {}) => ({
  jre: 'exportable', node: 'unavailable', diagnostics: { jre: [], node: [] }, defaultEntry: 'decide', entryCandidates: ['decide'], ...over,
});
const load = (executable: unknown = version) => loadPackageExportState(policy, 'viewer', Promise.resolve(executable as never));

beforeEach(() => {
  vi.clearAllMocks();
  h.flag.mockResolvedValue(true);
  h.planHolder.mockResolvedValue('owner');
  h.hasFeature.mockResolvedValue(true);
  h.check.mockResolvedValue(result());
});

describe('loadPackageExportState', () => {
  it('开关关 → null，不查套餐、不调 check', async () => {
    h.flag.mockResolvedValue(false);
    await expect(load()).resolves.toBeNull();
    expect(h.planHolder).not.toHaveBeenCalled();
    expect(h.check).not.toHaveBeenCalled();
  });

  it('free 套餐持有人（团队 owner）→ null，不调 check', async () => {
    h.hasFeature.mockResolvedValue(false);
    await expect(load()).resolves.toBeNull();
    expect(h.planHolder).toHaveBeenCalledWith('viewer', 't1');
    expect(h.hasFeature).toHaveBeenCalledWith('owner', 'policyExport');
    expect(h.check).not.toHaveBeenCalled();
  });

  it('只有草稿（无已批准版本）→ null，不调 check', async () => {
    await expect(load(null)).resolves.toBeNull();
    expect(h.check).not.toHaveBeenCalled();
  });

  it('可导出：按导出会选中的版本检查并下发状态', async () => {
    await expect(load()).resolves.toEqual({
      jre: 'exportable', node: 'unavailable', diagnostics: { jre: [], node: [] }, entryRequired: false, entryCandidates: ['decide'],
    });
    expect(h.check).toHaveBeenCalledWith({ policy, version, userId: 'viewer' });
  });

  it('两个 target 都不可用 → null（菜单保持原样）', async () => {
    h.check.mockResolvedValue(result({ jre: 'unavailable' }));
    await expect(load()).resolves.toBeNull();
  });

  it('确定不了入口 → entryRequired', async () => {
    h.check.mockResolvedValue(result({ defaultEntry: null, entryCandidates: ['a', 'b'] }));
    await expect(load()).resolves.toMatchObject({ entryRequired: true, entryCandidates: ['a', 'b'] });
  });
});
