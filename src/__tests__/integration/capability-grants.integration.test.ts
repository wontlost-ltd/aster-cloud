// ADR 0058 §4.6 / §4.7 / §4.9 / §4.10：平台授权写服务（授予、撤销、团队额度）与管理端 GET，真实 Postgres。
// 全局开关经 getSetting 的 mock 打开（不写共享的 PlatformSetting 行）；requireAdmin mock 为测试管理员。
// 测试行全部带 PREFIX；授权行 id 是随机 UUID，按主体列前缀清理，审计按操作者前缀清理。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts capability-grants

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, inArray, like, or } from 'drizzle-orm';

vi.mock('server-only', () => ({}));

const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock('@/lib/platform-settings', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@/lib/platform-settings')),
  getSetting: vi.fn(async (key: string) => settings.values[key]),
}));
vi.mock('@/lib/admin-auth', () => ({ requireAdmin: vi.fn(async () => ({ userId: 'it-capgr-admin' })) }));

import { createDb } from '@/db';
import { auditLogs, capabilityGrants, capabilityTeamAllotments, teamMembers, teams, users } from '@/lib/prisma';
import { CAPABILITIES, type CapabilityKey } from '@/lib/capabilities/registry';
import { CapabilityError } from '@/lib/capabilities/errors';
import { PLATFORM_SETTING_KEYS } from '@/lib/platform-settings';
import {
  countActiveSeats,
  grantToSubject,
  revokeGrant,
  setTeamAllotment,
} from '@/lib/capabilities/grants';
import { GET } from '@/app/api/admin/capabilities/[capability]/grants/route';

const PREFIX = 'it-capgr-';
const CAP = 'structured_authoring' as const;
const ADMIN = `${PREFIX}admin`;
const ALICE = `${PREFIX}alice`;
const BOB = `${PREFIX}bob`;
const DELETED = `${PREFIX}deleted`;
const OWNER = `${PREFIX}owner`;
const VIEWER = `${PREFIX}viewer`;
const LEAVER = `${PREFIX}leaver`;
const USER_IDS = [ADMIN, ALICE, BOB, DELETED, OWNER, VIEWER, LEAVER];
const TEAM = `${PREFIX}team`;
const TEAM2 = `${PREFIX}team2`;
const TEAM_IDS = [TEAM, TEAM2];

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

const prefixed = (col: Parameters<typeof like>[0]) => like(col, `${PREFIX}%`);

async function cleanup(db: Db): Promise<void> {
  await db
    .delete(capabilityGrants)
    .where(
      or(
        prefixed(capabilityGrants.userId),
        prefixed(capabilityGrants.teamId),
        prefixed(capabilityGrants.delegatingTeamId),
      ),
    );
  await db.delete(capabilityTeamAllotments).where(prefixed(capabilityTeamAllotments.teamId));
  await db.delete(auditLogs).where(prefixed(auditLogs.userId));
  await db.delete(teamMembers).where(inArray(teamMembers.teamId, TEAM_IDS));
  await db.delete(teams).where(inArray(teams.id, TEAM_IDS));
  await db.delete(users).where(inArray(users.id, USER_IDS));
}

