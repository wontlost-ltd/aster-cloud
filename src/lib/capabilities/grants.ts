/*
 * 能力授权写服务（ADR 0058 §4.6 / §4.7 / §4.9）：授予、撤销、团队委派额度。
 *
 * 每个写操作与它的审计行在同一事务内提交：审计直接 insert auditLogs（不走吞错的 logAuditEvent），
 * 审计失败则写入一起回滚，不会出现「已授权却无审计」。
 * 授予的幂等由活跃唯一索引兜住（ON CONFLICT DO NOTHING 后在同一事务内读回现有行），
 * 不先查后插——先查在 Hyperdrive 缓存下可能读到旧状态（#614）。
 */

import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import {
  auditLogs,
  capabilityGrants,
  capabilityTeamAllotments,
  db,
  teamMembers,
  teams,
  users,
} from '@/lib/prisma';
import { freshDb } from '@/db/fresh-read';
import { getSetting } from '@/lib/platform-settings';
import { lockTeamRow, type DbClient } from '@/lib/team-plan';
import { CapabilityError } from './errors';
import { CAPABILITIES, type CapabilityKey } from './registry';

export type CapabilityGrantRow = typeof capabilityGrants.$inferSelect;
export type AllotmentRow = typeof capabilityTeamAllotments.$inferSelect;
export type RevokeReason = 'manual' | 'member_removed' | 'team_deleted' | 'migration';
export type { DbClient };

/** 审计 metadata 的公共部分（§4.9）：主体与来源；可选字段缺省时不出现。 */
function grantAuditMetadata(grant: CapabilityGrantRow): Record<string, unknown> {
  return {
    capability: grant.capability,
    subjectType: grant.userId ? 'user' : 'team',
    subjectId: grant.userId ?? grant.teamId,
    source: grant.source,
    ...(grant.delegatingTeamId ? { delegatingTeamId: grant.delegatingTeamId } : {}),
    ...(grant.note ? { note: grant.note } : {}),
  };
}

/** 审计行的 teamId 列：团队授权填团队，委派填委派团队，使团队审计视图可见；个人直接授权为空。 */
function grantAuditTeamId(grant: CapabilityGrantRow): string | null {
  return grant.teamId ?? grant.delegatingTeamId ?? null;
}

async function subjectExists(client: DbClient, subject: { type: 'user' | 'team'; id: string }): Promise<boolean> {
  if (subject.type === 'user') {
    const rows = await client
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, subject.id), isNull(users.deletedAt)));
    return rows.length > 0;
  }
  const rows = await client.select({ id: teams.id }).from(teams).where(eq(teams.id, subject.id));
  return rows.length > 0;
}

/** 主体当前的活跃平台授权（用户为个人直接授权，团队为团队授权）。 */
async function activeSubjectGrant(
  client: DbClient,
  capability: CapabilityKey,
  subject: { type: 'user' | 'team'; id: string },
): Promise<CapabilityGrantRow | undefined> {
  const subjectMatch =
    subject.type === 'user'
      ? and(eq(capabilityGrants.userId, subject.id), isNull(capabilityGrants.delegatingTeamId))
      : eq(capabilityGrants.teamId, subject.id);
  const rows = await client
    .select()
    .from(capabilityGrants)
    .where(and(eq(capabilityGrants.capability, capability), isNull(capabilityGrants.revokedAt), subjectMatch));
  return rows[0];
}

