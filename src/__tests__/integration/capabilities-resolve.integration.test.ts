// ADR 0058 §4.4 第 4 步：授权来源 SQL（团队成员联查、viewer 过滤、委派三重条件、撤销），真实 Postgres。
// 全局开关经 getSetting 的 mock 打开（不写共享的 PlatformSetting 行）；套餐用真实 hasFeatureAccess（种子用户为 pro）。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts capabilities-resolve

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';

vi.mock('server-only', () => ({}));

const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock('@/lib/platform-settings', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@/lib/platform-settings')),
  getSetting: vi.fn(async (key: string) => settings.values[key]),
}));

import { createDb } from '@/db';
import { capabilityGrants, capabilityTeamAllotments, teamMembers, teams, users } from '@/lib/prisma';
import { CAPABILITIES } from '@/lib/capabilities/registry';
import { PLATFORM_SETTING_KEYS } from '@/lib/platform-settings';
import { resolveEntitlement } from '@/lib/capabilities/resolve';

const PREFIX = 'it-capres-';
const CAP = 'structured_authoring' as const;
const OWNER = `${PREFIX}owner`;
const MEMBER = `${PREFIX}member`;
const ADMIN_ROLE = `${PREFIX}admin`;
const VIEWER = `${PREFIX}viewer`;
const MULTI = `${PREFIX}multi`;
const DELEGATEE = `${PREFIX}delegatee`;
const LEAVER = `${PREFIX}leaver`;
const REVOKED = `${PREFIX}revoked`;
const USER_IDS = [OWNER, MEMBER, ADMIN_ROLE, VIEWER, MULTI, DELEGATEE, LEAVER, REVOKED];
const T_GRANTED = `${PREFIX}team-granted`;
const T_OTHER = `${PREFIX}team-other`;
const T_REVOKED = `${PREFIX}team-revoked`;
const TEAM_IDS = [T_GRANTED, T_OTHER, T_REVOKED];
const G_TEAM = `${PREFIX}g-team`;
const G_DELEGATED = `${PREFIX}g-delegated`;

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