async function codeOf(p: Promise<unknown>): Promise<{ code: string; status: number; message: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CapabilityError) return { code: e.code, status: e.status, message: e.message };
    throw e;
  }
  throw new Error('expected CapabilityError');
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('平台授权写服务（真实 Postgres）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db = createDb(undefined, { max: 4 });

  const auditsFor = (action: string) =>
    db
      .select()
      .from(auditLogs)
      .where(and(prefixed(auditLogs.userId), eq(auditLogs.action, action)))
      .orderBy(asc(auditLogs.createdAt));

  /** 直接插一条委派行（T6 才有委派写服务），id 带前缀便于识别。 */
  const insertDelegation = (id: string, userId: string, revokedAt: Date | null = null) =>
    db.insert(capabilityGrants).values({
      id: `${PREFIX}${id}`,
      capability: CAP,
      userId,
      delegatingTeamId: TEAM,
      source: 'team_owner',
      revokedAt,
    });

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
    await cleanup(db);
    await db.insert(users).values(
      USER_IDS.map((id) => ({
        id,
        email: `${id}@example.test`,
        name: id.slice(PREFIX.length),
        plan: 'pro',
        updatedAt: new Date(),
        deletedAt: id === DELETED ? new Date() : null,
      })) as Array<typeof users.$inferInsert>,
    );
    await db.insert(teams).values([
      { id: TEAM, name: 'Capgr Team', slug: TEAM, ownerId: OWNER },
      { id: TEAM2, name: 'Capgr Team Two', slug: TEAM2, ownerId: OWNER },
    ]);
    await db.insert(teamMembers).values([
      { id: `${PREFIX}m-owner`, teamId: TEAM, userId: OWNER, role: 'owner' },
      { id: `${PREFIX}m-alice`, teamId: TEAM, userId: ALICE, role: 'member' },
      { id: `${PREFIX}m-viewer`, teamId: TEAM, userId: VIEWER, role: 'viewer' },
    ]);
  });

  beforeEach(async () => {
    settings.values = {
      [PLATFORM_SETTING_KEYS.STRUCTURED_AUTHORING_ENABLED]: true,
      [PLATFORM_SETTING_KEYS.STRUCTURED_AUTHORING_TEAM_DELEGATION]: true,
    };
    // 每个用例从干净的授权 / 额度 / 审计状态开始（只删本测试前缀的行）
    await db
      .delete(capabilityGrants)
      .where(
        or(
          prefixed(capabilityGrants.userId),
          prefixed(capabilityGrants.teamId),
          prefixed(capabilityGrants.delegatingTeamId),
        ),
      );
    await db.delete(capabilityTeamAllotments).where(prefixed(capabilityTeamAllotments.teamId));
    await db.delete(auditLogs).where(prefixed(auditLogs.userId));
  });

  afterAll(async () => {
    await cleanup(db);
    globalForDb.__asterLocalDevDb = previous;
  });

  it('授予已软删除用户 / 不存在的团队 → subject_not_found，表中无新行、无审计', async () => {
    expect(
      await codeOf(grantToSubject({ capability: CAP, subject: { type: 'user', id: DELETED }, grantedBy: ADMIN })),
    ).toMatchObject({ code: 'subject_not_found', status: 404 });
    expect(
      await codeOf(
        grantToSubject({ capability: CAP, subject: { type: 'team', id: `${PREFIX}no-such-team` }, grantedBy: ADMIN }),
      ),
    ).toMatchObject({ code: 'subject_not_found', status: 404 });
    expect(await db.select().from(capabilityGrants).where(eq(capabilityGrants.userId, DELETED))).toEqual([]);
    expect(
      await db.select().from(capabilityGrants).where(eq(capabilityGrants.teamId, `${PREFIX}no-such-team`)),
    ).toEqual([]);
    expect(await auditsFor('capability.grant')).toEqual([]);
  });

  it('授予用户：created:true 写一条精确审计；重复授予返回同一行 created:false 且审计仍只有一条', async () => {
    const first = await grantToSubject({
      capability: CAP,
      subject: { type: 'user', id: ALICE },
      grantedBy: ADMIN,
      note: '试点',
    });
    expect(first.created).toBe(true);
    expect(first.grant).toMatchObject({
      capability: CAP,
      userId: ALICE,
      teamId: null,
      delegatingTeamId: null,
      source: 'platform_admin',
      grantedBy: ADMIN,
      revokedAt: null,
      note: '试点',
    });

    const again = await grantToSubject({ capability: CAP, subject: { type: 'user', id: ALICE }, grantedBy: ADMIN });
    expect(again.created).toBe(false);
    expect(again.grant.id).toBe(first.grant.id);

    const rows = await db.select().from(capabilityGrants).where(eq(capabilityGrants.userId, ALICE));
    expect(rows).toHaveLength(1);

    const audits = await auditsFor('capability.grant');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      userId: ADMIN,
      teamId: null,
      action: 'capability.grant',
      resource: 'capability_grant',
      resourceId: first.grant.id,
    });
    expect(audits[0].metadata).toEqual({
      capability: CAP,
      subjectType: 'user',
      subjectId: ALICE,
      source: 'platform_admin',
      note: '试点',
    });
  });

  it('并发授予同一用户：只有一个 created:true，其余返回同一行，审计只有一条', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        grantToSubject({ capability: CAP, subject: { type: 'user', id: BOB }, grantedBy: ADMIN }),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.grant.id)).size).toBe(1);
    expect(await db.select().from(capabilityGrants).where(eq(capabilityGrants.userId, BOB))).toHaveLength(1);
    expect(await auditsFor('capability.grant')).toHaveLength(1);
  });

  it('用户已有委派行时，平台直接授予仍新建一条个人授权（两者唯一键不同）', async () => {
    await insertDelegation('d-alice', ALICE);
    const { grant, created } = await grantToSubject({
      capability: CAP,
      subject: { type: 'user', id: ALICE },
      grantedBy: ADMIN,
    });
    expect(created).toBe(true);
    expect(grant).toMatchObject({ userId: ALICE, delegatingTeamId: null, source: 'platform_admin' });
  });

  it('授予团队：审计 teamId 列填团队 id，metadata 无 note', async () => {
    const { grant, created } = await grantToSubject({
      capability: CAP,
      subject: { type: 'team', id: TEAM },
      grantedBy: ADMIN,
    });
    expect(created).toBe(true);
    expect(grant).toMatchObject({ teamId: TEAM, userId: null, source: 'platform_admin', note: null });
    const [audit] = await auditsFor('capability.grant');
    expect(audit).toMatchObject({ teamId: TEAM, resource: 'capability_grant', resourceId: grant.id });
    expect(audit.metadata).toEqual({ capability: CAP, subjectType: 'team', subjectId: TEAM, source: 'platform_admin' });
  });

  it('撤销：写 revoke 字段与精确审计；再撤销 / 能力不符 → grant_not_found；撤销后再授予产生新行', async () => {
    const { grant } = await grantToSubject({ capability: CAP, subject: { type: 'team', id: TEAM }, grantedBy: ADMIN });

    expect(
      await codeOf(
        revokeGrant({
          grantId: grant.id,
          revokedBy: ADMIN,
          reason: 'manual',
          expectCapability: 'other_capability' as CapabilityKey,
        }),
      ),
    ).toMatchObject({ code: 'grant_not_found', status: 404 });

    const revoked = await revokeGrant({ grantId: grant.id, revokedBy: ADMIN, reason: 'manual', expectCapability: CAP });
    expect(revoked).toMatchObject({ id: grant.id, revokedBy: ADMIN, revokeReason: 'manual' });
    expect(revoked.revokedAt).toBeInstanceOf(Date);

    const audits = await auditsFor('capability.revoke');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      userId: ADMIN,
      teamId: TEAM,
      action: 'capability.revoke',
      resource: 'capability_grant',
      resourceId: grant.id,
    });
    expect(audits[0].metadata).toEqual({
      capability: CAP,
      subjectType: 'team',
      subjectId: TEAM,
      source: 'platform_admin',
      reason: 'manual',
    });

    expect(
      await codeOf(revokeGrant({ grantId: grant.id, revokedBy: ADMIN, reason: 'manual', expectCapability: CAP })),
    ).toMatchObject({ code: 'grant_not_found' });
    expect(
      await codeOf(
        revokeGrant({ grantId: `${PREFIX}missing`, revokedBy: ADMIN, reason: 'manual', expectCapability: CAP }),
      ),
    ).toMatchObject({ code: 'grant_not_found' });
    expect(await auditsFor('capability.revoke')).toHaveLength(1);

    const regrant = await grantToSubject({ capability: CAP, subject: { type: 'team', id: TEAM }, grantedBy: ADMIN });
    expect(regrant.created).toBe(true);
    expect(regrant.grant.id).not.toBe(grant.id);
    expect(await db.select().from(capabilityGrants).where(eq(capabilityGrants.teamId, TEAM))).toHaveLength(2);
  });

  it('countActiveSeats：只计活跃且仍是该团队成员（含 viewer）的委派行', async () => {
    await insertDelegation('d-alice', ALICE);
    await insertDelegation('d-viewer', VIEWER);
    await insertDelegation('d-leaver', LEAVER); // 已不在团队
    await insertDelegation('d-bob-revoked', BOB, new Date());
    expect(await countActiveSeats(db, CAP, TEAM)).toBe(2);
    expect(await countActiveSeats(db, CAP, TEAM2)).toBe(0);
  });

  it('setTeamAllotment：新建与更新都写精确审计（old / new）', async () => {
    const created = await setTeamAllotment({
      capability: CAP,
      teamId: TEAM,
      seatCap: 3,
      ownerGrantingEnabled: true,
      updatedBy: ADMIN,
    });
    expect(created).toMatchObject({ capability: CAP, teamId: TEAM, seatCap: 3, ownerGrantingEnabled: true, updatedBy: ADMIN });

    const updated = await setTeamAllotment({
      capability: CAP,
      teamId: TEAM,
      seatCap: 5,
      ownerGrantingEnabled: false,
      updatedBy: ADMIN,
    });
    expect(updated).toMatchObject({ seatCap: 5, ownerGrantingEnabled: false });
    const rows = await db.select().from(capabilityTeamAllotments).where(eq(capabilityTeamAllotments.teamId, TEAM));
    expect(rows).toHaveLength(1);

    const audits = await auditsFor('capability.allotment.update');
    expect(audits).toHaveLength(2);
    for (const audit of audits) {
      expect(audit).toMatchObject({ userId: ADMIN, teamId: TEAM, resource: 'team', resourceId: TEAM });
    }
    expect(audits.map((a) => a.metadata)).toEqual([
      { capability: CAP, seatCap: { old: null, new: 3 }, ownerGrantingEnabled: { old: null, new: true } },
      { capability: CAP, seatCap: { old: 3, new: 5 }, ownerGrantingEnabled: { old: true, new: false } },
    ]);
  });

  it('下调座位低于已用 → seat_cap_below_active（含已用数），额度不变、无审计；等于已用可通过', async () => {
    await setTeamAllotment({ capability: CAP, teamId: TEAM, seatCap: 5, ownerGrantingEnabled: true, updatedBy: ADMIN });
    await insertDelegation('d-alice', ALICE);
    await insertDelegation('d-viewer', VIEWER);

    const err = await codeOf(
      setTeamAllotment({ capability: CAP, teamId: TEAM, seatCap: 1, ownerGrantingEnabled: true, updatedBy: ADMIN }),
    );
    expect(err).toMatchObject({ code: 'seat_cap_below_active', status: 409 });
    expect(err.message).toContain('2');
    const [row] = await db.select().from(capabilityTeamAllotments).where(eq(capabilityTeamAllotments.teamId, TEAM));
    expect(row.seatCap).toBe(5);
    expect(await auditsFor('capability.allotment.update')).toHaveLength(1);

    const exact = await setTeamAllotment({
      capability: CAP,
      teamId: TEAM,
      seatCap: 2,
      ownerGrantingEnabled: true,
      updatedBy: ADMIN,
    });
    expect(exact.seatCap).toBe(2);
  });

  it('setTeamAllotment：团队不存在 → subject_not_found；注册项不允许委派 → delegation_not_supported', async () => {
    expect(
      await codeOf(
        setTeamAllotment({
          capability: CAP,
          teamId: `${PREFIX}no-such-team`,
          seatCap: 1,
          ownerGrantingEnabled: true,
          updatedBy: ADMIN,
        }),
      ),
    ).toMatchObject({ code: 'subject_not_found', status: 404 });

    const original = CAPABILITIES.structured_authoring;
    CAPABILITIES.structured_authoring = { ...original, teamDelegation: false };
    try {
      expect(
        await codeOf(
          setTeamAllotment({ capability: CAP, teamId: TEAM, seatCap: 1, ownerGrantingEnabled: true, updatedBy: ADMIN }),
        ),
      ).toMatchObject({ code: 'delegation_not_supported', status: 400 });
    } finally {
      CAPABILITIES.structured_authoring = original;
    }
    expect(await db.select().from(capabilityTeamAllotments).where(prefixed(capabilityTeamAllotments.teamId))).toEqual(
      [],
    );
    expect(await auditsFor('capability.allotment.update')).toEqual([]);
  });

  it('GET subject=user：按 q 过滤、排除软删除用户，返回解析后的来源', async () => {
    const direct = await grantToSubject({ capability: CAP, subject: { type: 'user', id: BOB }, grantedBy: ADMIN });
    const team = await grantToSubject({ capability: CAP, subject: { type: 'team', id: TEAM }, grantedBy: ADMIN });

    const res = await GET(
      new Request(`http://localhost/api/admin/capabilities/${CAP}/grants?subject=user&q=${PREFIX}&limit=500`),
      { params: Promise.resolve({ capability: CAP }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: Array<{ id: string; email: string; name: string; sources: unknown[] }> };
    const byId = new Map(body.users.map((u) => [u.id, u]));
    expect(byId.has(DELETED)).toBe(false);
    expect(byId.get(BOB)).toEqual({
      id: BOB,
      email: `${BOB}@example.test`,
      name: 'bob',
      sources: [{ kind: 'direct', grantId: direct.grant.id }],
    });
    expect(byId.get(ALICE)?.sources).toEqual([{ kind: 'team', grantId: team.grant.id, teamId: TEAM }]);
    expect(byId.get(VIEWER)?.sources).toEqual([]);
  });

  it('GET subject=team：返回团队授权 id、额度与已用座位', async () => {
    const team = await grantToSubject({ capability: CAP, subject: { type: 'team', id: TEAM }, grantedBy: ADMIN });
    await setTeamAllotment({ capability: CAP, teamId: TEAM, seatCap: 4, ownerGrantingEnabled: false, updatedBy: ADMIN });
    await insertDelegation('d-alice', ALICE);
    await insertDelegation('d-leaver', LEAVER);

    const res = await GET(
      new Request(`http://localhost/api/admin/capabilities/${CAP}/grants?subject=team&q=${PREFIX}`),
      { params: Promise.resolve({ capability: CAP }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { teams: Array<{ id: string }> };
    const byId = new Map(body.teams.map((t) => [t.id, t]));
    expect(byId.get(TEAM)).toEqual({
      id: TEAM,
      name: 'Capgr Team',
      slug: TEAM,
      grantId: team.grant.id,
      allotment: { seatCap: 4, ownerGrantingEnabled: false },
      seatsUsed: 1,
    });
    expect(byId.get(TEAM2)).toEqual({
      id: TEAM2,
      name: 'Capgr Team Two',
      slug: TEAM2,
      grantId: null,
      allotment: null,
      seatsUsed: 0,
    });
  });
});
