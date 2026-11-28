import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';

import { freshDb } from '@/db/fresh-read';
import { teamMembers, teams, users } from '@/lib/prisma';
import { getRoleLevel, type TeamRole } from '@/lib/team-permission-matrix';

export type OrphanRecipients =
  | { kind: 'team'; tenantName: string; userIds: string[] }
  | { kind: 'personal'; userIds: string[] }
  | { kind: 'unknown' };

const ADMIN_LEVEL = getRoleLevel('admin');

/** 角色字符串是否达到 admin；未知角色（indexOf 为 -1）一律不收。 */
function isAdminOrAbove(role: string): boolean {
  return getRoleLevel(role as TeamRole) >= ADMIN_LEVEL;
}

/**
 * 解析孤儿通知收件人（ADR 0065 §3.2）：租户 id 先按团队、再按个人用户解释。
 * 全部经 freshDb 现查且不做任何缓存，成员或角色刚变更时下一次调用即可见。
 * 团队无管理员、个人用户已删除都返回空 userIds；只有两种都对不上才是 unknown。
 */
export async function resolveOrphanRecipients(tenantId: string): Promise<OrphanRecipients> {
  const [team] = await freshDb.select({ name: teams.name }).from(teams).where(eq(teams.id, tenantId));
  if (team) {
    const members = await freshDb
      .select({ userId: teamMembers.userId, role: teamMembers.role })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(and(eq(teamMembers.teamId, tenantId), isNull(users.deletedAt)));
    const userIds = [...new Set(members.filter((m) => isAdminOrAbove(m.role)).map((m) => m.userId))].sort();
    return { kind: 'team', tenantName: team.name, userIds };
  }

  const [user] = await freshDb
    .select({ id: users.id, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, tenantId));
  if (!user) return { kind: 'unknown' };
  return { kind: 'personal', userIds: user.deletedAt ? [] : [tenantId] };
}
