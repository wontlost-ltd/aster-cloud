// ADR 0058 §4.10：GET 用户列表的 team / delegated 来源附带 teamName（一次 IN 查询）。
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/admin-auth', () => ({ requireAdmin: vi.fn() }));
vi.mock('@/lib/license-write-gate', () => ({ requireLicenseWriteOk: vi.fn() }));
vi.mock('@/lib/capabilities/grants', () => ({ countActiveSeats: vi.fn() }));
vi.mock('@/lib/capabilities/resolve', () => ({ listGrantSources: vi.fn() }));

// freshDb.select(...).from(...).where(...)：第一次是用户行（可继续 orderBy/limit），第二次是团队名查询
const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));
vi.mock('@/db/fresh-read', () => ({ freshDb: { select: selectMock } }));

import { GET } from '@/app/api/admin/capabilities/[capability]/grants/route';
import { requireAdmin } from '@/lib/admin-auth';
import { listGrantSources } from '@/lib/capabilities/resolve';

const CAP = 'structured_authoring';

describe('GET grants?subject=user 来源带团队名', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({ userId: 'admin-1' });
  });

  it('team / delegated 来源补 teamName，direct / admin 不变；团队名只查一次', async () => {
    const userRows = [{ id: 'u-1', email: 'a@x.io', name: 'A' }];
    selectMock.mockReturnValueOnce({
      from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => userRows }) }) }),
    });
    const whereTeams = vi.fn(async () => [{ id: 't-1', name: 'Alpha' }, { id: 't-2', name: 'Beta' }]);
    selectMock.mockReturnValueOnce({ from: () => ({ where: whereTeams }) });
    vi.mocked(listGrantSources).mockResolvedValue([
      { kind: 'admin' },
      { kind: 'direct', grantId: 'g-1' },
      { kind: 'team', grantId: 'g-2', teamId: 't-1' },
      { kind: 'delegated', grantId: 'g-3', teamId: 't-2' },
      { kind: 'team', grantId: 'g-4', teamId: 't-gone' },
    ]);

    const res = await GET(
      new Request(`http://localhost/api/admin/capabilities/${CAP}/grants?subject=user`),
      { params: Promise.resolve({ capability: CAP }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).users[0].sources).toEqual([
      { kind: 'admin' },
      { kind: 'direct', grantId: 'g-1' },
      { kind: 'team', grantId: 'g-2', teamId: 't-1', teamName: 'Alpha' },
      { kind: 'delegated', grantId: 'g-3', teamId: 't-2', teamName: 'Beta' },
      { kind: 'team', grantId: 'g-4', teamId: 't-gone', teamName: null },
    ]);
    expect(whereTeams).toHaveBeenCalledTimes(1);
  });
});

describe('GET grants limit 解析', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({ userId: 'admin-1' });
    vi.mocked(listGrantSources).mockResolvedValue([]);
  });

  async function limitUsed(query: string) {
    const limit = vi.fn(async (_n: number) => []);
    selectMock.mockReturnValueOnce({ from: () => ({ where: () => ({ orderBy: () => ({ limit }) }) }) });
    await GET(new Request(`http://localhost/api/admin/capabilities/${CAP}/grants?subject=user${query}`), {
      params: Promise.resolve({ capability: CAP }),
    });
    return limit.mock.calls[0]?.[0];
  }

  it.each([
    ['', 100],
    ['&limit=', 100],
    ['&limit=0', 1],
    ['&limit=501', 500],
    ['&limit=abc', 100],
    ['&limit=20', 20],
  ])('query %j → limit %i', async (query, expected) => {
    expect(await limitUsed(query)).toBe(expected);
  });
});