/** 平台管理员授予用户或团队；已有活跃授权时返回现有行（created:false），不重复写审计。 */
export async function grantToSubject(input: {
  capability: CapabilityKey;
  subject: { type: 'user' | 'team'; id: string };
  grantedBy: string;
  note?: string;
}): Promise<{ grant: CapabilityGrantRow; created: boolean }> {
  const { capability, subject, grantedBy, note } = input;
  return db.transaction(async (tx) => {
    if (!(await subjectExists(tx, subject))) throw new CapabilityError('subject_not_found');

    const [inserted] = await tx
      .insert(capabilityGrants)
      .values({
        id: crypto.randomUUID(),
        capability,
        userId: subject.type === 'user' ? subject.id : null,
        teamId: subject.type === 'team' ? subject.id : null,
        source: 'platform_admin',
        grantedBy,
        note: note ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (!inserted) {
      // 撞活跃唯一索引：读回已存在的那一行（同一事务、语句级快照能看到已提交的并发插入）
      const existing = await activeSubjectGrant(tx, capability, subject);
      if (!existing) throw new Error('capability grant conflict but no active row found');
      return { grant: existing, created: false };
    }

    await tx.insert(auditLogs).values({
      id: crypto.randomUUID(),
      userId: grantedBy,
      teamId: grantAuditTeamId(inserted),
      action: 'capability.grant',
      resource: 'capability_grant',
      resourceId: inserted.id,
      metadata: grantAuditMetadata(inserted),
    });
    return { grant: inserted, created: true };
  });
}

/** 撤销后的审计行（每条被撤销的授权一行），与撤销同事务写入。 */
async function insertRevokeAudits(
  tx: DbClient,
  revoked: CapabilityGrantRow[],
  revokedBy: string,
  reason: RevokeReason,
): Promise<void> {
  if (revoked.length === 0) return;
  await tx.insert(auditLogs).values(
    revoked.map((grant) => ({
      id: crypto.randomUUID(),
      userId: revokedBy,
      teamId: grantAuditTeamId(grant),
      action: 'capability.revoke',
      resource: 'capability_grant',
      resourceId: grant.id,
      metadata: { ...grantAuditMetadata(grant), reason },
    })),
  );
}

/**
 * 撤销一条活跃授权；不存在、已撤销或能力不符一律 grant_not_found（不泄露是哪种）。
 * expectDelegatingTeamId 给出时只匹配该团队的委派行：团队 owner 只能撤本团队的委派。
 */
export async function revokeGrant(input: {
  grantId: string;
  revokedBy: string;
  reason: RevokeReason;
  expectCapability: CapabilityKey;
  expectDelegatingTeamId?: string;
}): Promise<CapabilityGrantRow> {
  const { grantId, revokedBy, reason, expectCapability, expectDelegatingTeamId } = input;
  return db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(capabilityGrants)
      .set({ revokedAt: new Date(), revokedBy, revokeReason: reason })
      .where(
        and(
          eq(capabilityGrants.id, grantId),
          eq(capabilityGrants.capability, expectCapability),
          isNull(capabilityGrants.revokedAt),
          expectDelegatingTeamId === undefined
            ? undefined
            : eq(capabilityGrants.delegatingTeamId, expectDelegatingTeamId),
        ),
      )
      .returning();
    if (!revoked) throw new CapabilityError('grant_not_found');

    await insertRevokeAudits(tx, [revoked], revokedBy, reason);
    return revoked;
  });
}

/**
 * 团队已占座位数（§4.6）：活跃、由该团队委派、且对象仍是该团队成员（任何角色，含 viewer）的行。
 * 离队者的残留委派行不占座，所以成员移除时的撤销清理失败不会多算。
 */
export async function countActiveSeats(client: DbClient, capability: CapabilityKey, teamId: string): Promise<number> {
  const [{ count }] = await client
    .select({ count: sql<number>`count(*)::int` })
    .from(capabilityGrants)
    .innerJoin(
      teamMembers,
      and(eq(teamMembers.teamId, capabilityGrants.delegatingTeamId), eq(teamMembers.userId, capabilityGrants.userId)),
    )
    .where(
      and(
        eq(capabilityGrants.capability, capability),
        eq(capabilityGrants.delegatingTeamId, teamId),
        isNull(capabilityGrants.revokedAt),
      ),
    );
  return count;
}

/**
 * 设定团队委派额度与团队级开关。先 lockTeamRow 再计座、再写，与委派写入串行化，
 * 计座与下调之间不会插进新的委派；低于已用座位时 409，不自动挑人撤销。
 */
