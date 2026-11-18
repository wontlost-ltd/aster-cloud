/**
 * 详情页「导出」菜单里的策略包选项（ADR 0059 P2，T19）。
 *
 * 返回 null（菜单不出现任何包选项，也不调 aster-api）的三种情形：
 * - 平台开关 policy_export.package.enabled 关；
 * - 套餐持有人（planHolderForTeam：团队策略看团队 owner）的套餐没有 policyExport；
 * - 没有已批准版本（findDefaultExecutableVersion 为空），草稿永不导出。
 * 否则按导出会提交的同一请求体问 check（package-exportability），两个 target 都不可用时同样返回 null。
 */
import { isPolicyPackageExportEnabled } from '@/lib/platform-settings';
import { planHolderForTeam } from '@/lib/team-plan';
import { hasFeatureAccess } from '@/lib/usage';
import { checkPackageExportability, type PackageTargetState } from '@/lib/package-exportability';
import type { PackageExportVersion } from '@/lib/package-export-input';
import type { PackageExportTarget, PolicyDiagnostic } from '@/services/policy/policy-api';

/** 下发给客户端菜单的状态（可序列化） */
export interface PackageExportMenuState {
  jre: PackageTargetState;
  node: PackageTargetState;
  diagnostics: Record<PackageExportTarget, PolicyDiagnostic[]>;
  /** aster-api 确定不了唯一入口：导出前须让用户在 entryCandidates 中选择 */
  entryRequired: boolean;
  entryCandidates: string[];
}

export async function loadPackageExportState(
  policy: { id: string; userId: string; teamId: string | null },
  userId: string,
  executable: Promise<PackageExportVersion | null>,
): Promise<PackageExportMenuState | null> {
  if (!(await isPolicyPackageExportEnabled())) return null;
  const holder = await planHolderForTeam(userId, policy.teamId);
  if (!(await hasFeatureAccess(holder, 'policyExport'))) return null;
  const version = await executable;
  if (!version) return null;
  const result = await checkPackageExportability({ policy, version, userId });
  if (result.jre === 'unavailable' && result.node === 'unavailable') return null;
  return {
    jre: result.jre,
    node: result.node,
    diagnostics: result.diagnostics,
    entryRequired: result.defaultEntry === null && result.entryCandidates.length > 0,
    entryCandidates: result.entryCandidates,
  };
}
