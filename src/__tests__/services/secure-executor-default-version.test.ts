// 默认可执行版本的选择（secure-execute 未指定版本时执行的版本）：Cedar 导出复用同一选择。
// 优先 isDefault 的 APPROVED 版本，否则最新 APPROVED 版本；都没有时为 null。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findFirst = vi.hoisted(() => vi.fn());

vi.mock('@/lib/prisma', () => ({
  db: { query: { policyVersions: { findFirst: (...a: unknown[]) => findFirst(...a) } } },
  policies: { id: {}, userId: {}, deletedAt: {} },
  policyVersions: {
    policyId: { name: 'pv.policyId' },
    version: { name: 'pv.version' },
    status: { name: 'pv.status' },
    isDefault: { name: 'pv.isDefault' },
  },
}));
vi.mock('drizzle-orm', () => ({
  eq: (col: { name: string }, v: unknown) => ({ eq: [col.name, v] }),
  and: (...c: unknown[]) => ({ and: c }),
  inArray: (col: { name: string }, v: unknown) => ({ inArray: [col.name, v] }),
  desc: (col: { name: string }) => ({ desc: col.name }),
}));
vi.mock('@/services/policy/policy-api', () => ({ createPolicyApiClient: vi.fn() }));

import { findDefaultExecutableVersion, getDefaultVersionInfo } from '@/services/security/secure-executor';

beforeEach(() => {
  findFirst.mockReset();
});

describe('findDefaultExecutableVersion', () => {
  it('prefers the APPROVED version marked isDefault', async () => {
    findFirst.mockResolvedValueOnce({ id: 'v2', version: 2 });
    expect(await findDefaultExecutableVersion('p1')).toEqual({ id: 'v2', version: 2 });
    expect(findFirst).toHaveBeenCalledTimes(1);
    const where = JSON.stringify(findFirst.mock.calls[0][0].where);
    expect(where).toContain(JSON.stringify({ eq: ['pv.policyId', 'p1'] }));
    expect(where).toContain(JSON.stringify({ eq: ['pv.status', 'APPROVED'] }));
    expect(where).toContain(JSON.stringify({ eq: ['pv.isDefault', true] }));
  });

  it('falls back to the latest APPROVED version', async () => {
    findFirst.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ id: 'v5', version: 5 });
    expect(await findDefaultExecutableVersion('p1')).toEqual({ id: 'v5', version: 5 });
    const second = findFirst.mock.calls[1][0];
    expect(JSON.stringify(second.where)).toContain(JSON.stringify({ eq: ['pv.status', 'APPROVED'] }));
    expect(JSON.stringify(second.where)).not.toContain('isDefault');
    expect(second.orderBy).toEqual([{ desc: 'pv.version' }]);
  });

  it('returns null when no version is approved (drafts are never executable)', async () => {
    findFirst.mockResolvedValue(undefined);
    expect(await findDefaultExecutableVersion('p1')).toBeNull();
  });
});

describe('getDefaultVersionInfo', () => {
  it('reports the same version secure-execute would run', async () => {
    findFirst.mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ version: 4, sourceHash: 'h4', source: null, content: 'Module m.' });
    expect(await getDefaultVersionInfo('p1')).toEqual({ version: 4, sourceHash: 'h4', source: 'Module m.' });
  });
});
