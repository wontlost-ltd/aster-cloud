// 团队资源的套餐口径（#672 / #677），真实 Postgres。
//
// #672：团队策略的套餐持有人是团队 owner（成员调用时）；非成员或个人策略回退到本人。
// #677：新 owner 必须有团队功能，且其套餐的成员上限容得下当前成员数。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts team-plan

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

vi.mock('server-only', () => ({}));

import { createDb } from '@/db';
import { policies, teamMembers, teams, users } from '@/lib/prisma';
import {
  checkTeamOwnerEligibility,
  lockTeamRow,
  planHolderForTeam,
  teamSeatAvailable,
} from '@/lib/team-plan';

const OWNER = 'it-tp-owner';
const FREE_MEMBER = 'it-tp-free';
const FREE_VIEWER = 'it-tp-viewer';
const OUTSIDER = 'it-tp-outsider';
const PRO_MEMBER = 'it-tp-pro';
const TEAM = 'it-tp-team';
const BIG_TEAM = 'it-tp-big';
const USER_IDS = [OWNER, FREE_MEMBER, FREE_VIEWER, OUTSIDER, PRO_MEMBER];
const TEAM_IDS = [TEAM, BIG_TEAM];

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

async function cleanup(db: Db): Promise<void> {
  await db.delete(policies).where(inArray(policies.userId, USER_IDS));
  await db.delete(teamMembers).where(inArray(teamMembers.teamId, TEAM_IDS));
  await db.delete(teams).where(inArray(teams.id, TEAM_IDS));
  await db.delete(users).where(inArray(users.id, USER_IDS));
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('团队资源套餐口径（真实 Postgres）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db = createDb(undefined, { max: 4 });

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
    await cleanup(db);
    await db.insert(users).values([
      { id: OWNER, email: 'owner@tp.example', plan: 'pro' },
      { id: FREE_MEMBER, email: 'free@tp.example', plan: 'free' },
      { id: FREE_VIEWER, email: 'viewer@tp.example', plan: 'free' },
      { id: OUTSIDER, email: 'out@tp.example', plan: 'free' },
      // 2026-06 前锁价的老 Pro：成员上限 5（LEGACY_PLAN_LIMITS）；现行 Pro 不限成员
      { id: PRO_MEMBER, email: 'pro@tp.example', plan: 'pro', priceLockedAt: new Date('2026-01-01T00:00:00Z') },
    ] as Array<typeof users.$inferInsert>);
    await db.insert(teams).values([
      { id: TEAM, name: 'TP', slug: 'it-tp-team', ownerId: OWNER },
      { id: BIG_TEAM, name: 'Big', slug: 'it-tp-big', ownerId: OWNER },
    ]);
    await db.insert(teamMembers).values([
      { id: 'it-tp-m1', teamId: TEAM, userId: OWNER, role: 'owner' },
      { id: 'it-tp-m2', teamId: TEAM, userId: FREE_MEMBER, role: 'member' },
      { id: 'it-tp-m3', teamId: TEAM, userId: FREE_VIEWER, role: 'viewer' },
      { id: 'it-tp-m4', teamId: TEAM, userId: PRO_MEMBER, role: 'admin' },
      // Big 团队 6 人：老 Pro 上限 5
      ...[OWNER, FREE_MEMBER, FREE_VIEWER, OUTSIDER, PRO_MEMBER].map((userId, i) => ({
        id: `it-tp-b${i}`, teamId: BIG_TEAM, userId, role: (i === 0 ? 'owner' : 'member') as 'owner' | 'member',
      })),
    ]);
    await db.insert(users).values({ id: 'it-tp-extra', email: 'extra@tp.example', plan: 'free' } as typeof users.$inferInsert);
    await db.insert(teamMembers).values({ id: 'it-tp-b9', teamId: BIG_TEAM, userId: 'it-tp-extra', role: 'member' });
    await db.insert(policies).values([
      { id: 'it-tp-team-policy', userId: FREE_MEMBER, teamId: TEAM, name: 't', content: 'Module it.', updatedAt: new Date() },
      { id: 'it-tp-own-policy', userId: FREE_MEMBER, name: 'p', content: 'Module it.', updatedAt: new Date() },
    ] as Array<typeof policies.$inferInsert>);
  });

  afterAll(async () => {
    await db.delete(teamMembers).where(eq(teamMembers.userId, 'it-tp-extra'));
    await db.delete(users).where(eq(users.id, 'it-tp-extra'));
    await cleanup(db);
    globalForDb.__asterLocalDevDb = previous;
  });

  it('#672 团队策略的套餐持有人是团队 owner；个人策略与非成员回退到本人', async () => {
    expect(await planHolderForTeam(FREE_MEMBER, TEAM)).toBe(OWNER);
    expect(await planHolderForTeam(FREE_MEMBER, null)).toBe(FREE_MEMBER);
    expect(await planHolderForTeam(OUTSIDER, TEAM)).toBe(OUTSIDER);
  });

  it('#677 Free 成员不能成为 owner；Pro 成员可以；成员数超出新 owner 套餐上限（老 Pro 5 人）时拒绝', async () => {
    expect(await checkTeamOwnerEligibility(FREE_MEMBER, TEAM)).toEqual({ eligible: false, code: 'new_owner_plan_ineligible' });
    expect(await checkTeamOwnerEligibility(PRO_MEMBER, TEAM)).toEqual({ eligible: true });
    expect(await checkTeamOwnerEligibility(PRO_MEMBER, BIG_TEAM)).toEqual({
      eligible: false, code: 'new_owner_seat_limit', memberCount: 6, limit: 5,
    });
  });

  it('审查 L3：事务内锁团队行后按 owner 套餐判定席位（现行 Pro 不限；老 Pro 5 人时 6 人团队已满）', async () => {
    const result = await db.transaction(async (tx) => {
      const team = await lockTeamRow(tx, BIG_TEAM);
      expect(team?.ownerId).toBe(OWNER);
      return {
        currentPro: await teamSeatAvailable(tx, BIG_TEAM, OWNER),
        legacyPro: await teamSeatAvailable(tx, BIG_TEAM, PRO_MEMBER),
        ineligibleInTx: await checkTeamOwnerEligibility(PRO_MEMBER, BIG_TEAM, tx),
      };
    });
    expect(result.currentPro).toEqual({ ok: true });
    expect(result.legacyPro).toEqual({ ok: false, memberCount: 6, limit: 5 });
    expect(result.ineligibleInTx).toMatchObject({ eligible: false, code: 'new_owner_seat_limit' });
    expect(await db.transaction((tx) => lockTeamRow(tx, 'missing-team'))).toBeNull();
  });
});
