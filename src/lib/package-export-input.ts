/**
 * 已批准版本交给 aster-api 做策略包导出 / 可导出性检查时的请求体（ADR 0059 P2）。
 *
 * 编译输入与 Cedar 导出同一份（loadCedarExportInput：源码、冻结别名集、语言、领域词汇、结构词授权），
 * 另加签名 manifest 需要的 claimedRef（修订 3 P2-R11）与 mode。详情页检查与下载路由共用这一份，
 * 检查的必须正是导出会提交的内容。
 */
import { and, desc, eq } from 'drizzle-orm';
import { db, policyApprovals } from '@/lib/prisma';
import { loadCedarExportInput, type CedarExportVersion } from '@/lib/cedar-export-input';
import type { PackageClaimedRef, PackageExportRequest } from '@/services/policy/policy-api';

/** 导出所需的版本列：编译输入 + 版本行 id（查批准时间）与版本号 */
export type PackageExportVersion = CedarExportVersion & { id: string; version: number };

export interface PackageExportInput {
  /** 不含 target / uiLocale / entry / nodeProbes 的请求体，由调用方按需追加 */
  request: Omit<PackageExportRequest, 'target' | 'uiLocale' | 'entry' | 'nodeProbes'>;
  /** 实际编译的源码（入口名归一用） */
  source: string;
  /** 版本的领域词汇；无词汇时为 undefined */
  vocabulary: Record<string, unknown> | undefined;
}

/**
 * 该版本最近一次 APPROVED 决定的时间（ISO-8601）。policyVersions 没有批准时间列；
 * 没有批准记录（如迁移前的旧版本）时为 null，manifest schema 允许 null。
 */
export async function versionApprovedAt(versionId: string): Promise<string | null> {
  const row = await db.query.policyApprovals.findFirst({
    where: and(eq(policyApprovals.versionId, versionId), eq(policyApprovals.decision, 'APPROVED')),
    orderBy: [desc(policyApprovals.createdAt)],
    columns: { createdAt: true },
  });
  return row?.createdAt ? row.createdAt.toISOString() : null;
}

/** 组装请求体。词汇严格加载：失败时抛出，调用方不得退化为无词汇导出（同 Cedar）。 */
export async function loadPackageExportInput(
  policy: { id: string; teamId: string | null },
  version: PackageExportVersion,
): Promise<PackageExportInput> {
  const [{ request, source, vocabulary }, approvedAt] = await Promise.all([
    loadCedarExportInput(version, policy.teamId ?? null),
    versionApprovedAt(version.id),
  ]);
  const claimedRef: PackageClaimedRef = { policyId: policy.id, version: version.version, status: 'APPROVED', approvedAt };
  return {
    source,
    vocabulary,
    request: { ...request, source, mode: 'b', claimedRef },
  };
}
