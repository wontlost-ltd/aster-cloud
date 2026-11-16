// ADR 0058 §4.6 / §4.7：团队 owner 委派、成员移除与团队删除的撤销级联，真实 Postgres。
// 全局开关经 getSetting 的 mock 控制（不写共享的 PlatformSetting 行）；会话、API key 吊销、安全事件与缓存失效 mock 掉，
// 其余（团队权限判定、路由事务、写服务 SQL）都走真实代码。
// 测试行全部带 PREFIX；授权行 id 是随机 UUID，按主体列前缀清理，审计按操作者前缀清理。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts capability-delegation

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, inArray, like, or, sql } from 'drizzle-orm';

vi.mock('server-only', () => ({}));

const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock('@/lib/platform-settings', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@/lib/platform-settings')),
  getSetting: vi.fn(async (key: string) => settings.values[key]),
}));
const session = vi.hoisted(() => ({ userId: '' }));
vi.mock('@/lib/auth', () => ({ getSession: vi.fn(async () => ({ user: { id: session.userId } })) }));
vi.mock('@/lib/api-keys', () => ({
  revokeTeamKeys: vi.fn(async () => undefined),
  refreshTeamKeySnapshots: vi.fn(async () => undefined),
}));
vi.mock('@/services/security/security-event-service', () => ({ logSecurityAdminAction: vi.fn(async () => undefined) }));
vi.mock('@/lib/cache', () => ({ invalidatePolicyCache: vi.fn(async () => undefined) }));

import { createDb } from '@/db';
import { auditLogs, capabilityGrants, capabilityTeamAllotments, teamMembers, teams, users } from '@/lib/prisma';
import { CapabilityError } from '@/lib/capabilities/errors';
import { PLATFORM_SETTING_KEYS } from '@/lib/platform-settings';
import {
  countActiveSeats,
  delegateToMember,
  grantToSubject,
  revokeGrant,
  setTeamAllotment,
} from '@/lib/capabilities/grants';
import { listGrantSources } from '@/lib/capabilities/resolve';
import { DELETE as deleteMember } from '@/app/api/teams/[teamId]/members/[memberId]/route';
import { DELETE as deleteTeam } from '@/app/api/teams/[teamId]/route';

const PREFIX = 'it-capdel-';
const CAP = 'structured_authoring' as const;
const ADMIN = `${PREFIX}admin`;
const OWNER = `${PREFIX}owner`;
const TEAM_ADMIN = `${PREFIX}tadmin`;
const ALICE = `${PREFIX}alice`;
const BOB = `${PREFIX}bob`;
const VIEWER = `${PREFIX}viewer`;
const OUTSIDER = `${PREFIX}outsider`;
const USER_IDS = [ADMIN, OWNER, TEAM_ADMIN, ALICE, BOB, VIEWER, OUTSIDER];
const TEAM = `${PREFIX}team`;
const TEAM2 = `${PREFIX}team2`;
const TEAM_IDS = [TEAM, TEAM2];
const MEMBER_ROWS = [
  { id: `${PREFIX}m-owner`, teamId: TEAM, userId: OWNER, role: 'owner' },
  { id: `${PREFIX}m-tadmin`, teamId: TEAM, userId: TEAM_ADMIN, role: 'admin' },
  { id: `${PREFIX}m-alice`, teamId: TEAM, userId: ALICE, role: 'member' },
  { id: `${PREFIX}m-bob`, teamId: TEAM, userId: BOB, role: 'member' },
  { id: `${PREFIX}m-viewer`, teamId: TEAM, userId: VIEWER, role: 'viewer' },
  { id: `${PREFIX}m2-owner`, teamId: TEAM2, userId: OWNER, role: 'owner' },
  { id: `${PREFIX}m2-alice`, teamId: TEAM2, userId: ALICE, role: 'member' },
] satisfies Array<typeof teamMembers.$inferInsert>;

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

