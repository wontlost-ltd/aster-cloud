/**
 * 团队资源的套餐口径（#672 / #677）。
 *
 * 团队能力按团队 owner 的套餐计（ADR 0015 §5：团队 key 的套餐门槛与配额池都看 owner）。
 * 加入付费团队的 Free 成员在团队资源上（团队策略的证据导出、What-If、团队页）不应再被
 * 自己的个人套餐拦住；个人资源仍按本人套餐。
 *
 * 这里只回答「按谁的套餐判定」，不做授权：调用方仍须自行校验对资源的访问权。
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, policies, teamMembers, teams, users } from '@/lib/prisma';
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

/** 策略的套餐持有人：团队策略按 {@link planHolderForTeam}，个人策略（或查不到）为调用者本人。 */
export async function planHolderForPolicy(userId: string, policyId: string): Promise<string> {
  const policy = await db.query.policies.findFirst({
    where: and(eq(policies.id, policyId), isNull(policies.deletedAt)),
    columns: { teamId: true },
  });
  return planHolderForTeam(userId, policy?.teamId);
}

/**
 * 用户所在团队（非 viewer：viewer 不创作策略）的 owner id，去掉用户本人。
 * 词汇按作者存储，团队策略用作者词汇，故 Free 成员的词汇能力取自其所在团队 owner 的套餐。
 */
export async function authoringTeamOwnerIds(userId: string): Promise<string[]> {
  const memberships = await db.query.teamMembers.findMany({
    where: and(eq(teamMembers.userId, userId), inArray(teamMembers.role, ['owner', 'admin', 'member'])),
    columns: { teamId: true },
  });
  if (memberships.length === 0) return [];
  const rows = await db.query.teams.findMany({
    where: inArray(teams.id, memberships.map((m) => m.teamId)),
    columns: { ownerId: true },
  });
  return [...new Set(rows.map((r) => r.ownerId))].filter((id) => id !== userId);
}

export type TeamOwnerEligibility =
  | { eligible: true }
  | { eligible: false; code: 'new_owner_plan_ineligible' }
  | { eligible: false; code: 'new_owner_seat_limit'; memberCount: number; limit: number };

/**
 * 用户能否成为某团队的 owner（#677）：转让后团队能力立即按新 owner 的套餐计，
 * 新 owner 必须有团队功能，且其套餐的成员上限容得下当前成员数，否则转让后团队立刻
 * 失去邀请 / 团队 key 等能力。
 */
export async function checkTeamOwnerEligibility(userId: string, teamId: string): Promise<TeamOwnerEligibility> {
  if (!(await hasFeatureAccess(userId, 'teamFeatures'))) {
    return { eligible: false, code: 'new_owner_plan_ineligible' };
  }
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { plan: true, priceLockedAt: true, legacyTier: true },
  });
  if (!user) return { eligible: false, code: 'new_owner_plan_ineligible' };
  const { maxTeamMembers } = getEffectiveLimits({
    plan: user.plan as PlanType,
    priceLockedAt: user.priceLockedAt,
    legacyTier: user.legacyTier,
  });
  if (maxTeamMembers === -1) return { eligible: true };
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));
  return count > maxTeamMembers
    ? { eligible: false, code: 'new_owner_seat_limit', memberCount: count, limit: maxTeamMembers }
    : { eligible: true };
}
