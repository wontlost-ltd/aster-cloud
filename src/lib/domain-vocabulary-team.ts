/**
 * 团队共享领域词汇的访问判定（ADR 0017 §3）。
 *
 * 角色每次请求按当前成员关系判定（checkTeamAccess 绕过查询缓存，离队 / 降级下一次请求即生效）：
 * - 查看：全部成员（vocabulary.view）；
 * - 新增：member 及以上（vocabulary.create）；
 * - 修改 / 删除 / 恢复：admin / owner 可动任何团队词条（vocabulary.manage），member 只能动自己创建的；
 * - viewer 只读；非成员一律拒绝。
 *
 * 判定失败抛 VocabularyError：非成员 `team_forbidden`，角色不足 `team_role_insufficient`，路由映射为 403。
 */

import {
  VocabularyError,
  getUserVocabularyTerm,
  teamOwner,
  userOwner,
  type VocabularyOwner,
} from '@/lib/domain-vocabulary';
import { and, asc, eq } from 'drizzle-orm';
import { teamMembers, teams } from '@/lib/prisma';
import { bypassQueryCache, freshDb } from '@/db/fresh-read';
import { checkTeamAccess, hasPermission, TeamPermission, type TeamRole } from '@/lib/team-permissions';

export type TeamVocabularyAction = 'view' | 'create' | 'edit';

/**
 * 解析一次词汇请求的归属并完成授权：teamId 为空即个人词汇（本人归属，无需额外授权）。
 * action='edit' 时须给出 linkId，用于 member「只能改自己创建的」判定；词条不存在时放行给下游报 404。
 */
export async function resolveVocabularyOwner(
  actorId: string,
  teamId: string | null | undefined,
  action: TeamVocabularyAction,
  linkId?: string,
): Promise<VocabularyOwner> {
  if (!teamId) return userOwner(actorId);
  const access = await checkTeamAccess(actorId, teamId);
  if (!access.allowed) {
    throw new VocabularyError('team_forbidden', 'You are not a member of this team.');
  }
  const owner = teamOwner(teamId);
  if (action === 'view') {
    if (hasPermission(access.role, TeamPermission.VOCABULARY_VIEW)) return owner;
    throw insufficientRole();
  }
  if (!hasPermission(access.role, TeamPermission.VOCABULARY_CREATE)) throw insufficientRole();
  if (action === 'create' || hasPermission(access.role, TeamPermission.VOCABULARY_MANAGE)) return owner;
  // member 改 / 删 / 恢复：只限自己创建的团队词条。
  const link = linkId
    ? await getUserVocabularyTerm(actorId, linkId, { includeDeleted: true }, owner)
    : null;
  if (link && link.userId !== actorId) throw insufficientRole();
  return owner;
}

function insufficientRole(): VocabularyError {
  return new VocabularyError(
    'team_role_insufficient',
    'Your team role does not allow changing this team vocabulary term.',
  );
}

/** 从请求 URL 读团队作用域（`?teamId=`）；空串视为个人。 */
export function teamIdFromRequest(req: Request): string | null {
  const value = new URL(req.url).searchParams.get('teamId');
  return value && value.trim() ? value.trim() : null;
}

export interface VocabularyTeamOption {
  id: string;
  name: string;
  role: TeamRole;
}

/** 词汇页的团队切换选项：调用者当前所在的全部团队（按名称排序），读成员关系时绕过查询缓存。 */
export async function listVocabularyTeams(userId: string): Promise<VocabularyTeamOption[]> {
  const rows = await freshDb
    .select({ id: teams.id, name: teams.name, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(and(eq(teamMembers.userId, userId), bypassQueryCache()))
    .orderBy(asc(teams.name));
  return rows.map((row) => ({ id: row.id, name: row.name, role: row.role as TeamRole }));
}

/** 团队作用域下调用者能做什么（界面据此隐藏按钮；服务端仍逐请求判定）。 */
export function teamVocabularyAbilities(role: TeamRole): { canCreate: boolean; canManage: boolean } {
  return {
    canCreate: hasPermission(role, TeamPermission.VOCABULARY_CREATE),
    canManage: hasPermission(role, TeamPermission.VOCABULARY_MANAGE),
  };
}