const prefixed = (col: Parameters<typeof like>[0]) => like(col, `${PREFIX}%`);

async function resetCapabilityRows(db: Db): Promise<void> {
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
}

/** 团队与成员恢复到初始状态（团队删除、成员移除、角色调整的用例会改动它们）。 */
async function resetTeams(db: Db): Promise<void> {
  await db.delete(teamMembers).where(inArray(teamMembers.teamId, TEAM_IDS));
  await db.delete(teams).where(inArray(teams.id, TEAM_IDS));
  await db.insert(teams).values([
    { id: TEAM, name: 'Capdel Team', slug: TEAM, ownerId: OWNER },
    { id: TEAM2, name: 'Capdel Team Two', slug: TEAM2, ownerId: OWNER },
  ]);
  await db.insert(teamMembers).values(MEMBER_ROWS);
}

async function cleanup(db: Db): Promise<void> {
  await resetCapabilityRows(db);
  await db.delete(teamMembers).where(inArray(teamMembers.teamId, TEAM_IDS));
  await db.delete(teams).where(inArray(teams.id, TEAM_IDS));
  await db.delete(users).where(inArray(users.id, USER_IDS));
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CapabilityError) return e.code;
    throw e;
  }
  throw new Error('expected CapabilityError');
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('团队 owner 委派与生命周期级联（真实 Postgres）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db = createDb(undefined, { max: 4 });
  // 并发用例的第二条独立连接池：两次委派各在自己的连接上开事务，靠 lockTeamRow 而不是测试排队串行化
  const db2 = createDb(undefined, { max: 2 });

  const delegate = (userId: string, ownerId = OWNER, teamId = TEAM) =>
    delegateToMember({ capability: CAP, teamId, userId, ownerId });

  const allot = (seatCap: number, ownerGrantingEnabled = true, teamId = TEAM) =>
    setTeamAllotment({ capability: CAP, teamId, seatCap, ownerGrantingEnabled, updatedBy: ADMIN });

  const grantsOf = (where: ReturnType<typeof and>) =>
    db.select().from(capabilityGrants).where(where).orderBy(asc(capabilityGrants.grantedAt));

  const auditsFor = (action: string) =>
    db
      .select()
      .from(auditLogs)
      .where(and(prefixed(auditLogs.userId), eq(auditLogs.action, action)))
      .orderBy(asc(auditLogs.createdAt));

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
      })) as Array<typeof users.$inferInsert>,
    );
  });

  beforeEach(async () => {
    globalForDb.__asterLocalDevDb = db;
    settings.values = {
      [PLATFORM_SETTING_KEYS.STRUCTURED_AUTHORING_ENABLED]: true,
      [PLATFORM_SETTING_KEYS.STRUCTURED_AUTHORING_TEAM_DELEGATION]: true,
    };
    await resetCapabilityRows(db);
    await resetTeams(db);
  });

  afterAll(async () => {
    await cleanup(db);
    globalForDb.__asterLocalDevDb = previous;
    // drizzle-orm/postgres-js 的底层 postgres 客户端挂在 $client 上；两个池都要关，否则 vitest 进程挂起
    await Promise.all([db.$client.end(), db2.$client.end()]);
  });

  it('委派成功：source=team_owner、审计 teamId 列 = 团队；重复委派返回同一行 created:false 且不占第二个座', async () => {
    await allot(2);
    const first = await delegate(ALICE);
    expect(first.created).toBe(true);
    expect(first.grant).toMatchObject({
      capability: CAP,
      userId: ALICE,
      teamId: null,
      delegatingTeamId: TEAM,
      source: 'team_owner',
      grantedBy: OWNER,
      revokedAt: null,
    });

    const again = await delegate(ALICE);
    expect(again).toMatchObject({ created: false, grant: { id: first.grant.id } });
    expect(await countActiveSeats(db, CAP, TEAM)).toBe(1);

    const audits = await auditsFor('capability.grant');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      userId: OWNER,
      teamId: TEAM,
      resource: 'capability_grant',
      resourceId: first.grant.id,
    });
    expect(audits[0].metadata).toEqual({
      capability: CAP,
      subjectType: 'user',
      subjectId: ALICE,
      source: 'team_owner',
      delegatingTeamId: TEAM,
    });
  });

  it('two concurrent delegations for the last seat → exactly one succeeds, other seat_cap_reached', async () => {
    await allot(1);
    // 两个池先各自建好连接：否则冷连接的握手耗时会让第二个事务天然晚于第一个提交，测不到竞争
    await Promise.all([db.execute(sql`select 1`), db2.execute(sql`select 1`)]);
    // delegateToMember 同步取 db.transaction：先后切换全局实例，两次调用分别落在两个独立连接池上
    globalForDb.__asterLocalDevDb = db;
    const a = delegate(ALICE);
    globalForDb.__asterLocalDevDb = db2;
    const b = delegate(BOB);
    globalForDb.__asterLocalDevDb = db;

    const results = await Promise.allSettled([a, b]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(CapabilityError);
    expect((rejected[0].reason as CapabilityError).code).toBe('seat_cap_reached');
    expect((rejected[0].reason as CapabilityError).status).toBe(409);

    expect(await countActiveSeats(db, CAP, TEAM)).toBe(1);
    expect(await auditsFor('capability.grant')).toHaveLength(1);
  });

  it('team admin (not ownerId) gets not_team_owner', async () => {
    await allot(3);
    expect(await codeOf(delegate(ALICE, TEAM_ADMIN))).toBe('not_team_owner');
    expect(await codeOf(delegate(ALICE, OWNER, `${PREFIX}no-such-team`))).toBe('not_team_owner');
    expect(await countActiveSeats(db, CAP, TEAM)).toBe(0);
    expect(await auditsFor('capability.grant')).toEqual([]);
  });

  it('delegating to viewer → viewer_not_eligible; to non-member → not_team_member', async () => {
    await allot(3);
    expect(await codeOf(delegate(VIEWER))).toBe('viewer_not_eligible');
    expect(await codeOf(delegate(OUTSIDER))).toBe('not_team_member');
    expect(await grantsOf(prefixed(capabilityGrants.userId))).toEqual([]);
  });

  it('无额度行 / ownerGrantingEnabled=false → team_delegation_disabled；已用满 → seat_cap_reached', async () => {
    expect(await codeOf(delegate(ALICE))).toBe('team_delegation_disabled');
    await allot(1, false);
    expect(await codeOf(delegate(ALICE))).toBe('team_delegation_disabled');
    await allot(1, true);
    await delegate(ALICE);
    expect(await codeOf(delegate(BOB))).toBe('seat_cap_reached');
  });

  it('global delegation switch off → team_delegation_disabled; existing delegations stop resolving but rows stay active', async () => {
    await allot(3);
    const { grant } = await delegate(ALICE);
    expect(await listGrantSources(ALICE, CAP)).toEqual([{ kind: 'delegated', grantId: grant.id, teamId: TEAM }]);

    settings.values[PLATFORM_SETTING_KEYS.STRUCTURED_AUTHORING_TEAM_DELEGATION] = false;
    expect(await codeOf(delegate(BOB))).toBe('team_delegation_disabled');
    expect(await listGrantSources(ALICE, CAP)).toEqual([]);
    const [row] = await grantsOf(eq(capabilityGrants.id, grant.id));
    expect(row.revokedAt).toBeNull();

    // 关闭期间 owner 仍可撤销（撤销不看开关）
    const revoked = await revokeGrant({
      grantId: grant.id,
      revokedBy: OWNER,
      reason: 'manual',
      expectCapability: CAP,
      expectDelegatingTeamId: TEAM,
    });
    expect(revoked.revokedAt).toBeInstanceOf(Date);
  });

  it('owner 撤销只能撤本团队的委派行：别的团队的委派 / 平台直接授权 → grant_not_found', async () => {
    await allot(3);
    await allot(3, true, TEAM2);
    const other = await delegate(ALICE, OWNER, TEAM2);
    const direct = await grantToSubject({ capability: CAP, subject: { type: 'user', id: BOB }, grantedBy: ADMIN });
    for (const grantId of [other.grant.id, direct.grant.id]) {
      expect(
        await codeOf(
          revokeGrant({ grantId, revokedBy: OWNER, reason: 'manual', expectCapability: CAP, expectDelegatingTeamId: TEAM }),
        ),
      ).toBe('grant_not_found');
    }
    expect(await grantsOf(inArray(capabilityGrants.id, [other.grant.id, direct.grant.id]))).toEqual(
      expect.arrayContaining([expect.objectContaining({ revokedAt: null }), expect.objectContaining({ revokedAt: null })]),
    );
  });

  it('member removal revokes delegations with reason member_removed and frees the seat', async () => {
    await allot(1);
    await allot(1, true, TEAM2);
    const { grant } = await delegate(ALICE);
    const elsewhere = await delegate(ALICE, OWNER, TEAM2);
    expect(await codeOf(delegate(BOB))).toBe('seat_cap_reached');

    session.userId = OWNER;
    const res = await deleteMember(new Request(`http://localhost/api/teams/${TEAM}/members/${PREFIX}m-alice`, { method: 'DELETE' }), {
      params: Promise.resolve({ teamId: TEAM, memberId: `${PREFIX}m-alice` }),
    });
    expect(res.status).toBe(200);

    const [row] = await grantsOf(eq(capabilityGrants.id, grant.id));
    expect(row).toMatchObject({ revokedBy: OWNER, revokeReason: 'member_removed' });
    expect(row.revokedAt).toBeInstanceOf(Date);
    // 只撤本团队的委派：另一个团队对同一用户的委派不受影响
    const [kept] = await grantsOf(eq(capabilityGrants.id, elsewhere.grant.id));
    expect(kept.revokedAt).toBeNull();

    const revokes = await auditsFor('capability.revoke');
    expect(revokes).toHaveLength(1);
    expect(revokes[0]).toMatchObject({ userId: OWNER, teamId: TEAM, resourceId: grant.id });
    expect(revokes[0].metadata).toMatchObject({ reason: 'member_removed', delegatingTeamId: TEAM, subjectId: ALICE });

    expect(await countActiveSeats(db, CAP, TEAM)).toBe(0);
    expect((await delegate(BOB)).created).toBe(true);
  });

  it('team deletion revokes team grant + delegations (team_deleted) and deletes allotment, inside the same transaction', async () => {
    await allot(3);
    const teamGrant = await grantToSubject({ capability: CAP, subject: { type: 'team', id: TEAM }, grantedBy: ADMIN });
    const d1 = await delegate(ALICE);
    const d2 = await delegate(BOB);
    const otherTeam = await grantToSubject({ capability: CAP, subject: { type: 'team', id: TEAM2 }, grantedBy: ADMIN });
    const ids = [teamGrant.grant.id, d1.grant.id, d2.grant.id];
    const call = () =>
      deleteTeam(new Request(`http://localhost/api/teams/${TEAM}`, { method: 'DELETE' }), {
        params: Promise.resolve({ teamId: TEAM }),
      });
    session.userId = OWNER;

    // 1) 注入失败：让路由事务里最后的 tx.delete(teams) 抛错。抛之前在同一事务内确认级联已执行，
    //    之后断言授权、额度、成员全部回滚。
    const original = db.transaction.bind(db);
    let cascadeSeenInTx: Array<string | null> = [];
    const spy = vi.spyOn(db, 'transaction').mockImplementationOnce(((run: (tx: unknown) => Promise<unknown>) =>
      original(async (tx) => {
        const failing = new Proxy(tx, {
          get(target, prop, receiver) {
            if (prop !== 'delete') {
              const value = Reflect.get(target, prop, receiver);
              return typeof value === 'function' ? value.bind(target) : value;
            }
            return (table: unknown) => {
              if (table !== teams) return target.delete(table as typeof teamMembers);
              return {
                where: async () => {
                  const rows = await target
                    .select({ reason: capabilityGrants.revokeReason })
                    .from(capabilityGrants)
                    .where(inArray(capabilityGrants.id, ids));
                  cascadeSeenInTx = rows.map((r) => r.reason);
                  throw new Error('injected failure after revokeTeamCascade');
                },
              };
            };
          },
        });
        return run(failing);
      })) as typeof db.transaction);

    const failed = await call();
    spy.mockRestore();
    expect(failed.status).toBe(500);
    expect(cascadeSeenInTx).toEqual(['team_deleted', 'team_deleted', 'team_deleted']);
    for (const row of await grantsOf(inArray(capabilityGrants.id, ids))) {
      expect(row).toMatchObject({ revokedAt: null, revokedBy: null, revokeReason: null });
    }
    expect(await db.select().from(capabilityTeamAllotments).where(eq(capabilityTeamAllotments.teamId, TEAM))).toHaveLength(1);
    expect(await db.select().from(teams).where(eq(teams.id, TEAM))).toHaveLength(1);
    expect(await auditsFor('capability.revoke')).toEqual([]);

    // 2) 正常删除：三条撤销（team_deleted）、额度行删除、各写审计；别的团队的授权不动
    const ok = await call();
    expect(ok.status).toBe(200);
    for (const row of await grantsOf(inArray(capabilityGrants.id, ids))) {
      expect(row).toMatchObject({ revokedBy: OWNER, revokeReason: 'team_deleted' });
      expect(row.revokedAt).toBeInstanceOf(Date);
    }
    const [other] = await grantsOf(eq(capabilityGrants.id, otherTeam.grant.id));
    expect(other.revokedAt).toBeNull();
    expect(await db.select().from(capabilityTeamAllotments).where(eq(capabilityTeamAllotments.teamId, TEAM))).toEqual([]);

    const revokes = await auditsFor('capability.revoke');
    expect(revokes.map((a) => a.resourceId).sort()).toEqual([...ids].sort());
    for (const audit of revokes) {
      expect(audit).toMatchObject({ userId: OWNER, teamId: TEAM });
      expect(audit.metadata).toMatchObject({ reason: 'team_deleted' });
    }
    const allotAudits = (await auditsFor('capability.allotment.update')).filter((a) => a.userId === OWNER);
    expect(allotAudits).toHaveLength(1);
    expect(allotAudits[0]).toMatchObject({ teamId: TEAM, resource: 'team', resourceId: TEAM });
    expect(allotAudits[0].metadata).toEqual({
      capability: CAP,
      seatCap: { old: 3, new: null },
      ownerGrantingEnabled: { old: true, new: null },
      reason: 'team_deleted',
    });
  });

  it('demoted-to-viewer delegation still occupies a seat and resolves again after promotion', async () => {
    await allot(1);
    const { grant } = await delegate(ALICE);
    const aliceRow = eq(teamMembers.id, `${PREFIX}m-alice`);

    await db.update(teamMembers).set({ role: 'viewer' }).where(aliceRow);
    expect(await listGrantSources(ALICE, CAP)).toEqual([]);
    expect(await countActiveSeats(db, CAP, TEAM)).toBe(1);
    expect(await codeOf(delegate(BOB))).toBe('seat_cap_reached');

    await db.update(teamMembers).set({ role: 'member' }).where(aliceRow);
    expect(await listGrantSources(ALICE, CAP)).toEqual([{ kind: 'delegated', grantId: grant.id, teamId: TEAM }]);
  });
});