export async function setTeamAllotment(input: {
  capability: CapabilityKey;
  teamId: string;
  seatCap: number;
  ownerGrantingEnabled: boolean;
  updatedBy: string;
}): Promise<AllotmentRow> {
  const { capability, teamId, seatCap, ownerGrantingEnabled, updatedBy } = input;
  if (!CAPABILITIES[capability].teamDelegation) throw new CapabilityError('delegation_not_supported');

  return db.transaction(async (tx) => {
    if (!(await lockTeamRow(tx, teamId))) throw new CapabilityError('subject_not_found');

    const used = await countActiveSeats(tx, capability, teamId);
    if (seatCap < used) {
      throw new CapabilityError(
        'seat_cap_below_active',
        undefined,
        `seatCap ${seatCap} is below ${used} active delegated seats; revoke delegations first`,
      );
    }

    const allotmentKey = and(
      eq(capabilityTeamAllotments.capability, capability),
      eq(capabilityTeamAllotments.teamId, teamId),
    );
    const [old] = await tx.select().from(capabilityTeamAllotments).where(allotmentKey);
    const values = { seatCap, ownerGrantingEnabled, updatedBy, updatedAt: new Date() };
    const [allotment] = await tx
      .insert(capabilityTeamAllotments)
      .values({ capability, teamId, ...values })
      .onConflictDoUpdate({ target: [capabilityTeamAllotments.capability, capabilityTeamAllotments.teamId], set: values })
      .returning();

    await tx.insert(auditLogs).values({
      id: crypto.randomUUID(),
      userId: updatedBy,
      teamId,
      action: 'capability.allotment.update',
      resource: 'team',
      resourceId: teamId,
      metadata: {
        capability,
        seatCap: { old: old?.seatCap ?? null, new: seatCap },
        ownerGrantingEnabled: { old: old?.ownerGrantingEnabled ?? null, new: ownerGrantingEnabled },
      },
    });
    return allotment;
  });
}


/** 团队委派是否开放：全局委派键（缺行默认开）且该团队有额度行、ownerGrantingEnabled 为真。 */
async function teamDelegationOpen(tx: DbClient, capability: CapabilityKey, teamId: string): Promise<AllotmentRow | null> {
  const settingKey = CAPABILITIES[capability].teamDelegationSettingKey;
  if (!settingKey || (await getSetting<boolean>(settingKey)) !== true) return null;
  const [allotment] = await tx
    .select()
    .from(capabilityTeamAllotments)
    .where(and(eq(capabilityTeamAllotments.capability, capability), eq(capabilityTeamAllotments.teamId, teamId)));
  return allotment?.ownerGrantingEnabled ? allotment : null;
}

/**
 * 团队 owner 在额度内把能力委派给本团队的非 viewer 成员（§4.6）。
 * 先 lockTeamRow 再做全部判定与计座、再插入：同一团队的委派、额度调整、转让所有权都锁同一行，
 * 并发委派最后一个座位时后到者在锁上等待，拿到锁后计座已含先到者的行，因此不会超座。
 * 该成员已有本团队的活跃委派时返回现有行（created:false），不占第二个座、不重复写审计。
 */
export async function delegateToMember(input: {
  capability: CapabilityKey;
  teamId: string;
  userId: string;
  ownerId: string;
}): Promise<{ grant: CapabilityGrantRow; created: boolean }> {
  const { capability, teamId, userId, ownerId } = input;
  return db.transaction(async (tx) => {
    const team = await lockTeamRow(tx, teamId);
    if (!team || team.ownerId !== ownerId) throw new CapabilityError('not_team_owner');
    if (!CAPABILITIES[capability].teamDelegation) throw new CapabilityError('delegation_not_supported');

    const allotment = await teamDelegationOpen(tx, capability, teamId);
    if (!allotment) throw new CapabilityError('team_delegation_disabled');

    const [member] = await tx
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
    if (!member) throw new CapabilityError('not_team_member');
    if (member.role === 'viewer') throw new CapabilityError('viewer_not_eligible');

    // 持锁读：同团队的委派写入都已串行化，这里读到的就是当前事实
    const [existing] = await tx
      .select()
      .from(capabilityGrants)
      .where(
        and(
          eq(capabilityGrants.capability, capability),
          eq(capabilityGrants.userId, userId),
          eq(capabilityGrants.delegatingTeamId, teamId),
          isNull(capabilityGrants.revokedAt),
        ),
      );
    if (existing) return { grant: existing, created: false };

    const used = await countActiveSeats(tx, capability, teamId);
    if (used >= allotment.seatCap) {
      throw new CapabilityError('seat_cap_reached', undefined, `all ${allotment.seatCap} delegated seats are in use`);
    }

    const [inserted] = await tx
      .insert(capabilityGrants)
      .values({
        id: crypto.randomUUID(),
        capability,
        userId,
        delegatingTeamId: teamId,
        source: 'team_owner',
        grantedBy: ownerId,
      })
      .returning();

    await tx.insert(auditLogs).values({
      id: crypto.randomUUID(),
      userId: ownerId,
      teamId: grantAuditTeamId(inserted),
      action: 'capability.grant',
      resource: 'capability_grant',
      resourceId: inserted.id,
      metadata: grantAuditMetadata(inserted),
    });
    return { grant: inserted, created: true };
  });
}

