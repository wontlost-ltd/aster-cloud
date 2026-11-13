/**
 * 用户 id → 展示信息（姓名、邮箱、头像）的批量查询。
 *
 * 一次 inArray 查询、先去重，空集合不查库；查不到的 id（已注销 / 非 cloud 用户，如 aster-api 的 anonymous）
 * 不出现在结果里，由调用方给本地化的「未知用户」。调用方只能传入它已有权展示的 id（如本租户记录里的
 * 操作者），本函数不做授权判断，切勿直接接收请求参数里的 id 列表。
 */
import 'server-only';

import { and, eq, inArray } from 'drizzle-orm';
import { freshDb } from '@/db/fresh-read';
import { db, teamMembers, users } from '@/lib/prisma';
import { isPersonalTenant } from '@/lib/policy-tenant';

export interface UserProfile {
  name: string | null;
  email: string | null;
  image: string | null;
}

export async function loadUserProfiles(ids: readonly string[]): Promise<Map<string, UserProfile>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.query.users.findMany({
    where: inArray(users.id, unique),
    columns: { id: true, name: true, email: true, image: true },
  });
  return new Map(rows.map((u) => [u.id, { name: u.name ?? null, email: u.email ?? null, image: u.image ?? null }]));
}

/**
 * 只解析「本租户当前成员」的资料，与团队成员列表的可见范围一致：团队租户按成员表过滤（离队成员、非成员与
 * anonymous 不返回），个人租户只解析租户本人。成员关系走 freshDb，离队后立即不再展示其姓名与邮箱。
 */
export async function loadTenantMemberProfiles(
  tenantId: string,
  ids: readonly string[],
  viewerUserId?: string,
): Promise<Map<string, UserProfile>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  if (viewerUserId !== undefined && isPersonalTenant(tenantId, viewerUserId)) {
    return loadUserProfiles(unique.filter((id) => id === tenantId));
  }
  const members = await freshDb.query.teamMembers.findMany({
    where: and(eq(teamMembers.teamId, tenantId), inArray(teamMembers.userId, unique)),
    columns: { userId: true },
  });
  return loadUserProfiles(members.map((m) => m.userId));
}
