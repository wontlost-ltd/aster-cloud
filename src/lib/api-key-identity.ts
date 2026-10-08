// src/lib/api-key-identity.ts
/**
 * API key → 身份 的唯一解析器（ADR 0015 §2）。
 *
 * 个人 key（teamId 为空）：tenantId = userId，role = owner，quotaOwnerId = userId，套餐取本人。
 * 团队 key：tenantId = teamId，role = TeamMember.role（现查，成员被移出即失效），
 *          quotaOwnerId = Team.ownerId，套餐取 owner。
 * 业务角色（ADR 0042 §2.2）：个人 key 取 User.businessRoles，团队 key 取持有者的 TeamMember.businessRoles。
 * verify 路由、snapshot 推送、snapshot/full、validateApiKey 都只能经由这里拿身份；
 * 快照体（推送与 snapshot/full 共用）也只在这里由身份映射，见 toApiKeySnapshotBody。
 */
import { db, apiKeys, users, teams, teamMembers } from '@/lib/prisma';
import { and, eq, inArray } from 'drizzle-orm';
import { SOLO_TENANT_ROLE, type TeamRole } from '@/lib/team-permissions';
import type { Plan } from '@/db/schema';

export type ApiKeyRow = {
  id: string;
  userId: string;
  teamId: string | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
};

export type ApiKeyIdentity =
  | {
      valid: true;
      apiKeyId: string;
      userId: string;
      tenantId: string;
      teamId: string | null;
      quotaOwnerId: string;
      role: TeamRole;
      businessRoles: string[];
      plan: Plan;
      subscriptionStatus: string | null;
    }
  | {
      valid: false;
      reason: 'not_found' | 'revoked' | 'expired' | 'orphan_key' | 'team_not_found' | 'membership_revoked';
      revokedAt?: Date;
      expiredAt?: Date;
    };

/**
 * aster-api `ApiKeySnapshot` 的请求体（`POST /api/internal/snapshot/apikey/{hash}` 与 snapshot/full 的每一项）。
 * valid 只下发快照认的字段（不含 teamId / subscriptionStatus）；invalid 只带 reason，被吊销时附 revokedAtEpochMs。
 */
export type ApiKeySnapshotBody =
  | {
      valid: true;
      apiKeyId: string;
      userId: string;
      tenantId: string;
      quotaOwnerId: string;
      role: TeamRole;
      /** 空数组时省略键，与 aster-api 快照 NON_EMPTY 序列化对称（ADR 0042 §2.2）。 */
      businessRoles?: string[];
      plan: Plan;
      revokedAtEpochMs: null;
    }
  | {
      valid: false;
      reason: Extract<ApiKeyIdentity, { valid: false }>['reason'];
      revokedAtEpochMs?: number;
    };

/** 解析所需的 ApiKey 列，供各调用方的查询复用，避免漏列。 */
export const API_KEY_IDENTITY_COLUMNS = {
  id: true,
  userId: true,
  teamId: true,
  revokedAt: true,
  expiresAt: true,
} as const;

type UserInfo = { id: string; plan: Plan; subscriptionStatus: string | null; businessRoles: string[] };
type Membership = { role: TeamRole; businessRoles: string[] };

export async function resolveApiKeyIdentity(keyHash: string, now: Date = new Date()): Promise<ApiKeyIdentity> {
  const key = await db.query.apiKeys.findFirst({
    where: eq(apiKeys.key, keyHash),
    columns: API_KEY_IDENTITY_COLUMNS,
  });
  if (!key) return { valid: false, reason: 'not_found' };
  const map = await resolveApiKeyIdentities([key], now);
  return map.get(key.id) ?? { valid: false, reason: 'not_found' };
}