/**
 * 成员离队后撤销该团队对其的全部委派（reason = member_removed），每行一条审计，返回撤销数。
 * 由成员移除路由在事务外调用、失败只告警：计座与解析都联查 TeamMember，清理失败不影响正确性（§4.7）。
 */
export async function revokeMemberDelegations(teamId: string, userId: string, actorId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const revoked = await tx
      .update(capabilityGrants)
      .set({ revokedAt: new Date(), revokedBy: actorId, revokeReason: 'member_removed' })
      .where(
        and(
          eq(capabilityGrants.delegatingTeamId, teamId),
          eq(capabilityGrants.userId, userId),
          isNull(capabilityGrants.revokedAt),
        ),
      )
      .returning();
    await insertRevokeAudits(tx, revoked, actorId, 'member_removed');
    return revoked.length;
  });
}

/**
 * 团队删除时在删除事务内调用（§4.7）：撤销该团队的团队授权与它发出的全部委派（reason = team_deleted），
 * 删除该团队全部额度行，各写审计。事务回滚时这些变更一起回滚。
 */
export async function revokeTeamCascade(tx: DbClient, teamId: string, actorId: string): Promise<void> {
  const revoked = await tx
    .update(capabilityGrants)
    .set({ revokedAt: new Date(), revokedBy: actorId, revokeReason: 'team_deleted' })
    .where(
      and(
        or(eq(capabilityGrants.teamId, teamId), eq(capabilityGrants.delegatingTeamId, teamId)),
        isNull(capabilityGrants.revokedAt),
      ),
    )
    .returning();
  await insertRevokeAudits(tx, revoked, actorId, 'team_deleted');

  const removed = await tx
    .delete(capabilityTeamAllotments)
    .where(eq(capabilityTeamAllotments.teamId, teamId))
    .returning();
  if (removed.length === 0) return;
  await tx.insert(auditLogs).values(
    removed.map((allotment) => ({
      id: crypto.randomUUID(),
      userId: actorId,
      teamId,
      action: 'capability.allotment.update',
      resource: 'team',
      resourceId: teamId,
      metadata: {
        capability: allotment.capability,
        seatCap: { old: allotment.seatCap, new: null },
        ownerGrantingEnabled: { old: allotment.ownerGrantingEnabled, new: null },
        reason: 'team_deleted',
      },
    })),
  );
}

export interface TeamDelegationView {
  allotment: { seatCap: number; ownerGrantingEnabled: boolean } | null;
  seatsUsed: number;
  delegations: Array<{
    grantId: string;
    userId: string;
    email: string | null;
    name: string | null;
    role: string;
    grantedAt: Date;
  }>;
}

/**
 * 团队 owner 看到的委派概况（§4.6）：额度、已用座位、委派名单。
 * 名单与计座同口径——活跃且对象仍是该团队成员（含被暂停的 viewer）；不含平台直接授权。经 freshDb 现读（#614）。
 */
export async function listTeamDelegations(capability: CapabilityKey, teamId: string): Promise<TeamDelegationView> {
  const g = capabilityGrants;
  const [[allotment], delegations] = await Promise.all([
    freshDb
      .select({
        seatCap: capabilityTeamAllotments.seatCap,
        ownerGrantingEnabled: capabilityTeamAllotments.ownerGrantingEnabled,
      })
      .from(capabilityTeamAllotments)
      .where(and(eq(capabilityTeamAllotments.capability, capability), eq(capabilityTeamAllotments.teamId, teamId))),
    freshDb
      .select({
        grantId: g.id,
        userId: teamMembers.userId,
        email: users.email,
        name: users.name,
        role: teamMembers.role,
        grantedAt: g.grantedAt,
      })
      .from(g)
      .innerJoin(teamMembers, and(eq(teamMembers.teamId, g.delegatingTeamId), eq(teamMembers.userId, g.userId)))
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(and(eq(g.capability, capability), eq(g.delegatingTeamId, teamId), isNull(g.revokedAt)))
      .orderBy(asc(g.grantedAt), asc(g.id)),
  ]);
  return { allotment: allotment ?? null, seatsUsed: delegations.length, delegations };
}
