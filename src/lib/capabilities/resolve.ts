/*
 * 能力生效解析（ADR 0058 §4.4）。只读：回答「此人在当前资源上能否用某能力、通过哪些来源」。
 *
 * 判定顺序 unavailable → disabled → plan_required → not_granted，返回第一处失败。
 * ctx.teamId（当前资源所属团队）只决定按谁的套餐判定；授权来源与当前资源无关。
 * 授权、团队成员、额度行经 freshDb 现读（#614），全局开关经 getSetting（60 秒 TTL），不加跨请求缓存。
 */

import { cache } from 'react';
import { and, asc, eq, isNotNull, isNull, ne, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { freshDb } from '@/db/fresh-read';
import { capabilityGrants, capabilityTeamAllotments, teamMembers, users } from '@/lib/prisma';
import { getSetting } from '@/lib/platform-settings';
import { planHolderForTeam } from '@/lib/team-plan';
import { hasFeatureAccess } from '@/lib/usage';
import { CAPABILITIES, type CapabilityKey } from './registry';

export type EntitlementDenial = 'unavailable' | 'disabled' | 'plan_required' | 'not_granted';

export type GrantSource =
  | { kind: 'admin' }
  | { kind: 'direct'; grantId: string }
  | { kind: 'team'; grantId: string; teamId: string }
  | { kind: 'delegated'; grantId: string; teamId: string };

export interface Entitlement {
  allowed: boolean;
  denial?: EntitlementDenial;
  sources: GrantSource[];
}

function denied(denial: EntitlementDenial, sources: GrantSource[] = []): Entitlement {
  return { allowed: false, denial, sources };
}

/** 委派来源是否可能命中：注册项允许委派且全局委派开关打开（第 4d 步的两个常量条件）。 */
async function delegationActive(capability: CapabilityKey): Promise<boolean> {
  const descriptor = CAPABILITIES[capability];
  if (!descriptor.teamDelegation || !descriptor.teamDelegationSettingKey) return false;
  return (await getSetting<boolean>(descriptor.teamDelegationSettingKey)) === true;
}

/** 第 4a 步：平台管理员隐式拥有（仅注册项声明时才读 User.isAdmin）。 */
async function implicitAdmin(userId: string, capability: CapabilityKey): Promise<boolean> {
  if (!CAPABILITIES[capability].implicitForPlatformAdmin) return false;
  const user = await freshDb.query.users.findFirst({ where: eq(users.id, userId), columns: { isAdmin: true } });
  return user?.isAdmin === true;
}

/**
 * 第 4 步：此人名下全部命中的授权来源（与当前资源无关），来源之间无优先级。
 * 一条 SQL 覆盖 b 直接授权、c 团队授权（非 viewer 成员）、d 团队 owner 委派（非 viewer 成员 + 额度行开启 + 委派开关）。
 */
export async function listGrantSources(userId: string, capability: CapabilityKey): Promise<GrantSource[]> {
  const g = capabilityGrants;
  const mt = alias(teamMembers, 'mt');
  const md = alias(teamMembers, 'md');
  const a = capabilityTeamAllotments;

  const direct = and(eq(g.userId, userId), isNull(g.delegatingTeamId));
  const viaTeam = and(isNotNull(g.teamId), isNotNull(mt.id));
  // 委派不可用时整条分支不参与匹配（等价于 ADR 草图里的 $delegationAllowed AND $delegationSwitchOn 为假）
  const delegated = (await delegationActive(capability))
    ? and(eq(g.userId, userId), isNotNull(md.id), eq(a.ownerGrantingEnabled, true))
    : undefined;

  const [admin, rows] = await Promise.all([
    implicitAdmin(userId, capability),
    freshDb
      .select({ id: g.id, userId: g.userId, teamId: g.teamId, delegatingTeamId: g.delegatingTeamId })
      .from(g)
      .leftJoin(mt, and(eq(mt.teamId, g.teamId), eq(mt.userId, userId), ne(mt.role, 'viewer')))
      .leftJoin(md, and(eq(md.teamId, g.delegatingTeamId), eq(md.userId, userId), ne(md.role, 'viewer')))
      .leftJoin(a, and(eq(a.capability, g.capability), eq(a.teamId, g.delegatingTeamId)))
      .where(and(eq(g.capability, capability), isNull(g.revokedAt), or(direct, viaTeam, delegated)))
      .orderBy(asc(g.grantedAt), asc(g.id)),
  ]);

  const sources: GrantSource[] = admin ? [{ kind: 'admin' }] : [];
  for (const row of rows) {
    if (row.delegatingTeamId) sources.push({ kind: 'delegated', grantId: row.id, teamId: row.delegatingTeamId });
    else if (row.teamId) sources.push({ kind: 'team', grantId: row.id, teamId: row.teamId });
    else sources.push({ kind: 'direct', grantId: row.id });
  }
  return sources;
}

export async function resolveEntitlement(
  userId: string,
  capability: CapabilityKey,
  ctx: { teamId: string | null },
): Promise<Entitlement> {
  const descriptor = CAPABILITIES[capability];
  if (descriptor.precondition && !descriptor.precondition()) return denied('unavailable');
  if ((await getSetting<boolean>(descriptor.settingKey)) !== true) return denied('disabled');

  let planOk = true;
  if (descriptor.planCapability) {
    const holder = await planHolderForTeam(userId, ctx.teamId);
    planOk = await hasFeatureAccess(holder, descriptor.planCapability);
  }

  // 套餐不满足时仍查授权：界面要能说「已授权但需 Pro」
  const sources = await listGrantSources(userId, capability);
  if (!planOk) return denied('plan_required', sources);
  if (sources.length === 0) return denied('not_granted');
  return { allowed: true, sources };
}

/** 同一 RSC 请求内去重（React cache）；API 路由在处理函数内直接调用 resolveEntitlement 一次。 */
export const resolveEntitlementForRequest = cache(resolveEntitlement);
