/*
 * 能力授权写服务（ADR 0058 §4.6 / §4.7 / §4.9）：授予、撤销、团队委派额度。
 *
 * 每个写操作与它的审计行在同一事务内提交：审计直接 insert auditLogs（不走吞错的 logAuditEvent），
 * 审计失败则写入一起回滚，不会出现「已授权却无审计」。
 * 授予的幂等由活跃唯一索引兜住（ON CONFLICT DO NOTHING 后在同一事务内读回现有行），
 * 不先查后插——先查在 Hyperdrive 缓存下可能读到旧状态（#614）。
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  auditLogs,
  capabilityGrants,
  capabilityTeamAllotments,
  db,
  teamMembers,
  teams,
  users,
} from '@/lib/prisma';
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

/** 撤销一条活跃授权；不存在、已撤销或能力不符一律 grant_not_found（不泄露是哪种）。 */
export async function revokeGrant(input: {
  grantId: string;
  revokedBy: string;
  reason: RevokeReason;
  expectCapability: CapabilityKey;
}): Promise<CapabilityGrantRow> {
  const { grantId, revokedBy, reason, expectCapability } = input;
  return db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(capabilityGrants)
      .set({ revokedAt: new Date(), revokedBy, revokeReason: reason })
      .where(
        and(
          eq(capabilityGrants.id, grantId),
          eq(capabilityGrants.capability, expectCapability),
          isNull(capabilityGrants.revokedAt),
        ),
      )
      .returning();
    if (!revoked) throw new CapabilityError('grant_not_found');

    await tx.insert(auditLogs).values({
      id: crypto.randomUUID(),
      userId: revokedBy,
      teamId: grantAuditTeamId(revoked),
      action: 'capability.revoke',
      resource: 'capability_grant',
      resourceId: revoked.id,
      metadata: { ...grantAuditMetadata(revoked), reason },
    });
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