export async function resolveApiKeyIdentities(keys: ApiKeyRow[], now: Date = new Date()): Promise<Map<string, ApiKeyIdentity>> {
  const out = new Map<string, ApiKeyIdentity>();
  // 先按 key 自身状态裁掉，不碰数据库
  const live: ApiKeyRow[] = [];
  for (const k of keys) {
    if (k.revokedAt) out.set(k.id, { valid: false, reason: 'revoked', revokedAt: k.revokedAt });
    else if (k.expiresAt && k.expiresAt.getTime() < now.getTime()) out.set(k.id, { valid: false, reason: 'expired', expiredAt: k.expiresAt });
    else live.push(k);
  }
  if (live.length === 0) return out;

  const teamIds = [...new Set(live.map((k) => k.teamId).filter((t): t is string => !!t))];
  const holderIds = live.map((k) => k.userId);
  // teams 与 teamMembers 互不依赖并行查；成员只取本批持有者的行，避免随团队规模放大
  const [teamRows, memberRows] = teamIds.length
    ? await Promise.all([
        db.query.teams.findMany({ where: inArray(teams.id, teamIds), columns: { id: true, ownerId: true } }),
        db.query.teamMembers.findMany({
          where: and(inArray(teamMembers.teamId, teamIds), inArray(teamMembers.userId, holderIds)),
          columns: { teamId: true, userId: true, role: true, businessRoles: true },
        }),
      ])
    : [[], []];
  const teamById = new Map(teamRows.map((t) => [t.id, t]));
  // 存整行（角色 + 业务角色），团队 key 的两者都取自持有者自己的成员行
  const membershipByKey = new Map<string, Membership>(memberRows.map((r) => [`${r.teamId}\u0000${r.userId}`, r]));

  const userIds = [...new Set([...holderIds, ...teamRows.map((t) => t.ownerId)])];
  const userRows: UserInfo[] = await db.query.users.findMany({
    where: inArray(users.id, userIds),
    columns: { id: true, plan: true, subscriptionStatus: true, businessRoles: true },
  });
  const userById = new Map(userRows.map((u) => [u.id, u]));

  for (const k of live) {
    out.set(k.id, identityOf(k, teamById, membershipByKey, userById));
  }
  return out;
}

function identityOf(
  k: ApiKeyRow,
  teamById: Map<string, { id: string; ownerId: string }>,
  membershipByKey: Map<string, Membership>,
  userById: Map<string, UserInfo>
): ApiKeyIdentity {
  const holder = userById.get(k.userId);
  if (!holder) return { valid: false, reason: 'orphan_key' };
  if (!k.teamId) {
    return { valid: true, apiKeyId: k.id, userId: k.userId, tenantId: k.userId, teamId: null, quotaOwnerId: k.userId,
      role: SOLO_TENANT_ROLE, businessRoles: holder.businessRoles, plan: holder.plan,
      subscriptionStatus: holder.subscriptionStatus ?? null };
  }
  const team = teamById.get(k.teamId);
  if (!team) return { valid: false, reason: 'team_not_found' };
  const membership = membershipByKey.get(`${k.teamId}\u0000${k.userId}`);
  if (!membership) return { valid: false, reason: 'membership_revoked' };
  const owner = userById.get(team.ownerId);
  if (!owner) return { valid: false, reason: 'orphan_key' };
  return { valid: true, apiKeyId: k.id, userId: k.userId, tenantId: k.teamId, teamId: k.teamId, quotaOwnerId: team.ownerId,
    role: membership.role, businessRoles: membership.businessRoles, plan: owner.plan,
    subscriptionStatus: owner.subscriptionStatus ?? null };
}

/** 身份 → 快照体的唯一映射；个人 key 与改前逐字段相同，仅多 quotaOwnerId（= userId）。 */
export function toApiKeySnapshotBody(identity: ApiKeyIdentity): ApiKeySnapshotBody {
  if (!identity.valid) {
    return {
      valid: false,
      reason: identity.reason,
      ...(identity.revokedAt ? { revokedAtEpochMs: identity.revokedAt.getTime() } : {}),
    };
  }
  return {
    valid: true,
    apiKeyId: identity.apiKeyId,
    userId: identity.userId,
    tenantId: identity.tenantId,
    quotaOwnerId: identity.quotaOwnerId,
    role: identity.role,
    ...(identity.businessRoles.length > 0 ? { businessRoles: identity.businessRoles } : {}),
    plan: identity.plan,
    revokedAtEpochMs: null,
  };
}
