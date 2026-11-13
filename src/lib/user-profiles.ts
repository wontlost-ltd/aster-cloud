/**
 * 用户 id → 展示信息（姓名、邮箱、头像）的批量查询。
 *
 * 一次 inArray 查询、先去重，空集合不查库；查不到的 id（已注销 / 非 cloud 用户，如 aster-api 的 anonymous）
 * 不出现在结果里，由调用方给本地化的「未知用户」。调用方只能传入它已有权展示的 id（如本租户记录里的
 * 操作者），本函数不做授权判断，切勿直接接收请求参数里的 id 列表。
 */
import 'server-only';

import { inArray } from 'drizzle-orm';
import { db, users } from '@/lib/prisma';

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
