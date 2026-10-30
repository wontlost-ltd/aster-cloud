/**
 * 团队资源的套餐口径（#672 / #677）。
 *
 * 团队能力按团队 owner 的套餐计（ADR 0015 §5：团队 key 的套餐门槛与配额池都看 owner）。
 * 加入付费团队的 Free 成员在团队资源上（团队策略的证据导出、What-If、团队页）不应再被
 * 自己的个人套餐拦住；个人资源仍按本人套餐。
 *
 * 这里只回答「按谁的套餐判定」，不做授权：调用方仍须自行校验对资源的访问权。
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, teamMembers, teams, users } from '@/lib/prisma';
import { getEffectiveLimits, type PlanType } from '@/lib/plans';
import { hasFeatureAccess } from '@/lib/usage';

/**
 * 团队资源的套餐持有人：调用者是该团队成员时为团队 owner，否则为调用者本人
 * （非成员本就无权访问团队资源，回退到本人只是让门禁保持原有口径）。
 */
export async function planHolderForTeam(userId: string, teamId: string | null | undefined): Promise<string> {
  if (!teamId) return userId;
  const membership = await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)),
    columns: { id: true },
  });
  if (!membership) return userId;
  const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId), columns: { ownerId: true } });
  return team?.ownerId ?? userId;
}

export type TeamOwnerEligibility =
  | { eligible: true }
  | { eligible: false; code: 'new_owner_plan_ineligible' }
  | { eligible: false; code: 'new_owner_seat_limit'; memberCount: number; limit: number };

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * 在事务内锁住团队行（SELECT … FOR UPDATE）。转让所有权与接受邀请都先锁它，
 * 让「成员数 vs owner 套餐上限」的判定与写入串行化，并发时不会超员（审查 L3）。
 */
export async function lockTeamRow(tx: DbClient, teamId: string): Promise<{ ownerId: string } | null> {
  const rows = await tx
    .select({ ownerId: teams.ownerId })
    .from(teams)
    .where(eq(teams.id, teamId))
    .for('update');
  return rows[0] ?? null;
}

async function memberLimitOf(client: DbClient, userId: string): Promise<number | null> {
  const user = await client.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { plan: true, priceLockedAt: true, legacyTier: true },
  });
  if (!user) return null;
  return getEffectiveLimits({
    plan: user.plan as PlanType,
    priceLockedAt: user.priceLockedAt,
    legacyTier: user.legacyTier,
  }).maxTeamMembers;
}

async function memberCountOf(client: DbClient, teamId: string): Promise<number> {
  const [{ count }] = await client
    .select({ count: sql<number>`count(*)::int` })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));
  return count;
}

/**
 * 团队还能否再加一名成员（按 owner 套餐的成员上限）。接受邀请时在锁住团队行的事务内调用：
 * 邀请时的检查挡不住「多份邀请同时被接受」（审查 L3）。
 */
export async function teamSeatAvailable(
  tx: DbClient,
  teamId: string,
  ownerId: string,
): Promise<{ ok: true } | { ok: false; memberCount: number; limit: number }> {
  const limit = await memberLimitOf(tx, ownerId);
  if (limit === null || limit === -1) return { ok: true };
  const memberCount = await memberCountOf(tx, teamId);
  return memberCount < limit ? { ok: true } : { ok: false, memberCount, limit };
}

/**
 * 用户能否成为某团队的 owner（#677）：转让后团队能力立即按新 owner 的套餐计，
 * 新 owner 必须有团队功能，且其套餐的成员上限容得下当前成员数，否则转让后团队立刻
 * 失去邀请 / 团队 key 等能力。转让路由在锁住团队行的事务内传入 tx 调用（审查 L3）。
 */
export async function checkTeamOwnerEligibility(
  userId: string,
  teamId: string,
  client: DbClient = db,
): Promise<TeamOwnerEligibility> {
  if (!(await hasFeatureAccess(userId, 'teamFeatures'))) {
    return { eligible: false, code: 'new_owner_plan_ineligible' };
  }
  const limit = await memberLimitOf(client, userId);
  if (limit === null) return { eligible: false, code: 'new_owner_plan_ineligible' };
  if (limit === -1) return { eligible: true };
  const count = await memberCountOf(client, teamId);
  return count > limit
    ? { eligible: false, code: 'new_owner_seat_limit', memberCount: count, limit }
    : { eligible: true };
}