async function cleanup(db: Db): Promise<void> {
  await db.delete(capabilityGrants).where(like(capabilityGrants.id, `${PREFIX}%`));
  await db.delete(capabilityTeamAllotments).where(like(capabilityTeamAllotments.teamId, `${PREFIX}%`));
  await db.delete(teamMembers).where(inArray(teamMembers.teamId, TEAM_IDS));
  await db.delete(teams).where(inArray(teams.id, TEAM_IDS));
  await db.delete(users).where(inArray(users.id, USER_IDS));
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('resolveEntitlement 授权来源（真实 Postgres）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db = createDb(undefined, { max: 4 });

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
    await cleanup(db);
    await db.insert(users).values(
      USER_IDS.map((id) => ({ id, email: `${id}@example.test`, plan: 'pro', updatedAt: new Date() })) as Array<
        typeof users.$inferInsert
      >,
    );
    await db.insert(teams).values([
      { id: T_GRANTED, name: 'Granted', slug: T_GRANTED, ownerId: OWNER },
      { id: T_OTHER, name: 'Other', slug: T_OTHER, ownerId: OWNER },
      { id: T_REVOKED, name: 'Revoked', slug: T_REVOKED, ownerId: OWNER },
    ]);
    await db.insert(teamMembers).values([
      { id: `${PREFIX}m-owner`, teamId: T_GRANTED, userId: OWNER, role: 'owner' },
      { id: `${PREFIX}m-member`, teamId: T_GRANTED, userId: MEMBER, role: 'member' },
      { id: `${PREFIX}m-admin`, teamId: T_GRANTED, userId: ADMIN_ROLE, role: 'admin' },
      { id: `${PREFIX}m-viewer`, teamId: T_GRANTED, userId: VIEWER, role: 'viewer' },
      { id: `${PREFIX}m-multi-1`, teamId: T_GRANTED, userId: MULTI, role: 'member' },
      { id: `${PREFIX}m-multi-2`, teamId: T_OTHER, userId: MULTI, role: 'member' },
      { id: `${PREFIX}m-delegatee`, teamId: T_OTHER, userId: DELEGATEE, role: 'member' },
      { id: `${PREFIX}m-leaver`, teamId: T_GRANTED, userId: LEAVER, role: 'member' },
      { id: `${PREFIX}m-revoked`, teamId: T_REVOKED, userId: REVOKED, role: 'member' },
    ]);
    await db.insert(capabilityGrants).values([
      { id: G_TEAM, capability: CAP, teamId: T_GRANTED, source: 'platform_admin' },
      { id: G_DELEGATED, capability: CAP, userId: DELEGATEE, delegatingTeamId: T_OTHER, source: 'team_owner' },
      // 已撤销的直接授权与团队授权：永不命中
      { id: `${PREFIX}g-rev-direct`, capability: CAP, userId: REVOKED, source: 'platform_admin', revokedAt: new Date() },
      { id: `${PREFIX}g-rev-team`, capability: CAP, teamId: T_REVOKED, source: 'platform_admin', revokedAt: new Date() },
    ]);
    await db.insert(capabilityTeamAllotments).values({ capability: CAP, teamId: T_OTHER, seatCap: 5 });
  });

  beforeEach(() => {
    settings.values = {
      [PLATFORM_SETTING_KEYS.STRUCTURED_AUTHORING_ENABLED]: true,
      [PLATFORM_SETTING_KEYS.STRUCTURED_AUTHORING_TEAM_DELEGATION]: true,
    };
  });

  afterAll(async () => {
    await cleanup(db);
    globalForDb.__asterLocalDevDb = previous;
  });

  it('team grant applies to member and admin roles, not viewer', async () => {
    const teamSource = { kind: 'team', grantId: G_TEAM, teamId: T_GRANTED };
    expect(await resolveEntitlement(MEMBER, CAP, { teamId: T_GRANTED })).toEqual({ allowed: true, sources: [teamSource] });
    expect(await resolveEntitlement(ADMIN_ROLE, CAP, { teamId: T_GRANTED })).toEqual({ allowed: true, sources: [teamSource] });
    expect(await resolveEntitlement(VIEWER, CAP, { teamId: T_GRANTED })).toEqual({
      allowed: false,
      denial: 'not_granted',
      sources: [],
    });
  });

  it('team grant applies on personal resources too when plan allows', async () => {
    expect(await resolveEntitlement(MEMBER, CAP, { teamId: null })).toEqual({
      allowed: true,
      sources: [{ kind: 'team', grantId: G_TEAM, teamId: T_GRANTED }],
    });
  });

  it('member of two teams, only one granted → sources has that team only', async () => {
    const result = await resolveEntitlement(MULTI, CAP, { teamId: T_OTHER });
    expect(result).toEqual({ allowed: true, sources: [{ kind: 'team', grantId: G_TEAM, teamId: T_GRANTED }] });
  });

  it('delegated grant counts only while member, allotment row exists with ownerGrantingEnabled, and delegation switch on', async () => {
    const delegated = { allowed: true, sources: [{ kind: 'delegated', grantId: G_DELEGATED, teamId: T_OTHER }] };
    const denied = { allowed: false, denial: 'not_granted', sources: [] };
    const allotmentRow = and(
      eq(capabilityTeamAllotments.capability, CAP),
      eq(capabilityTeamAllotments.teamId, T_OTHER),
    );
    expect(await resolveEntitlement(DELEGATEE, CAP, { teamId: T_OTHER })).toEqual(delegated);

    // 1) 离队：成员行不在
    await db.delete(teamMembers).where(eq(teamMembers.id, `${PREFIX}m-delegatee`));
    try {
      expect(await resolveEntitlement(DELEGATEE, CAP, { teamId: null })).toEqual(denied);
    } finally {
      await db.insert(teamMembers).values({ id: `${PREFIX}m-delegatee`, teamId: T_OTHER, userId: DELEGATEE, role: 'member' });
    }
    expect(await resolveEntitlement(DELEGATEE, CAP, { teamId: T_OTHER })).toEqual(delegated);

    // 1b) 降为 viewer：委派暂停
    await db.update(teamMembers).set({ role: 'viewer' }).where(eq(teamMembers.id, `${PREFIX}m-delegatee`));
    try {
      expect(await resolveEntitlement(DELEGATEE, CAP, { teamId: T_OTHER })).toEqual(denied);
    } finally {
      await db.update(teamMembers).set({ role: 'member' }).where(eq(teamMembers.id, `${PREFIX}m-delegatee`));
    }

    // 2a) 团队级关闭委派
    await db.update(capabilityTeamAllotments).set({ ownerGrantingEnabled: false }).where(allotmentRow);
    try {
      expect(await resolveEntitlement(DELEGATEE, CAP, { teamId: T_OTHER })).toEqual(denied);
    } finally {
      await db.update(capabilityTeamAllotments).set({ ownerGrantingEnabled: true }).where(allotmentRow);
    }

    // 2b) 额度行不存在
    await db.delete(capabilityTeamAllotments).where(allotmentRow);
    try {
      expect(await resolveEntitlement(DELEGATEE, CAP, { teamId: T_OTHER })).toEqual(denied);
    } finally {
      await db.insert(capabilityTeamAllotments).values({ capability: CAP, teamId: T_OTHER, seatCap: 5 });
    }
    expect(await resolveEntitlement(DELEGATEE, CAP, { teamId: T_OTHER })).toEqual(delegated);

    // 3) 全局委派开关关闭
    settings.values[PLATFORM_SETTING_KEYS.STRUCTURED_AUTHORING_TEAM_DELEGATION] = false;
    expect(await resolveEntitlement(DELEGATEE, CAP, { teamId: T_OTHER })).toEqual(denied);
  });

  it('delegated row ignored when descriptor.teamDelegation is false', async () => {
    // 测试内替换注册项（不给生产代码加钩子），finally 里还原
    const original = CAPABILITIES.structured_authoring;
    CAPABILITIES.structured_authoring = { ...original, teamDelegation: false };
    try {
      expect(await resolveEntitlement(DELEGATEE, CAP, { teamId: T_OTHER })).toEqual({
        allowed: false,
        denial: 'not_granted',
        sources: [],
      });
    } finally {
      CAPABILITIES.structured_authoring = original;
    }
  });

  it('revoked grants never match', async () => {
    expect(await resolveEntitlement(REVOKED, CAP, { teamId: T_REVOKED })).toEqual({
      allowed: false,
      denial: 'not_granted',
      sources: [],
    });
  });

  it('removing the TeamMember row removes the team source on the next call', async () => {
    expect(await resolveEntitlement(LEAVER, CAP, { teamId: null })).toEqual({
      allowed: true,
      sources: [{ kind: 'team', grantId: G_TEAM, teamId: T_GRANTED }],
    });
    await db.delete(teamMembers).where(eq(teamMembers.id, `${PREFIX}m-leaver`));
    expect(await resolveEntitlement(LEAVER, CAP, { teamId: null })).toEqual({
      allowed: false,
      denial: 'not_granted',
      sources: [],
    });
  });
});
