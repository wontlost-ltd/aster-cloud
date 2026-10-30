// src/lib/policy-lifecycle.ts
// 策略生命周期管理：软删除、恢复、定时清理

import {
  db,
  policies,
  policyRecycleBins,
  policyReviewInvitations,
  policyReviewers,
  policyShares,
} from '@/lib/prisma';
import { eq, inArray, isNull, not, and, desc, asc, lte, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { bypassQueryCache } from '@/db/fresh-read';
import { loadPolicyForAction, policiesVisibleTo, type LoadedPolicy } from '@/lib/policy-access';
import { releaseSnapshotRefsForPolicy, reportSnapshotRelease } from '@/lib/domain-vocabulary-snapshot';
// 回收站保留天数
const RECYCLE_BIN_RETENTION_DAYS = 30;

export interface SoftDeleteResult {
  success: boolean;
  policyId: string;
  error?: string;
  /** 失败时的 HTTP 状态：404 不存在 / 无权访问，403 团队角色不够 */
  status?: 403 | 404;
  code?: string;
}

export interface RestoreResult {
  success: boolean;
  policyId: string;
  error?: string;
  status?: 403 | 404;
  code?: string;
  nameConflict?: boolean;
  newName?: string;
}

/** 授权失败 → 生命周期结果（404 沿用原有文案，403 带团队角色原因码）。 */
function deniedResult(policyId: string, denied: Extract<LoadedPolicy, { ok: false }>, notFoundError: string): SoftDeleteResult {
  const { status, code, error } = denied.decision;
  return { success: false, policyId, status, code, error: status === 404 ? notFoundError : error };
}

/**
 * 调用者可在回收站里看到并处置的条目：本人的个人策略，加上本人当前有删除权限的团队的策略
 * （团队 owner/admin 共享同一团队的回收站视图，离队或降级后即不可见）。
 */
function trashVisibleTo(userId: string): SQL {
  const deletable = db.select({ id: policies.id }).from(policies).where(policiesVisibleTo(userId, 'delete'));
  return inArray(policyRecycleBins.policyId, deletable);
}

export interface TrashItem {
  id: string;
  policyId: string;
  name: string;
  description: string | null;
  deletedAt: Date;
  deletedBy: string;
  expiresAt: Date;
  daysRemaining: number;
}

/**
 * 物理删除一条策略及其回收站记录（同一事务）。
 *
 * 外键 PolicyRecycleBin.policyId → Policy.id 已带 ON DELETE CASCADE（迁移 0058），
 * 这里仍显式先删回收站行：纵深防御，不把回收站一致性押在单一机制上；
 * 同时让已成孤儿的回收站行（Policy 早已不在）也能被清理掉，而不是永远残留。
 *
 * 词汇快照引用（#628）：`DELETE … RETURNING` 取策略行锁（与审批事务的 FOR UPDATE 同一把），
 * 只有真正删掉策略行的事务才释放其版本的快照引用，并发/重复删除不会重复释放。
 * 版本行不随策略删除（无外键），作为历史证据保留，但不再计入引用（约定见
 * domain-vocabulary-snapshot 的「快照引用的归属与并发约定」）。
 *
 * 其它以 policyId 指向策略、无外键的表（#623）分两类：
 *   - 访问授权（共享、审阅人、待处理的审阅邀请）：策略没了就没有意义，同一事务内删除，
 *     见 deletePolicyAccessRows；
 *   - 历史证据（版本、执行与结果、回归、Proof、已接受的邀请）：保留，读取路径经 Policy 关联，
 *     孤儿行不会出现在列表里。
 * 永久删除、过期清理、清空回收站三条路径都经由这里。
 */
async function purgePolicy(policyId: string): Promise<void> {
  const release = await db.transaction(async (tx) => {
    await tx.delete(policyRecycleBins).where(eq(policyRecycleBins.policyId, policyId));
    const removed = await tx
      .delete(policies)
      .where(eq(policies.id, policyId))
      .returning({ id: policies.id });
    if (removed.length === 0) return null;
    await deletePolicyAccessRows(tx, policyId);
    return releaseSnapshotRefsForPolicy(policyId, tx);
  });
  // 计数异常的告警与指标在提交后上报：回滚的删除不应留下「已释放」的痕迹
  if (release) reportSnapshotRelease(policyId, release);
}

type PurgeTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * 删除策略的访问授权行：团队共享、审阅人、待处理的审阅邀请。已接受的邀请是审计历史，保留。
 * 这些表没有指向 Policy 的外键，不在这里删就会在硬删除后留下孤儿授权（#623）。
 */
async function deletePolicyAccessRows(tx: PurgeTx, policyId: string): Promise<void> {
  await tx.delete(policyShares).where(eq(policyShares.policyId, policyId));
  await tx.delete(policyReviewers).where(eq(policyReviewers.policyId, policyId));
  await tx
    .delete(policyReviewInvitations)
    .where(and(eq(policyReviewInvitations.policyId, policyId), isNull(policyReviewInvitations.acceptedAt)));
}

/**
 * 软删除策略
 * 1. 设置 deletedAt, deletedBy, deleteReason 字段
 * 2. 创建 PolicyRecycleBin 快照记录
 */
export async function softDeletePolicy(
  policyId: string,
  userId: string,
  reason?: string
): Promise<SoftDeleteResult> {
  try {
    // 团队策略按当前角色授权（owner/admin），个人策略只认所有者；只处理未删除的策略
    const access = await loadPolicyForAction(policyId, { userId }, 'delete');
    if (!access.ok) return deniedResult(policyId, access, 'Policy not found or already deleted');
    const policy = access.policy;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + RECYCLE_BIN_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    // 创建快照和标记删除（事务）
    await db.transaction(async (tx) => {
      // 创建回收站快照
      await tx.insert(policyRecycleBins).values({
        id: crypto.randomUUID(),
        policyId,
        userId,
        snapshot: {
          id: policy.id,
          name: policy.name,
          description: policy.description,
          content: policy.content,
          version: policy.version,
          isPublic: policy.isPublic,
          shareSlug: policy.shareSlug,
          piiFields: policy.piiFields,
          teamId: policy.teamId,
          createdAt: policy.createdAt.toISOString(),
          updatedAt: policy.updatedAt.toISOString(),
        },
        deletedBy: userId,
        expiresAt,
      });

      // 标记策略为已删除
      await tx.update(policies)
        .set({
          deletedAt: now,
          deletedBy: userId,
          deleteReason: reason || null,
        })
        .where(eq(policies.id, policyId));
    });

    return { success: true, policyId };
  } catch (error) {
    console.error('Soft delete policy error:', error);
    return {
      success: false,
      policyId,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * 恢复已删除的策略
 * 1. 检查策略是否在回收站中
 * 2. 检查名称冲突，如有冲突则添加后缀
 * 3. 清除软删除标记
 * 4. 删除回收站记录
 */
export async function restorePolicy(policyId: string, userId: string): Promise<RestoreResult> {
  try {
    // 只处理回收站里的策略；授权与删除同一口径（团队 owner/admin、个人策略所有者）
    const access = await loadPolicyForAction(policyId, { userId }, 'delete', { deleted: true });
    if (!access.ok) return deniedResult(policyId, access, 'Policy not found in trash');
    const policy = access.policy;
    const recycleBin = await db.query.policyRecycleBins.findFirst({
      where: eq(policyRecycleBins.policyId, policyId),
      columns: { id: true },
    });
    if (!recycleBin) {
      return {
        success: false,
        policyId,
        status: 404,
        error: 'Policy not found in trash',
      };
    }

    // 检查名称冲突（与同一归属范围内的现有未删除策略：团队策略看团队，个人策略看所有者）
    const existingPolicy = await db.query.policies.findFirst({
      where: and(
        policy.teamId ? eq(policies.teamId, policy.teamId) : eq(policies.userId, policy.userId),
        eq(policies.name, policy.name),
        isNull(policies.deletedAt),
        not(eq(policies.id, policyId))
      ),
    });

    let newName = policy.name;
    let nameConflict = false;

    if (existingPolicy) {
      // 名称冲突，添加后缀
      nameConflict = true;
      const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      newName = `${policy.name} (Restored ${timestamp})`;
    }

    // 恢复策略（事务）
    await db.transaction(async (tx) => {
      // 清除软删除标记并更新名称（如有冲突）
      await tx.update(policies)
        .set({
          deletedAt: null,
          deletedBy: null,
          deleteReason: null,
          name: newName,
        })
        .where(eq(policies.id, policyId));

      // 删除回收站记录
      await tx.delete(policyRecycleBins)
        .where(eq(policyRecycleBins.policyId, policyId));
    });

    return {
      success: true,
      policyId,
      nameConflict,
      newName: nameConflict ? newName : undefined,
    };
  } catch (error) {
    console.error('Restore policy error:', error);
    return {
      success: false,
      policyId,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * 永久删除策略（从回收站彻底删除）
 */
export async function permanentDeletePolicy(
  policyId: string,
  userId: string
): Promise<SoftDeleteResult> {
  try {
    const access = await loadPolicyForAction(policyId, { userId }, 'delete', { deleted: true });
    if (!access.ok) return deniedResult(policyId, access, 'Policy not found in trash');

    await purgePolicy(policyId);

    return { success: true, policyId };
  } catch (error) {
    console.error('Permanent delete policy error:', error);
    return {
      success: false,
      policyId,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * 获取用户的回收站列表
 * 回收站页在删除 / 恢复后立即重拉列表，属写后即读，绕过 Hyperdrive 缓存（见 @/db/fresh-read）。
 */
export async function getTrashItems(userId: string): Promise<TrashItem[]> {
  const recycleBinItems = await db.query.policyRecycleBins.findMany({
    where: and(trashVisibleTo(userId), bypassQueryCache()),
    orderBy: [desc(policyRecycleBins.deletedAt)],
    with: {
      policy: {
        columns: {
          id: true,
          name: true,
          description: true,
        },
      },
    },
  });

  const now = new Date();

  // 孤儿行（策略本体已不存在）跳过并记日志，不能因一行坏数据让整个回收站 500（#603）。
  // 外键补上后不应再出现；出现即说明有绕过 purgePolicy 的删除路径，需要排查。
  const items: TrashItem[] = [];
  for (const item of recycleBinItems) {
    if (!item.policy) {
      console.warn(
        '[policy-lifecycle] 回收站孤儿行已跳过：recycleBinId=%s policyId=%s',
        item.id,
        item.policyId
      );
      continue;
    }
    const daysRemaining = Math.max(
      0,
      Math.ceil((item.expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
    );
    items.push({
      id: item.id,
      policyId: item.policyId,
      name: item.policy.name,
      description: item.policy.description,
      deletedAt: item.deletedAt,
      deletedBy: item.deletedBy,
      expiresAt: item.expiresAt,
      daysRemaining,
    });
  }
  return items;
}

/**
 * 清理过期的回收站项目
 * 由 /api/cron/policy-trash-cleanup 每日调用（cron-registry 的 policy-trash-cleanup，#623）
 */
export async function cleanupExpiredTrashItems(): Promise<{
  deletedCount: number;
  errors: string[];
}> {
  const now = new Date();
  const errors: string[] = [];
  let deletedCount = 0;

  try {
    // 查找所有过期的回收站项目
    const expiredItems = await db.query.policyRecycleBins.findMany({
      where: lte(policyRecycleBins.expiresAt, now),
      columns: { policyId: true },
    });

    // 永久删除过期策略（连同回收站记录）
    for (const item of expiredItems) {
      try {
        await purgePolicy(item.policyId);
        deletedCount++;
      } catch (err) {
        errors.push(`Failed to delete policy ${item.policyId}: ${err}`);
      }
    }
  } catch (error) {
    errors.push(`Cleanup error: ${error}`);
  }

  return { deletedCount, errors };
}

/**
 * 回收策略已不存在的访问授权行（#623）：共享、审阅人、待处理的审阅邀请。
 *
 * purgePolicy 已在删除策略的事务内清理这些行；这里兜住其它硬删除路径（如账号清除时策略随
 * 用户级联删除）与修复前已经留下的孤儿。由回收站清理 cron 每日调用。
 */
export async function purgeOrphanPolicyAccessRows(): Promise<{
  shares: number;
  reviewers: number;
  invitations: number;
}> {
  const policyGone = (policyIdColumn: AnyPgColumn) =>
    sql`NOT EXISTS (SELECT 1 FROM ${policies} WHERE ${policies.id} = ${policyIdColumn})`;
  const shares = await db
    .delete(policyShares)
    .where(policyGone(policyShares.policyId))
    .returning({ id: policyShares.id });
  const reviewers = await db
    .delete(policyReviewers)
    .where(policyGone(policyReviewers.policyId))
    .returning({ id: policyReviewers.id });
  const invitations = await db
    .delete(policyReviewInvitations)
    .where(and(isNull(policyReviewInvitations.acceptedAt), policyGone(policyReviewInvitations.policyId)))
    .returning({ id: policyReviewInvitations.id });
  return { shares: shares.length, reviewers: reviewers.length, invitations: invitations.length };
}

/**
 * 获取用户的回收站统计
 */
export async function getTrashStats(userId: string): Promise<{
  count: number;
  oldestExpiresAt: Date | null;
  newestDeletedAt: Date | null;
}> {
  // 与 getTrashItems 同为写后即读，统计须与列表一致，同样绕过 Hyperdrive 缓存。
  const ownedFresh = and(trashVisibleTo(userId), bypassQueryCache());
  const [countResult, oldest, newest] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` })
      .from(policyRecycleBins)
      .where(ownedFresh),
    db.query.policyRecycleBins.findFirst({
      where: ownedFresh,
      orderBy: [asc(policyRecycleBins.expiresAt)],
      columns: { expiresAt: true },
    }),
    db.query.policyRecycleBins.findFirst({
      where: ownedFresh,
      orderBy: [desc(policyRecycleBins.deletedAt)],
      columns: { deletedAt: true },
    }),
  ]);

  const count = countResult[0]?.count || 0;

  return {
    count,
    oldestExpiresAt: oldest?.expiresAt || null,
    newestDeletedAt: newest?.deletedAt || null,
  };
}

/**
 * 批量清空回收站：本人删除、且本人当前仍有删除权限的条目。
 */
export async function emptyTrash(userId: string): Promise<{
  deletedCount: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let deletedCount = 0;

  try {
    // 批量清空只处理**本人删除**的条目（个人策略的删除者恒为所有者本人）；同一团队其他成员删除的团队条目
    // 只能在回收站里逐条永久删除，避免 admin 一键清掉别人刚删、还在恢复窗口里的策略（ADR 0016 §3）。
    const trashItems = await db.query.policyRecycleBins.findMany({
      where: and(trashVisibleTo(userId), eq(policyRecycleBins.deletedBy, userId)),
      columns: { policyId: true },
    });

    // 逐条复核删除权限后再永久删除（连同回收站记录）：列表查询与删除之间角色可能已变化
    for (const item of trashItems) {
      try {
        const access = await loadPolicyForAction(item.policyId, { userId }, 'delete', { deleted: true });
        if (!access.ok) continue;
        await purgePolicy(item.policyId);
        deletedCount++;
      } catch (err) {
        errors.push(`Failed to delete policy ${item.policyId}: ${err}`);
      }
    }
  } catch (error) {
    errors.push(`Empty trash error: ${error}`);
  }

  return { deletedCount, errors };
}
