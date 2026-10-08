import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 业务角色（ADR 0042 §2.1）：词表归一规则与按租户读取。
 * 归一规则是 cloud 与 aster-api 之间的契约：角色原样作为精确匹配键，任何一项不合法整体拒绝。
 */

const m = vi.hoisted(() => ({ usersFindFirst: vi.fn(), teamMembersFindFirst: vi.fn() }));
vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      users: { findFirst: m.usersFindFirst },
      teamMembers: { findFirst: m.teamMembersFindFirst },
    },
  },
  users: { id: 'users.id' },
  teamMembers: { teamId: 'teamMembers.teamId', userId: 'teamMembers.userId' },
}));
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...c: unknown[]) => ({ op: 'and', c }),
}));

import { normalizeBusinessRoles, loadBusinessRoles, BusinessRoleError, MAX_BUSINESS_ROLES } from '@/lib/business-roles';

describe('normalizeBusinessRoles', () => {
  it('trim、去重保序、上限 16', () => {
    expect(normalizeBusinessRoles([' DPO ', 'DPO', 'CISO'])).toEqual(['DPO', 'CISO']);
    expect(() => normalizeBusinessRoles(Array.from({ length: 17 }, (_, i) => `r${i}`))).toThrow('invalid_business_role');
  });
  it('非 ASCII、空串、超 64 字符、非字符串全部拒绝', () => {
    for (const bad of [['数据保护官'], [''], ['x'.repeat(65)], [1 as unknown as string], 'DPO' as unknown as string[]]) {
      expect(() => normalizeBusinessRoles(bad)).toThrow('invalid_business_role');
    }
  });
  it('边界：恰好 16 项、恰好 64 字符、内部空格与大小写原样保留、空数组合法', () => {
    const sixteen = Array.from({ length: MAX_BUSINESS_ROLES }, (_, i) => `r${i}`);
    expect(normalizeBusinessRoles(sixteen)).toEqual(sixteen);
    expect(normalizeBusinessRoles(['x'.repeat(64)])).toEqual(['x'.repeat(64)]);
    expect(normalizeBusinessRoles(['Data Protection Officer', 'dpo', 'DPO'])).toEqual(['Data Protection Officer', 'dpo', 'DPO']);
    expect(normalizeBusinessRoles([])).toEqual([]);
  });
  it('去重后计数：17 项含重复、去重后 ≤16 → 通过', () => {
    const roles = [...Array.from({ length: 16 }, (_, i) => `r${i}`), 'r0'];
    expect(normalizeBusinessRoles(roles)).toHaveLength(16);
  });
  it('仅空白、控制字符、null 项都拒绝；错误类型为 BusinessRoleError', () => {
    for (const bad of [['   '], ['a\tb'], [null], null, undefined, { 0: 'DPO' }]) {
      expect(() => normalizeBusinessRoles(bad)).toThrow(BusinessRoleError);
    }
  });
  it('含逗号拒绝：aster-api 以逗号拼接角色（X-User-Business-Roles / HMAC canonical）', () => {
    for (const bad of [['DPO,CISO'], [','], ['DPO', 'a,b']]) {
      expect(() => normalizeBusinessRoles(bad)).toThrow(BusinessRoleError);
    }
  });
});

describe('loadBusinessRoles', () => {
  beforeEach(() => {
    m.usersFindFirst.mockReset();
    m.teamMembersFindFirst.mockReset();
  });

  it('个人租户（tenantId === userId）读 User，不查 TeamMember', async () => {
    m.usersFindFirst.mockResolvedValue({ businessRoles: ['DPO'] });
    expect(await loadBusinessRoles('u1', 'u1')).toEqual(['DPO']);
    expect(m.usersFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { op: 'eq', col: 'users.id', val: 'u1' } }));
    expect(m.teamMembersFindFirst).not.toHaveBeenCalled();
  });
  it('团队租户读 (teamId, userId) 的 TeamMember 行，不查 User', async () => {
    m.teamMembersFindFirst.mockResolvedValue({ businessRoles: ['CISO'] });
    expect(await loadBusinessRoles('u1', 't1')).toEqual(['CISO']);
    expect(m.teamMembersFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { op: 'and', c: [{ op: 'eq', col: 'teamMembers.teamId', val: 't1' }, { op: 'eq', col: 'teamMembers.userId', val: 'u1' }] },
    }));
    expect(m.usersFindFirst).not.toHaveBeenCalled();
  });
  it('无行 → []', async () => {
    m.usersFindFirst.mockResolvedValue(undefined);
    m.teamMembersFindFirst.mockResolvedValue(undefined);
    expect(await loadBusinessRoles('u1', 'u1')).toEqual([]);
    expect(await loadBusinessRoles('u1', 't1')).toEqual([]);
  });
});
