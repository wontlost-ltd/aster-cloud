// src/services/policy/rule-regression-runner.ts
// P0-A 规则集升级回归工具 M1 缩版 runner（ADR 0030 附录 B）。
//
// 职责：把历史 Execution + 手写边界 case 冻结成不可变 RegressionCase（golden），升级后对
// 当前后端回放，canonical-diff 输出 hash 检测漂移，出四态报告（落 RegressionReport 审计）。
//
// ★M1 comparisonMode 恒 FROZEN_BASELINE_VS_CURRENT_BACKEND（单后端约束，见附录 B.1）：
// 基线 expectedOutputHash 是冻结时捕获的快照，M1 不实时重跑 old backend/toolchain。这是试点
// 实际操作方式（升级前 freeze → 部署新版 → run gate），诚实标注不假装实时对跑。

import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  db,
  policyVersions,
  regressionCases,
  regressionReports,
  regressionDriftApprovals,
  users,
  type RegressionReport,
  type RegressionDriftApproval,
} from '@/lib/prisma';
import { canonicalHash } from '@/lib/canonical-json';
import { createPolicyApiClient } from './policy-api';
import { detectCNLLocale } from './cnl-executor';
import { loadVersionExecutionVocabulary } from '@/lib/execution-input';

/**
 * runner 版本——进 reportHash，保证报告可复算归因到 runner 逻辑版本。
 * m1.1（CCO 深审加固第一批）：P0-1 toolchain 强制 / P0-2 禁降阈值 / P0-3 筛回放态 /
 * P0-5 reportHash 补全+稳定序+版本分派 / P0-6 run 重算 caseHash+未知版本 fail-closed。
 * m1.2：reportHash 逐 case 追加 caseHash + caseHashVersion——把「golden 完整性哈希」绑进「报告哈希」，
 * 使已签 reportHash **密码学锚定**它覆盖的冻结 golden（配合 {@link verifyReportIntegrity} 闭合验签）。
 * m1.3（Item 2）：reportHash 追加报告级 signability + unsignableLegacyCases——把「签字资格」绑进报告哈希，
 * 使含 m1.0 弱绑定 case 的报告在哈希层就宣告 UNSIGNABLE（防「report PASS 但 verify 拒签」双口径）。
 * m1.4（本 PR，Item 4 F）：reportHash 追加 unsignableReasons（封闭枚举 canonical 排序）——把「完整不可签字
 * 原因」绑进哈希，含 TOOLCHAIN_PROVENANCE_UNVERIFIED（★版本政策派生：cloud 无 runtime provenance 第 3 层
 * verifier，任何声称跨升级安全的报告其 toolchain 是自报未验证）。诚实降级：无可信 provenance→不可签字（不假装）。
 * 逻辑变更必须 bump（旧版报告 hash 与新版按各自 runnerVersion 分派公式，不混算——历史可复算铁律）。
 */
export const RULE_REGRESSION_RUNNER_VERSION = 'p0a-runner/m1.5';

/** M1 单后端比对模式（诚实标注：基线=冻结快照 hash，非实时重跑 old backend）。 */
export const COMPARISON_MODE_FROZEN_BASELINE = 'FROZEN_BASELINE_VS_CURRENT_BACKEND';

/** 报告四态。 */
export type RegressionReportStatus =
  | 'PASS'
  | 'FAIL_REGRESSION'
  | 'FAIL_INSUFFICIENT_COVERAGE'
  | 'NON_REPLAYABLE';

/**
 * 报告**签字资格**（Item 2，与 status 是**独立轴**）：status 表执行结果，signability 表这份报告能否作为
 * 签字级证据。含任何不可签字 caseHash 版本的 case（m1.0 弱绑定）→ UNSIGNABLE_LEGACY_CASE_HASH_VERSION。
 * ★可签字通过 = `status===PASS && signability===SIGNABLE`（防「report PASS 但 verify 拒签」双口径）。
 */
/**
 * 签字资格（真二值——Codex 复审：provenance-only 报告不能返回 LEGACY 枚举=自相矛盾）。deriveReportSignabilityDetail
 * 的派生结果 + m1.4+ 报告声明用此。具体不可签字原因见 unsignableReasons。
 */
export type ReportSignability = 'SIGNABLE' | 'UNSIGNABLE';

/**
 * 报告 artifact 声明的 signability **字段**类型——含历史 m1.3 冻结值 UNSIGNABLE_LEGACY_CASE_HASH_VERSION
 * （不可改，进 m1.3 hash）+ m1.4+ 真二值。读路径**不信**此声明，一律走 deriveReportSignabilityDetail 从事实派生。
 */
export type DeclaredSignability = ReportSignability | 'UNSIGNABLE_LEGACY_CASE_HASH_VERSION';

/**
 * 不可签字原因（封闭枚举，Codex 设计审：非任意 string[]——去重 + canonical 排序 + 未知 fail-closed）。
 * 一份报告可同时多个原因（如既有 legacy case 又缺 toolchain provenance）。
 * - LEGACY_CASE_HASH_VERSION：含弱绑定 case-hash/m1.0 case（Item 2）。
 * - GOLDEN_COMMITMENT_UNSUPPORTED：m1.0/m1.1 报告无 golden 承诺（Item 1/2）。
 * - TOOLCHAIN_PROVENANCE_UNVERIFIED：★Item 4 选项 F——报告声称「跨升级安全」（有跨 toolchain 对比证据的
 *   runnable case），但 current/baseline toolchainId 是 aster-api **自报、未经 runtime provenance 验证**
 *   （cloud 无第 3 层 verifier）。★**版本政策派生**的原因，不是可自报翻转的字段（防 Item 3 同构自证漏洞）。
 */
export type UnsignableReason =
  | 'LEGACY_CASE_HASH_VERSION'
  | 'GOLDEN_COMMITMENT_UNSUPPORTED'
  | 'TOOLCHAIN_PROVENANCE_UNVERIFIED';

/** canonical 排序（进 reportHash / 比较用，防数组顺序影响 hash）。 */
const UNSIGNABLE_REASON_ORDER: readonly UnsignableReason[] = [
  'LEGACY_CASE_HASH_VERSION',
  'GOLDEN_COMMITMENT_UNSUPPORTED',
  'TOOLCHAIN_PROVENANCE_UNVERIFIED',
];

/**
 * ★破坏 golden 完整性的 reason（阻断「受控接受漂移」）——与 provenance 维度正交。
 *
 * 受控接受（ACCEPTED_DRIFT_WITH_APPROVAL）= 管理员人工背书一个**具体 output 漂移**，其语义完备性只依赖
 * 「golden 是否可信」：LEGACY 弱绑定 / 无 golden 承诺 → 你不知道审批的是不是真 golden → 必须拦。而
 * TOOLCHAIN_PROVENANCE_UNVERIFIED（谁执行了 replay 未证明）与「能否接受这个漂移」**正交**——ACCEPTED 是
 * 「有人背书的已知漂移」，**不**声称跨升级签字级通过，故 provenance 缺失**不**阻断审批（否则整个 Item 2
 * 受控接受功能全废=破坏性回归）。反之 isSignablePass（绿色可签字，status===PASS）**含全维度**，仍要 provenance。
 */
const GOLDEN_INTEGRITY_UNSIGNABLE_REASONS: ReadonlySet<UnsignableReason> = new Set([
  'LEGACY_CASE_HASH_VERSION',
  'GOLDEN_COMMITMENT_UNSUPPORTED',
]);

/** 去重 + 按 canonical 顺序排序。 */
function canonicalizeReasons(reasons: Iterable<UnsignableReason>): UnsignableReason[] {
  const set = new Set(reasons);
  return UNSIGNABLE_REASON_ORDER.filter((r) => set.has(r));
}

/** 是否已知封闭枚举 reason（校验顶层声明用：含任何未知 → 声明不合法，fail-closed）。 */
function isKnownUnsignableReason(r: unknown): r is UnsignableReason {
  return typeof r === 'string' && (UNSIGNABLE_REASON_ORDER as readonly string[]).includes(r);
}

/** 顶层声明的 reasons 是否全合法（已知枚举 + 无重复 + canonical 顺序）——任一不满足即声明结构损坏。 */
function isCanonicalReasonList(declared: readonly unknown[]): declared is UnsignableReason[] {
  if (!declared.every(isKnownUnsignableReason)) return false;
  const canonical = canonicalizeReasons(declared as UnsignableReason[]);
  // 严格：长度 + 顺序完全一致（去重后长度变=有重复；顺序变=非 canonical）。
  return declared.length === canonical.length && declared.every((r, i) => r === canonical[i]);
}

/** case 级回放结果。 */
export type CaseRunStatus = 'PASS' | 'FAIL_REGRESSION' | 'NON_REPLAYABLE';

export interface CoverageThresholds {
  minRunnableCases: number;
  minApprovedCases: number;
  minDeniedCases: number;
  minHandwrittenBoundaryCases: number;
}

/** M1 默认覆盖阈值（ADR 附录 B.4）。 */
export const DEFAULT_THRESHOLDS: CoverageThresholds = {
  minRunnableCases: 4,
  minApprovedCases: 1,
  minDeniedCases: 1,
  minHandwrittenBoundaryCases: 1,
};

export interface HandwrittenCaseInput {
  policyVersionRowId: string;
  functionName: string;
  locale?: string;
  input: Record<string, unknown> | unknown[];
  coverageTags: string[];
}

export interface FreezeResult {
  frozen: number;
  duplicate: number;
  skipped: number;
  /**
   * 冲突：同 (versionRow,function,locale,canonicalInput) 已有 case 但 expectedOutputHash 不同
   * ——同一输入历史上产过不同输出=漂移信号（Codex 复审 #3）。不静默吞（DO NOTHING 会），显式暴露。
   */
  outputConflicts: Array<{
    canonicalInputHash: string;
    functionName: string;
    locale: string;
    existingExpectedOutputHash: string;
    candidateExpectedOutputHash: string;
  }>;
  caseIds: string[];
  /** 跳过原因明细（诊断用）。 */
  skippedReasons: string[];
}

/** 检测同 unique key 的已有 case 是否 expectedOutputHash 不同（漂移信号）。 */
async function detectOutputConflict(
  policyVersionRowId: string,
  functionName: string,
  locale: string,
  canonicalInputHash: string,
  candidateExpectedOutputHash: string
): Promise<FreezeResult['outputConflicts'][number] | null> {
  const existing = await db.query.regressionCases.findFirst({
    where: and(
      eq(regressionCases.policyVersionRowId, policyVersionRowId),
      eq(regressionCases.functionName, functionName),
      eq(regressionCases.locale, locale),
      eq(regressionCases.canonicalInputHash, canonicalInputHash)
    ),
    columns: { expectedOutputHash: true },
  });
  if (existing && existing.expectedOutputHash !== candidateExpectedOutputHash) {
    return {
      canonicalInputHash,
      functionName,
      locale,
      existingExpectedOutputHash: existing.expectedOutputHash,
      candidateExpectedOutputHash,
    };
  }
  return null;
}

export interface CaseRunDetail {
  caseId: string;
  status: CaseRunStatus;
  // ★m1.2（reportHash 绑 golden 完整性）：冻结 case 的完整性哈希 + 其公式版本。进 m1.2 reportHash 的
  // 逐 case object，使已签报告**密码学锚定**它覆盖的 golden——签 reportHash 即承诺 golden 摘要。
  // 全分支必带（base 注入，含 GOLDEN_INTEGRITY_FAILURE / unknown-version 失败 detail 也承诺「看到的
  // 损坏证据是什么」）。DB 列 caseHash/caseHashVersion 均 NOT NULL，进循环必可取，无 null 分支。
  caseHash: string;
  caseHashVersion: string;
  expectedInputHash?: string;
  actualInputHash?: string;
  expectedOutputHash?: string;
  actualOutputHash?: string;
  expectedDecision?: string | null;
  functionName: string;
  locale: string;
  coverageTags: string[];
  sourceKind: string;
  // P0-1：基线/当前工具链（进 reportHash + 报告审计——证明跨升级对比）。
  baselineToolchainId?: string;
  currentToolchainId?: string;
  reason?: string;
}

export interface RunReport {
  reportId: string;
  reportHash: string;
  status: RegressionReportStatus;
  comparisonMode: string;
  baselineSemantics: string;
  policyId: string;
  policyVersionRowId: string;
  currentRuntimeToolchainId: string | null;
  coverage: {
    totalCases: number;
    runnableCases: number;
    approvedCases: number;
    deniedCases: number;
    handwrittenBoundaryCases: number;
    thresholds: CoverageThresholds;
    unmet: string[];
  };
  summary: {
    passed: number;
    failed: number;
    nonReplayable: number;
    compileFailures: number;
  };
  cases: CaseRunDetail[];
  runnerVersion: string;
  /** 报告 artifact 声明的签字资格（历史 m1.3 含 UNSIGNABLE_LEGACY_...，m1.4+ 真二值）。★读路径不信此声明，
   * 走 deriveReportSignabilityDetail 从事实派生。进 m1.3/m1.4 reportHash。 */
  signability: DeclaredSignability;
  /** 不可签字 case 数（signability 归因，进 m1.3 reportHash 供审计/复算）。 */
  unsignableLegacyCases: number;
  /**
   * ★Item 4 F（m1.4+）：**全部**不可签字原因（封闭枚举，canonical 排序）。signability 二值兼容 Item 2，
   * unsignableReasons 是完整多维原因（含 TOOLCHAIN_PROVENANCE_UNVERIFIED）。进 m1.4 reportHash + 读路径
   * 自洽性校验（顶层声明须与派生一致，防伪造空 reasons 假装可签字）。m1.0-m1.3 报告无此字段（读路径纯派生）。
   */
  unsignableReasons?: UnsignableReason[];
  /**
   * ★P0-A S1（信任层5）：已批准升级证据。approvedTransitionManifestHash = 已验签 upgrade-manifest 的
   * manifestHash（证「有主体批准了 X→Y 方向升级」）；transitionVerified = 该 manifest 是否验签通过。
   * ★★这是**非持久化的 API view 字段**（Codex 复审 P1-4）——**不进** reportHash（报告 append-only，运行后
   * 无法写证据；证据是报告外、可撤销、可过期的独立 manifest artifact）。由读路径 deriveReportTransitionEvidence
   * **重新验签** manifest 表动态派生填充。**绝不**影响 signability：携此报告仍 UNSIGNABLE（层5≠层3，provenance
   * 未验证）。assembleReport 产报告时恒 null。
   */
  approvedTransitionManifestHash?: string | null;
  transitionVerified?: boolean | null;
}

const BASELINE_SEMANTICS =
  'expectedOutputHash was captured at freeze time under the baseline toolchain; ' +
  'M1 does not re-run the old backend/toolchain during report generation ' +
  '(single-backend constraint). Deploy the new version, then run the gate.';

/**
 * caseHash 公式版本。逻辑变更必须 bump——case 存 caseHashVersion，run 重算校验时按 case 自己
 * 的版本选公式（新旧共存），避免改公式让已冻结 m1 case 整批 GOLDEN_INTEGRITY_FAILURE。
 * - m1.0：原始 9 字段（policyVersionRow/function/locale/canonicalInput/expectedOutput/
 *   canonicalizationVersion/aliasSet/vocab/sourceKind）。
 * - m1.1：★CCO 复审 P0-6 补全——加绑 policyId/expectedDecision/coverageTags/
 *   baselineRuntimeToolchainId/sourceToolchainId/sourceEnvelopeSha256/sourceExecutionId，
 *   让篡改这些字段也被完整性校验捕获。
 */
export const CASE_HASH_VERSION_M10 = 'case-hash/m1.0';
export const CASE_HASH_VERSION = 'case-hash/m1.1';

/**
 * 可**签字**的 caseHash 公式版本集合（Item 2）。★m1.0 公式只绑 9 字段，**不含** coverageTags /
 * baselineRuntimeToolchainId / expectedDecision 等——而这些喂签字级 gate（覆盖门禁 + P0-1 toolchain）。
 * 故 m1.0 case 自洽只证那 9 字段没变，不足以支撑签字级证明：从签字资格上排除（历史复算兼容仍保留，
 * 见 computeCaseHash 的 m1.0 分支）。run/verify 共用本 predicate 判定，防两处版本表漂移。
 */
const SIGNABLE_CASE_HASH_VERSIONS: ReadonlySet<string> = new Set([CASE_HASH_VERSION]);

/** caseHash 公式版本是否可签字（不在集合=弱绑定/未知，签字级路径拒绝）。★不 export 可变 Set，只 export
 * 本 predicate——防外部运行时改签字策略常量。 */
export function isSignableCaseHashVersion(version: string): boolean {
  return SIGNABLE_CASE_HASH_VERSIONS.has(version);
}

export interface CaseHashFields {
  policyVersionRowId: string;
  functionName: string;
  locale: string;
  canonicalInputHash: string;
  expectedOutputHash: string;
  canonicalizationVersion: string;
  aliasSetJson: unknown;
  vocabSnapshotRef: unknown;
  sourceKind: string;
  // m1.1 新增绑定字段（防篡改覆盖）。
  policyId?: string;
  expectedDecision?: string | null;
  coverageTags?: string[];
  baselineRuntimeToolchainId?: string | null;
  sourceToolchainId?: string | null;
  sourceEnvelopeSha256?: string | null;
  sourceExecutionId?: string | null;
}

/**
 * caseHash = canonicalHash(核心不可变字段)——防篡改 + 去重锚。不含 createdAt/createdBy/id
 * （非决定性/身份字段）。按 {@param version} 选公式：m1.0=原 9 字段；m1.1=补全 7 字段。
 */
export function computeCaseHash(fields: CaseHashFields, version: string = CASE_HASH_VERSION): string {
  if (version === CASE_HASH_VERSION_M10) {
    // 旧公式：原样保留，供已冻结 m1.0 case 复算校验（不得改动，否则破坏历史证据）。
    return canonicalHash({
      policyVersionRowId: fields.policyVersionRowId,
      functionName: fields.functionName,
      locale: fields.locale,
      canonicalInputHash: fields.canonicalInputHash,
      expectedOutputHash: fields.expectedOutputHash,
      canonicalizationVersion: fields.canonicalizationVersion,
      aliasSetJson: fields.aliasSetJson ?? {},
      vocabSnapshotRef: fields.vocabSnapshotRef ?? [],
      sourceKind: fields.sourceKind,
    });
  }
  // ★Codex 复审 P0-6：未知版本 fail-closed——不静默按 m1.1 算，否则 case-hash/corrupt 会被当合法。
  if (version !== CASE_HASH_VERSION) {
    throw new Error(`unsupported caseHashVersion: ${version}`);
  }
  // m1.1：全字段绑定。canonicalHash 内部对 object 键排序，字段顺序无关。
  return canonicalHash({
    version: CASE_HASH_VERSION,
    policyId: fields.policyId ?? null,
    policyVersionRowId: fields.policyVersionRowId,
    functionName: fields.functionName,
    locale: fields.locale,
    canonicalInputHash: fields.canonicalInputHash,
    expectedOutputHash: fields.expectedOutputHash,
    expectedDecision: fields.expectedDecision ?? null,
    canonicalizationVersion: fields.canonicalizationVersion,
    aliasSetJson: fields.aliasSetJson ?? {},
    vocabSnapshotRef: fields.vocabSnapshotRef ?? [],
    sourceKind: fields.sourceKind,
    coverageTags: (fields.coverageTags ?? []).slice().sort(),
    baselineRuntimeToolchainId: fields.baselineRuntimeToolchainId ?? null,
    sourceToolchainId: fields.sourceToolchainId ?? null,
    sourceEnvelopeSha256: fields.sourceEnvelopeSha256 ?? null,
    sourceExecutionId: fields.sourceExecutionId ?? null,
  });
}

/**
 * reportHash 公式版本（同 caseHash 版本化）。★Codex 复审 P0-5：**按报告自身的 runnerVersion 选公式**，
 * 不能用当前运行代码常量——否则拿历史 reportJson 在新代码里复算会得到不同 hash（破坏历史可复算）。
 * m1.0=原公式（未含新逐 case 字段）；m1.1=补全字段+稳定序；m1.2=逐 case 追加 caseHash+caseHashVersion
 * （绑 golden 完整性）；m1.3=顶层追加 signability+unsignableLegacyCases（绑签字资格）。四路显式分派 +
 * 未知版本 fail-closed（抛错，不静默按新公式）。
 */
const REPORT_HASH_VERSION_M10 = 'p0a-runner/m1.0';
const REPORT_HASH_VERSION_M11 = 'p0a-runner/m1.1';
const REPORT_HASH_VERSION_M12 = 'p0a-runner/m1.2';
const REPORT_HASH_VERSION_M13 = 'p0a-runner/m1.3';
const REPORT_HASH_VERSION_M14 = 'p0a-runner/m1.4';
// ★P0-A S1（信任层5）：m1.5 = m1.4 全字段 + 顶层已批准升级证据（approvedTransitionManifestHash +
// transitionVerified）。这是**额外证据**——绝不改 signability/unsignableReasons 派生，携此报告仍 UNSIGNABLE。
const REPORT_HASH_VERSION_M15 = 'p0a-runner/m1.5';

/** 逐 case 绑了 caseHash 承诺的 reportHash 版本（golden 完整性可核验）——verify 认这些。 */
const GOLDEN_COMMITMENT_REPORT_VERSIONS: ReadonlySet<string> = new Set([
  REPORT_HASH_VERSION_M12,
  REPORT_HASH_VERSION_M13,
  REPORT_HASH_VERSION_M14,
  REPORT_HASH_VERSION_M15,
]);

/**
 * reportHash = canonicalHash(报告决定性内容)——报告防篡改 + 可复算。不含 reportId/createdAt（身份/时间）。
 * 按 {@code report.runnerVersion} 选公式（历史 artifact 用其自己冻结的版本复算）。
 */
export function computeReportHash(report: Omit<RunReport, 'reportId' | 'reportHash'>): string {
  if (report.runnerVersion === REPORT_HASH_VERSION_M10) {
    // m1.0 原公式：原样保留，供历史 m1.0 报告复算（不得改动）。
    return canonicalHash({
      status: report.status,
      comparisonMode: report.comparisonMode,
      policyId: report.policyId,
      policyVersionRowId: report.policyVersionRowId,
      currentRuntimeToolchainId: report.currentRuntimeToolchainId,
      coverage: report.coverage,
      summary: report.summary,
      runnerVersion: report.runnerVersion,
      cases: report.cases.map((c) => ({
        caseId: c.caseId,
        status: c.status,
        expectedInputHash: c.expectedInputHash ?? null,
        actualInputHash: c.actualInputHash ?? null,
        expectedOutputHash: c.expectedOutputHash ?? null,
        actualOutputHash: c.actualOutputHash ?? null,
      })),
    });
  }
  if (report.runnerVersion === REPORT_HASH_VERSION_M11) {
    // m1.1 原公式：**逐字冻结**，供历史 m1.1 报告复算（不得改动，否则破坏既有报告 + 绑其 reportHash
    // 的 drift approval）。m1.1 逐 case object 不含 caseHash（那是 m1.2 才加的）。
    return canonicalHash({
      reportHashVersion: report.runnerVersion,
      status: report.status,
      comparisonMode: report.comparisonMode,
      baselineSemantics: report.baselineSemantics,
      policyId: report.policyId,
      policyVersionRowId: report.policyVersionRowId,
      currentRuntimeToolchainId: report.currentRuntimeToolchainId,
      coverage: report.coverage,
      summary: report.summary,
      runnerVersion: report.runnerVersion,
      cases: report.cases
        .slice()
        .sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0))
        .map((c) => ({
          caseId: c.caseId,
          status: c.status,
          reason: c.reason ?? null,
          expectedDecision: c.expectedDecision ?? null,
          functionName: c.functionName,
          locale: c.locale,
          sourceKind: c.sourceKind,
          coverageTags: (c.coverageTags ?? []).slice().sort(),
          expectedInputHash: c.expectedInputHash ?? null,
          actualInputHash: c.actualInputHash ?? null,
          expectedOutputHash: c.expectedOutputHash ?? null,
          actualOutputHash: c.actualOutputHash ?? null,
          baselineToolchainId: c.baselineToolchainId ?? null,
          currentToolchainId: c.currentToolchainId ?? null,
        })),
    });
  }
  if (
    report.runnerVersion !== REPORT_HASH_VERSION_M12 &&
    report.runnerVersion !== REPORT_HASH_VERSION_M13 &&
    report.runnerVersion !== REPORT_HASH_VERSION_M14 &&
    report.runnerVersion !== REPORT_HASH_VERSION_M15
  ) {
    // 未知版本 fail-closed：不静默按新公式算，否则复算者拿到假的「可复算」hash。
    throw new Error(`unsupported reportHash runnerVersion: ${report.runnerVersion}`);
  }
  // m1.2/m1.3：在 m1.1 全字段基础上，逐 case **追加 caseHash + caseHashVersion**——把冻结 golden 的完整性
  // 哈希绑进报告哈希。签 reportHash 即承诺「我跑的是这些 caseHash 的 golden」；离线核验
  // （verifyReportIntegrity）再逐项比对承诺 caseHash vs 当前 golden，闭合验签。caseHashVersion 一并绑
  // （算法域分离：告诉核验者用哪套公式复算 caseHash，防 version-confusion）。逐 case object m1.2/m1.3 相同。
  const cases = report.cases
    .slice()
    .sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0))
    .map((c) => ({
      caseId: c.caseId,
      caseHash: c.caseHash,
      caseHashVersion: c.caseHashVersion,
      status: c.status,
      reason: c.reason ?? null,
      expectedDecision: c.expectedDecision ?? null,
      functionName: c.functionName,
      locale: c.locale,
      sourceKind: c.sourceKind,
      coverageTags: (c.coverageTags ?? []).slice().sort(),
      expectedInputHash: c.expectedInputHash ?? null,
      actualInputHash: c.actualInputHash ?? null,
      expectedOutputHash: c.expectedOutputHash ?? null,
      actualOutputHash: c.actualOutputHash ?? null,
      baselineToolchainId: c.baselineToolchainId ?? null,
      currentToolchainId: c.currentToolchainId ?? null,
    }));
  if (report.runnerVersion === REPORT_HASH_VERSION_M12) {
    // m1.2 逐字冻结（不含 signability）——供历史 m1.2 报告复算。
    return canonicalHash({
      reportHashVersion: report.runnerVersion,
      status: report.status,
      comparisonMode: report.comparisonMode,
      baselineSemantics: report.baselineSemantics,
      policyId: report.policyId,
      policyVersionRowId: report.policyVersionRowId,
      currentRuntimeToolchainId: report.currentRuntimeToolchainId,
      coverage: report.coverage,
      summary: report.summary,
      runnerVersion: report.runnerVersion,
      cases,
    });
  }
  if (report.runnerVersion === REPORT_HASH_VERSION_M13) {
    // m1.3 逐字冻结：m1.2 全字段 + 顶层 signability + unsignableLegacyCases。
    return canonicalHash({
      reportHashVersion: report.runnerVersion,
      status: report.status,
      signability: report.signability,
      unsignableLegacyCases: report.unsignableLegacyCases,
      comparisonMode: report.comparisonMode,
      baselineSemantics: report.baselineSemantics,
      policyId: report.policyId,
      policyVersionRowId: report.policyVersionRowId,
      currentRuntimeToolchainId: report.currentRuntimeToolchainId,
      coverage: report.coverage,
      summary: report.summary,
      runnerVersion: report.runnerVersion,
      cases,
    });
  }
  // m1.4（Item 4 F）：m1.3 全字段 + 顶层 unsignableReasons（canonical 排序）——把「完整不可签字原因」（含
  // TOOLCHAIN_PROVENANCE_UNVERIFIED）绑进报告哈希。★Codex 复审致命 2 + 复审2 建议 5：m1.4 编码必须**严格单射**
  // ——含未知/重复/非 canonical 序的 reason 一律 **throw**（不静默过滤/不宽容归一）。否则 [] 与 ['FORGED']、
  // 或 ['A','B'] 与 ['B','A','A'] 可能得同一 hash=非单射 + 版本混淆。用 isCanonicalReasonList 严格校验（与读路径
  // deriveReportSignabilityDetail 的 declaredConsistent 判定**同一约束**，防两处漂移），校验通过后按原样绑入。
  const declaredReasons = report.unsignableReasons ?? [];
  if (!isCanonicalReasonList(declaredReasons)) {
    throw new Error(`non-canonical or unsupported unsignableReasons in m1.4/m1.5 report: ${JSON.stringify(declaredReasons)}`);
  }
  // m1.4（Item 4 F）+ m1.5（S1）：共用同一 hash 公式（reportHashVersion=runnerVersion 已区分两版本）。
  // ★Codex 复审 P1-4：transition 证据（approvedTransitionManifestHash/transitionVerified）**不进** reportHash
  // ——报告是**不可变** artifact（0037 append-only），运行后无法把事后附加、**可撤销**的 manifest 证据写进报告；
  // 强行进 hash 会变死字段（恒 null）且自相矛盾（hash 承诺一个可撤销的东西）。证据由独立 manifest 表 + 读路径
  // 重新验签派生（deriveReportTransitionEvidence），报告 hash 只承诺 run 时事实。m1.5 与 m1.4 hash 结构相同，
  // 仅版本串不同（=不同 hash，正常）。
  return canonicalHash({
    reportHashVersion: report.runnerVersion,
    status: report.status,
    signability: report.signability,
    unsignableLegacyCases: report.unsignableLegacyCases,
    unsignableReasons: declaredReasons,
    comparisonMode: report.comparisonMode,
    baselineSemantics: report.baselineSemantics,
    policyId: report.policyId,
    policyVersionRowId: report.policyVersionRowId,
    currentRuntimeToolchainId: report.currentRuntimeToolchainId,
    coverage: report.coverage,
    summary: report.summary,
    runnerVersion: report.runnerVersion,
    cases,
  });
}

// ── 离线核验协议（verify 半，Codex 设计审 + 实现复审：commitment 必须被 verification 消费，且
//    verifier 必须从当前 golden **实际字段重算** caseHash，不能只信存储的 caseHash） ──

/** 报告承诺的 golden 完整性核验：某一 case 的比对结果。 */
export type CaseIntegrityStatus =
  | 'MATCH' // 三者相等：报告承诺 caseHash == 存储 caseHash == 从当前字段重算的 caseHash
  | 'CURRENT_GOLDEN_INTEGRITY_FAILURE' // 存储 caseHash ≠ 从当前字段重算（当前行内部不自洽：改了字段没改 caseHash）
  | 'CASE_HASH_MISMATCH' // 当前行自洽，但与报告承诺不符（golden 被替换/重算成另一自洽值）
  | 'LEGACY_WEAK_BINDING_CASE_HASH_VERSION' // 当前行自洽且匹配承诺，但 caseHashVersion 弱绑定（m1.0），不足签字（Item 2）
  | 'UNSUPPORTED_CASE_HASH_VERSION' // 当前行 caseHashVersion 未知，无法重算（fail-closed）
  | 'MISSING_IN_GOLDEN' // 报告承诺的 caseId 已不在当前 golden（被删/重冻换 id）
  | 'EXTRA_IN_GOLDEN'; // 当前 golden 有报告未覆盖的 case（覆盖集变化，签字集不再完整）

export interface CaseIntegrityResult {
  caseId: string;
  status: CaseIntegrityStatus;
  /** 报告承诺值（m1.2 报告才有；旧版报告为 null）。 */
  committedCaseHash: string | null;
  committedCaseHashVersion: string | null;
  /** 当前 golden 行**存储**的 caseHash/version（缺失时 null）。 */
  currentCaseHash: string | null;
  currentCaseHashVersion: string | null;
  /** 从当前 golden 行**实际字段重算**的 caseHash（未知版本/缺行时 null）。 */
  recomputedCaseHash: string | null;
}

/**
 * 离线核验结果：报告自身完整性 + 报告↔当前 golden 逐项比对（含当前行自洽性重算 + 结构校验）。
 *
 * ★口径（Codex 复审 #2，诚实不夸大）：这是**存储完整性 + 当前 golden 一致性**核验，**不**验证 CCO
 * 外部数字签名——{@code expectedReportHash} 由调用方传入（服务端封装传的是同库 reportHash 行值，只能
 * 检测「reportJson 被单独改」+「golden 与报告承诺不符」，不能检测「同时改 reportJson+reportHash」）。
 * 要证明「CCO 已签内容」，须由调用方传入来自可信签名 artifact 的 reportHash 并另行验签。
 */
export interface ReportIntegrityVerdict {
  /** 报告是否绑了 golden 承诺（m1.2+ 才在逐 case 绑 caseHash；旧版报告只能核验自身 hash）。 */
  goldenCommitmentSupported: boolean;
  /** 复算 reportHash 是否等于传入的 expectedReportHash（报告 JSON 相对该期望值未被改）。 */
  reportHashValid: boolean;
  recomputedReportHash: string;
  expectedReportHash: string;
  /** artifact 结构是否合法（report caseId 唯一 + golden id 唯一）。重复即 fail-closed。 */
  structurallyValid: boolean;
  /** ★Item 2：m1.3 顶层 signability/count 声明是否与 cases 事实一致（矛盾 artifact 即结构损坏）。 */
  signabilityConsistent: boolean;
  /** 从 cases 事实派生的签字资格（非顶层声明）。 */
  derivedSignability: ReportSignability;
  /** 每个 case 的完整性比对（含 MISSING/EXTRA/当前行不自洽）。 */
  cases: CaseIntegrityResult[];
  /** 全部满足：reportHash 有效 + 结构合法 + signability 声明自洽 + 支持 golden 承诺 + 所有 case MATCH。 */
  ok: boolean;
}

/**
 * 当前 golden 行——核验需要 id + 存储 caseHash/version + **computeCaseHash 所需的全部字段**
 * （以便从实际字段重算，抓「改字段没改 caseHash」的当前行不自洽）。
 */
export interface GoldenCaseSnapshot extends CaseHashFields {
  id: string;
  caseHash: string;
  caseHashVersion: string;
}

/** 找重复项（返回出现 >1 次的 key 集合）。 */
function findDuplicates(ids: string[]): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dup.add(id);
    else seen.add(id);
  }
  return dup;
}

/**
 * 离线核验一份报告的存储完整性 + 当前 golden 一致性（纯函数，无 I/O，可离线可单测）。
 *
 * 三层（缺一即假证明）：
 *  1. **报告自身完整性**：按报告冻结的 runnerVersion 复算 reportHash，比对 {@code expectedReportHash}。
 *  2. **结构合法性**：report caseId / golden id 各自唯一（防重复 caseId 双 MATCH 绕过）——重复即 fail-closed。
 *  3. **golden 承诺核验（三者相等）**：对每个报告 case，从当前 golden 行的**实际字段**用 computeCaseHash
 *     **重算** caseHash，要求 `报告承诺 caseHash == 存储 caseHash == 重算 caseHash` 且 version 一致才 MATCH：
 *       - 存储 ≠ 重算 → CURRENT_GOLDEN_INTEGRITY_FAILURE（当前行改了字段没改 caseHash，内部不自洽）；
 *       - 当前行自洽但 ≠ 报告承诺 → CASE_HASH_MISMATCH（golden 被换/重算成另一自洽值，与签字承诺不符）；
 *       - 当前行 caseHashVersion 未知 → UNSUPPORTED_CASE_HASH_VERSION（fail-closed）；
 *       - caseId 缺 → MISSING_IN_GOLDEN；golden 多出 → EXTRA_IN_GOLDEN。
 *
 * ★m1.0/m1.1 报告逐 case 不含 caseHash（承诺不存在）→ goldenCommitmentSupported=false，只核验报告自身
 * hash，不能证明 golden 未换（诚实标注，不假装核验没绑的东西）。
 *
 * ★Item 2：即使当前行自洽且匹配承诺，若其 caseHashVersion 弱绑定（m1.0，不在 SIGNABLE 集合）→
 * LEGACY_WEAK_BINDING_CASE_HASH_VERSION（不计 MATCH）。m1.0 自洽只证那 9 字段没变，证明不了 coverageTags/
 * toolchain 等签字级字段没被改。**所有报告版本**统一输出此诊断（不只 m1.2/m1.3 特判），避免同一 golden 在
 * 不同报告版本下诊断不一致。
 */
export function verifyReportIntegrity(
  report: Omit<RunReport, 'reportId' | 'reportHash'>,
  expectedReportHash: string,
  currentGolden: GoldenCaseSnapshot[]
): ReportIntegrityVerdict {
  const recomputedReportHash = computeReportHash(report);
  const reportHashValid = recomputedReportHash === expectedReportHash;

  // m1.2/m1.3 才在逐 case 绑了 caseHash——只有此时报告才承诺了 golden 完整性。
  const goldenCommitmentSupported = GOLDEN_COMMITMENT_REPORT_VERSIONS.has(report.runnerVersion);

  // 结构校验（fail-closed）：report caseId / golden id 各自唯一（防重复项双 MATCH 绕过）。
  const reportDup = findDuplicates(report.cases.map((c) => c.caseId));
  const goldenDup = findDuplicates(currentGolden.map((g) => g.id));
  const structurallyValid = reportDup.size === 0 && goldenDup.size === 0;

  const goldenById = new Map(currentGolden.map((g) => [g.id, g]));
  const reportCaseIds = new Set(report.cases.map((c) => c.caseId));
  const results: CaseIntegrityResult[] = [];

  for (const c of report.cases) {
    const g = goldenById.get(c.caseId);
    const committedCaseHash = c.caseHash ?? null;
    const committedCaseHashVersion = c.caseHashVersion ?? null;
    if (!g) {
      results.push({
        caseId: c.caseId,
        status: 'MISSING_IN_GOLDEN',
        committedCaseHash,
        committedCaseHashVersion,
        currentCaseHash: null,
        currentCaseHashVersion: null,
        recomputedCaseHash: null,
      });
      continue;
    }

    // ★从当前 golden 行的实际字段重算 caseHash（像 run 那样），抓「改字段没改 caseHash」。
    let recomputedCaseHash: string | null = null;
    try {
      recomputedCaseHash = computeCaseHash(g, g.caseHashVersion);
    } catch {
      // 未知 caseHashVersion → 无法重算，fail-closed。
      results.push({
        caseId: c.caseId,
        status: 'UNSUPPORTED_CASE_HASH_VERSION',
        committedCaseHash,
        committedCaseHashVersion,
        currentCaseHash: g.caseHash,
        currentCaseHashVersion: g.caseHashVersion,
        recomputedCaseHash: null,
      });
      continue;
    }

    let status: CaseIntegrityStatus;
    if (recomputedCaseHash !== g.caseHash) {
      // 当前行内部不自洽：字段被改，存储 caseHash 未随之更新。
      status = 'CURRENT_GOLDEN_INTEGRITY_FAILURE';
    } else if (
      !goldenCommitmentSupported ||
      committedCaseHash !== g.caseHash ||
      committedCaseHashVersion !== g.caseHashVersion
    ) {
      // 当前行自洽，但与报告签字承诺不符（golden 被换/重算成另一自洽值），或报告不支持承诺。
      status = 'CASE_HASH_MISMATCH';
    } else if (!isSignableCaseHashVersion(g.caseHashVersion)) {
      // ★Item 2：三者相等且当前行自洽，但 caseHashVersion 弱绑定（m1.0）——自洽只证 9 字段没变，
      // 不足签字。不计 MATCH（即使 committed==stored==recomputed，弱公式覆盖不足）。
      status = 'LEGACY_WEAK_BINDING_CASE_HASH_VERSION';
    } else {
      status = 'MATCH';
    }
    results.push({
      caseId: c.caseId,
      status,
      committedCaseHash,
      committedCaseHashVersion,
      currentCaseHash: g.caseHash,
      currentCaseHashVersion: g.caseHashVersion,
      recomputedCaseHash,
    });
  }

  // 当前 golden 里报告未覆盖的 case（签字覆盖集变化——多出未被证明的 golden）。
  for (const g of currentGolden) {
    if (!reportCaseIds.has(g.id)) {
      results.push({
        caseId: g.id,
        status: 'EXTRA_IN_GOLDEN',
        committedCaseHash: null,
        committedCaseHashVersion: null,
        currentCaseHash: g.caseHash,
        currentCaseHashVersion: g.caseHashVersion,
        recomputedCaseHash: null,
      });
    }
  }

  // ★Item 2：m1.3 顶层 signability/count 声明必须与 cases 事实一致——矛盾 artifact（自洽 reportHash 但
  // 声明造假）纳入 ok（否则 verify 返回「完整性 ok」+「不可签字」的残留双口径）。
  const sigDetail = deriveReportSignabilityDetail(report);

  const allCasesMatch = results.every((r) => r.status === 'MATCH');
  // ★F2（独立审查）：空报告（0 case）对空 golden，allCasesMatch 空真会给 ok=true——是**空证明**（vacuous）。
  // 无 case 的报告不构成签字级证据（现实里必是 NON_REPLAYABLE 不可签字，但 verdict.ok 直接暴露给客户端，
  // 加此守卫防被误当有效核验）。要求至少一个覆盖 case 才可能 ok。
  const hasCoveredCase = report.cases.length > 0;
  const ok =
    reportHashValid &&
    structurallyValid &&
    sigDetail.declaredConsistent &&
    goldenCommitmentSupported &&
    hasCoveredCase &&
    allCasesMatch;

  return {
    goldenCommitmentSupported,
    reportHashValid,
    recomputedReportHash,
    expectedReportHash,
    structurallyValid,
    signabilityConsistent: sigDetail.declaredConsistent,
    derivedSignability: sigDetail.casesDerivedSignability,
    cases: results,
    ok,
  };
}

/** tenant（=userId）是否开启回放留存（PII opt-in，ADR pii-admission/v1）。 */
async function isReplayRetentionEnabled(userId: string): Promise<boolean> {
  const u = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { replayRetentionEnabled: true },
  });
  return u?.replayRetentionEnabled ?? false;
}

/**
 * 从 Execution 冻结候选为 RegressionCase。
 *
 * ★候选谓词筛 replayabilityStatus='REPLAYABLE' + traceHash + canonical hash + toolchain 齐全（PR1，P0-3）——
 * M2.1b 后 writer 对满足条件的行写 REPLAYABLE（见 buildReplayColumns），故这里能筛到真实可回放行。
 * DISTINCT ON 同 (versionRow,function,locale,canonicalInput) 保最新一条。插入 ON CONFLICT DO
 * NOTHING 幂等。inputJson 仅 tenant opt-in 时存明文（否则 null → case replay-limited）。
 *
 * @param actorUserId 触发的 admin（createdBy）
 * @param ownerUserId 策略所属 tenant（决定 replayRetention opt-in）；不传则用 actorUserId
 */
export async function freezeFromExecutions(params: {
  policyId: string;
  policyVersionRowId?: string;
  limit?: number;
  actorUserId: string;
  ownerUserId?: string;
}): Promise<FreezeResult> {
  const { policyId, policyVersionRowId, actorUserId } = params;
  const limit = params.limit ?? 100;
  const ownerUserId = params.ownerUserId ?? actorUserId;
  const retentionEnabled = await isReplayRetentionEnabled(ownerUserId);

  // 候选谓词（ADR 附录 B.3）：canonical hash 地基完整 + 有回放上下文 + 无错误。
  // DISTINCT ON 去重同一 canonical input（保最新）。参数化防注入。
  const candidates = (await db.execute(sql`
    SELECT DISTINCT ON (
      e."policyVersionRowId", e."functionName", e."locale", e."canonicalInputHash"
    )
      e."id" AS "sourceExecutionId",
      e."policyId",
      e."policyVersionRowId",
      e."policyVersion",
      e."functionName",
      e."locale",
      COALESCE(e."aliasSetJson"::jsonb, '{}'::jsonb) AS "aliasSetJson",
      COALESCE(e."vocabSnapshotRef"::jsonb, '[]'::jsonb) AS "vocabSnapshotRef",
      e."input" AS "inputJson",
      e."canonicalInputHash",
      e."canonicalOutputHash" AS "expectedOutputHash",
      e."decision" AS "expectedDecision",
      e."canonicalizationVersion",
      e."runtimeToolchainId" AS "baselineRuntimeToolchainId",
      e."sourceToolchainId",
      pv."sourceEnvelopeSha256"
    FROM "Execution" e
    JOIN "PolicyVersion" pv ON pv."id" = e."policyVersionRowId"
    WHERE e."policyId" = ${policyId}
      AND (${policyVersionRowId ?? null}::text IS NULL OR e."policyVersionRowId" = ${policyVersionRowId ?? null})
      AND e."policyVersionRowId" IS NOT NULL
      AND e."functionName" IS NOT NULL
      AND e."locale" IS NOT NULL
      AND e."canonicalizationVersion" IS NOT NULL
      AND e."canonicalInputHash" IS NOT NULL
      AND e."canonicalOutputHash" IS NOT NULL
      AND e."input" IS NOT NULL
      AND e."error" IS NULL
      -- ★P0-3（CCO 复审）：只冻结宿主判定**可回放**的 execution。缺 traceHash / 缺基线工具链 /
      -- replayabilityStatus 非 REPLAYABLE 的行=宿主已判「无法逐字节复现当时决策」，把它们洗成
      -- runnable golden 会让报告假称「回放」。要求 REPLAYABLE + traceHash + baseline/source toolchain 齐全。
      -- （承 M2.1b：步骤级 trace + async→NON_REPLAYABLE 的宿主判定端到端接入冻结门。）
      AND e."replayabilityStatus" = 'REPLAYABLE'
      AND e."traceHash" IS NOT NULL
      AND e."runtimeToolchainId" IS NOT NULL
      AND e."sourceToolchainId" IS NOT NULL
    ORDER BY
      e."policyVersionRowId", e."functionName", e."locale", e."canonicalInputHash",
      e."createdAt" DESC
    LIMIT ${limit}
  `)) as unknown as Array<Record<string, unknown>>;

  const result: FreezeResult = { frozen: 0, duplicate: 0, skipped: 0, outputConflicts: [], caseIds: [], skippedReasons: [] };

  for (const c of candidates) {
    const caseHash = computeCaseHash({
      policyId: String(c.policyId),
      policyVersionRowId: String(c.policyVersionRowId),
      functionName: String(c.functionName),
      locale: String(c.locale),
      canonicalInputHash: String(c.canonicalInputHash),
      expectedOutputHash: String(c.expectedOutputHash),
      expectedDecision: c.expectedDecision == null ? null : String(c.expectedDecision),
      canonicalizationVersion: String(c.canonicalizationVersion),
      aliasSetJson: c.aliasSetJson,
      vocabSnapshotRef: c.vocabSnapshotRef,
      sourceKind: 'execution',
      coverageTags: [],
      baselineRuntimeToolchainId:
        c.baselineRuntimeToolchainId == null ? null : String(c.baselineRuntimeToolchainId),
      sourceToolchainId: c.sourceToolchainId == null ? null : String(c.sourceToolchainId),
      sourceEnvelopeSha256: c.sourceEnvelopeSha256 == null ? null : String(c.sourceEnvelopeSha256),
      sourceExecutionId: String(c.sourceExecutionId),
    });

    const inserted = await db
      .insert(regressionCases)
      .values({
        id: crypto.randomUUID(),
        policyId: String(c.policyId),
        policyVersionRowId: String(c.policyVersionRowId),
        policyVersion: c.policyVersion == null ? null : Number(c.policyVersion),
        functionName: String(c.functionName),
        locale: String(c.locale),
        aliasSetJson: (c.aliasSetJson as object) ?? {},
        vocabSnapshotRef: (c.vocabSnapshotRef as object) ?? [],
        // ★PII opt-in：仅 tenant 开留存时存明文 input；否则 null（replay-limited）。
        inputJson: retentionEnabled ? (c.inputJson as object) : null,
        canonicalInputHash: String(c.canonicalInputHash),
        expectedOutputHash: String(c.expectedOutputHash),
        expectedDecision: c.expectedDecision == null ? null : String(c.expectedDecision),
        canonicalizationVersion: String(c.canonicalizationVersion),
        sourceKind: 'execution',
        sourceExecutionId: String(c.sourceExecutionId),
        coverageTags: [],
        baselineRuntimeToolchainId:
          c.baselineRuntimeToolchainId == null ? null : String(c.baselineRuntimeToolchainId),
        sourceToolchainId: c.sourceToolchainId == null ? null : String(c.sourceToolchainId),
        sourceEnvelopeSha256: c.sourceEnvelopeSha256 == null ? null : String(c.sourceEnvelopeSha256),
        caseHash,
        caseHashVersion: CASE_HASH_VERSION,
        createdBy: actorUserId,
      })
      // 幂等：同 (versionRow,function,locale,canonicalInput) 已存在则跳过。
      .onConflictDoNothing({
        target: [
          regressionCases.policyVersionRowId,
          regressionCases.functionName,
          regressionCases.locale,
          regressionCases.canonicalInputHash,
        ],
      })
      .returning({ id: regressionCases.id });

    if (inserted.length > 0) {
      result.frozen++;
      result.caseIds.push(inserted[0].id);
    } else {
      // 冲突：查已有 case 是否 expectedOutputHash 不同（同 input 历史产不同 output=漂移信号）。
      // 不静默计 duplicate 吞掉证据（Codex 复审 #3）。
      const conflict = await detectOutputConflict(
        String(c.policyVersionRowId),
        String(c.functionName),
        String(c.locale),
        String(c.canonicalInputHash),
        String(c.expectedOutputHash)
      );
      if (conflict) {
        result.outputConflicts.push(conflict);
      } else {
        result.duplicate++;
      }
    }
  }

  return result;
}

/** 版本行里决定领域词汇的字段（与执行同一口径：已审批 / 已弃用取冻结快照，草稿取作者现行词汇）。 */
export interface VersionVocabularyRow {
  content: string;
  status: string | null;
  createdBy: string | null;
  vocabularySnapshotIds: unknown;
}

/**
 * 按 locale 取版本词汇（ADR 0051：名称按位置解析依赖词汇，回归基线与回放必须与执行同一份）。
 * 作用域按 locale 选取，同一 run 内各 case 的 locale 可能不同，按 locale 缓存只加载一次。
 * 严格加载：失败抛错而不退化为无词汇（否则基线 / 回放被静默算错），由 {@link caseVocabulary} 归类。
 */
export function versionVocabularyLoader(
  pv: VersionVocabularyRow,
): (locale: string) => Promise<Record<string, unknown> | undefined> {
  const cache = new Map<string, Promise<Record<string, unknown> | undefined>>();
  return (locale) => {
    const cached = cache.get(locale);
    if (cached) return cached;
    const loaded = loadVersionExecutionVocabulary({
      status: pv.status,
      vocabularySnapshotIds: pv.vocabularySnapshotIds,
      authorId: pv.createdBy,
      source: pv.content,
      locale,
    }, { strict: true });
    cache.set(locale, loaded);
    return loaded;
  };
}

/** case 词汇加载结果：失败时给出不可回放理由（词汇加载失败 / 作者词汇非法）。 */
export type CaseVocabulary =
  | { ok: true; vocabulary: Record<string, unknown> | undefined }
  | { ok: false; reason: 'VOCABULARY_UNAVAILABLE' | 'VOCABULARY_SCOPE_INVALID' };

/**
 * 取某个 case 用的版本词汇。词汇取不到时该 case 既不能算通过也不能算回归（不是策略行为变化），
 * 调用方据此标记不可回放 / 跳过冻结。
 */
export async function caseVocabulary(
  vocabularyFor: ((locale: string) => Promise<Record<string, unknown> | undefined>) | null,
  locale: string,
): Promise<CaseVocabulary> {
  if (!vocabularyFor) return { ok: true, vocabulary: undefined };
  try {
    return { ok: true, vocabulary: await vocabularyFor(locale) };
  } catch (err) {
    const scopeInvalid = err instanceof Error && err.name === 'VocabularyScopeError';
    if (!scopeInvalid) console.warn('[rule-regression] version vocabulary could not be loaded', err);
    return { ok: false, reason: scopeInvalid ? 'VOCABULARY_SCOPE_INVALID' : 'VOCABULARY_UNAVAILABLE' };
  }
}

/**
 * 用当前后端评估一个 source+input，返回权威 replayMetadata（canonical hashes + toolchain）。
 * 走 HMAC 内部调用 + replayCapture=true。失败抛（调用方决定如何处理）。
 */
export async function evaluateForCapture(params: {
  tenantId: string;
  actorUserId: string;
  source: string;
  input: Record<string, unknown> | unknown[];
  locale: string;
  functionName: string;
  aliasSet: Record<string, string[]> | null;
  /** 版本的领域词汇（DomainVocabulary JSON）；无则不带。 */
  vocabulary: Record<string, unknown> | undefined;
}): Promise<{
  canonicalInputHash: string | null;
  canonicalOutputHash: string | null;
  runtimeToolchainId: string | null;
  canonicalizationVersion: string | null;
  // ★P0-3（Codex 复审）：surface 宿主回放态——handwritten freeze 也据此 fail-closed（不冻不可回放）。
  replayabilityStatus: string | null;
  traceHash: string | null;
}> {
  const client = createPolicyApiClient(params.tenantId, params.actorUserId);
  const resp = await client.evaluateSource(params.source, params.input, {
    locale: params.locale,
    functionName: params.functionName,
    aliasSet: params.aliasSet,
    ...(params.vocabulary ? { vocabulary: params.vocabulary } : {}),
    replayCapture: true,
  });
  const rm = resp.replayMetadata;
  return {
    canonicalInputHash: rm?.canonicalInputHash ?? null,
    canonicalOutputHash: rm?.canonicalOutputHash ?? null,
    runtimeToolchainId: rm?.runtimeToolchainId ?? null,
    canonicalizationVersion: rm?.canonicalizationVersion ?? null,
    replayabilityStatus: rm?.replayabilityStatus ?? null,
    traceHash: rm?.traceHash ?? null,
  };
}

/**
 * 解析 PolicyVersion 的冻结 aliasSet（canonical JSON 串）→ Map。损坏视为无别名。
 */
function parseAliasSet(aliasSetRaw: string | null): Record<string, string[]> | null {
  if (!aliasSetRaw) return null;
  try {
    return JSON.parse(aliasSetRaw) as Record<string, string[]>;
  } catch {
    return null;
  }
}

/**
 * 冻结作者手写边界 case（ADR 附录 B.5 freeze.handwrittenCases）。
 *
 * 每个 case 用**当前后端**对对应 PolicyVersion.content 评估一次，取权威 canonical hashes 作为
 * expectedOutputHash 基线冻结。手写 case 目标是覆盖历史未跑到的边界（threshold/null/rounding）。
 * inputJson 同样受 tenant opt-in 约束。
 */
export async function freezeHandwritten(params: {
  policyId: string;
  cases: HandwrittenCaseInput[];
  actorUserId: string;
  ownerUserId?: string;
  tenantId: string;
}): Promise<FreezeResult> {
  const { policyId, cases, actorUserId, tenantId } = params;
  const ownerUserId = params.ownerUserId ?? actorUserId;
  const retentionEnabled = await isReplayRetentionEnabled(ownerUserId);
  const result: FreezeResult = { frozen: 0, duplicate: 0, skipped: 0, outputConflicts: [], caseIds: [], skippedReasons: [] };
  // 同一版本的多个 case 共用一个词汇加载器（按 locale 缓存），一次冻结每版本每 locale 只加载一次
  const vocabularyLoaders = new Map<string, ReturnType<typeof versionVocabularyLoader>>();

  for (const hc of cases) {
    // 载入版本内容 + 冻结 aliasSet + toolchain。★版本行必须属于本 policyId（Codex 复审 #2）：
    // 否则 handwritten case 可用 B 版本源码评估却存成 policyId=A → 跨 policy/tenant 证据混淆。
    const pv = await db.query.policyVersions.findFirst({
      where: and(eq(policyVersions.id, hc.policyVersionRowId), eq(policyVersions.policyId, policyId)),
      columns: {
        id: true,
        content: true,
        aliasSet: true,
        sourceToolchainId: true,
        sourceEnvelopeSha256: true,
        vocabularySnapshotIds: true,
        version: true,
        status: true,
        createdBy: true,
      },
    });
    if (!pv) {
      result.skipped++;
      result.skippedReasons.push(`version_not_found_or_policy_mismatch:${hc.policyVersionRowId}`);
      continue;
    }

    const locale = hc.locale ?? detectCNLLocale(pv.content);
    const aliasSet = parseAliasSet(pv.aliasSet);

    const loader = vocabularyLoaders.get(pv.id) ?? versionVocabularyLoader(pv);
    vocabularyLoaders.set(pv.id, loader);
    const vocab = await caseVocabulary(loader, locale);
    if (!vocab.ok) {
      result.skipped++;
      result.skippedReasons.push(`${vocab.reason.toLowerCase()}:${hc.functionName}`);
      continue;
    }

    let captured;
    try {
      captured = await evaluateForCapture({
        tenantId,
        actorUserId,
        source: pv.content,
        input: hc.input,
        locale,
        functionName: hc.functionName,
        aliasSet,
        vocabulary: vocab.vocabulary,
      });
    } catch (e) {
      result.skipped++;
      result.skippedReasons.push(
        `evaluate_failed:${hc.functionName}:${e instanceof Error ? e.message : String(e)}`
      );
      continue;
    }

    // 缺权威 hash（后端未返回 replayMetadata / 非 HMAC 调用）→ 无法冻结基线，跳过。
    if (!captured.canonicalInputHash || !captured.canonicalOutputHash || !captured.canonicalizationVersion) {
      result.skipped++;
      result.skippedReasons.push(`missing_replay_metadata:${hc.functionName}`);
      continue;
    }
    // ★P0-3（Codex 复审）：handwritten 也 fail-closed——宿主判定不可回放（非 REPLAYABLE / 缺 traceHash /
    // 缺 runtimeToolchainId）的 evaluation 不冻结成 golden，否则与 execution 洗态同一漏洞（async/缺 trace
    // 的 handwritten 若后来 toolchain 不同就成 runnable case）。
    if (
      captured.replayabilityStatus !== 'REPLAYABLE' ||
      !captured.traceHash ||
      !captured.runtimeToolchainId
    ) {
      result.skipped++;
      result.skippedReasons.push(
        `not_replayable:${hc.functionName}:${captured.replayabilityStatus ?? 'unknown'}`
      );
      continue;
    }

    const caseHash = computeCaseHash({
      policyId,
      policyVersionRowId: pv.id,
      functionName: hc.functionName,
      locale,
      canonicalInputHash: captured.canonicalInputHash,
      expectedOutputHash: captured.canonicalOutputHash,
      expectedDecision: null,
      canonicalizationVersion: captured.canonicalizationVersion,
      aliasSetJson: aliasSet ?? {},
      vocabSnapshotRef: pv.vocabularySnapshotIds ?? [],
      sourceKind: 'handwritten',
      coverageTags: hc.coverageTags,
      baselineRuntimeToolchainId: captured.runtimeToolchainId,
      sourceToolchainId: pv.sourceToolchainId ?? null,
      sourceEnvelopeSha256: pv.sourceEnvelopeSha256 ?? null,
      sourceExecutionId: null,
    });

    const inserted = await db
      .insert(regressionCases)
      .values({
        id: crypto.randomUUID(),
        policyId,
        policyVersionRowId: pv.id,
        policyVersion: pv.version ?? null,
        functionName: hc.functionName,
        locale,
        aliasSetJson: aliasSet ?? {},
        vocabSnapshotRef: pv.vocabularySnapshotIds ?? [],
        inputJson: retentionEnabled ? (hc.input as object) : null,
        canonicalInputHash: captured.canonicalInputHash,
        expectedOutputHash: captured.canonicalOutputHash,
        expectedDecision: null,
        canonicalizationVersion: captured.canonicalizationVersion,
        sourceKind: 'handwritten',
        sourceExecutionId: null,
        // 手写 case 至少带 boundary 标签（覆盖门禁靠它）；调用方传入的 tags 合并。
        coverageTags: hc.coverageTags,
        baselineRuntimeToolchainId: captured.runtimeToolchainId,
        sourceToolchainId: pv.sourceToolchainId ?? null,
        sourceEnvelopeSha256: pv.sourceEnvelopeSha256 ?? null,
        caseHash,
        caseHashVersion: CASE_HASH_VERSION,
        createdBy: actorUserId,
      })
      .onConflictDoNothing({
        target: [
          regressionCases.policyVersionRowId,
          regressionCases.functionName,
          regressionCases.locale,
          regressionCases.canonicalInputHash,
        ],
      })
      .returning({ id: regressionCases.id });

    if (inserted.length > 0) {
      result.frozen++;
      result.caseIds.push(inserted[0].id);
    } else {
      const conflict = await detectOutputConflict(
        pv.id,
        hc.functionName,
        locale,
        captured.canonicalInputHash,
        captured.canonicalOutputHash
      );
      if (conflict) {
        result.outputConflicts.push(conflict);
      } else {
        result.duplicate++;
      }
    }
  }

  return result;
}

/**
 * 对已冻结的 RegressionCase 跑回归（ADR 附录 B.5 run）。
 *
 * 流程：载入某版本冻结 case → 逐 runnable case 用当前后端 replay → canonical-diff
 * actualOutputHash vs expectedOutputHash → 覆盖门禁 → 四态状态 → 落 RegressionReport。
 *
 * ★状态优先级（ADR 附录 B.4，防假通过）：
 *   1. 无 case 或全不可运行 → NON_REPLAYABLE
 *   2. 覆盖不达标 → FAIL_INSUFFICIENT_COVERAGE
 *   3. 任一 runnable case hash mismatch（或编译/评估失败）→ FAIL_REGRESSION
 *   4. 否则 → PASS
 * 即使全部 match，覆盖不足也不 PASS。
 *
 * replay-limited case（inputJson=null，未开 PII 留存）→ 该 case NON_REPLAYABLE，不计入
 * runnable，不参与 pass/fail（不静默算通过）。
 */
export async function run(params: {
  policyId: string;
  policyVersionRowId: string;
  actorUserId: string;
  tenantId: string;
}): Promise<RunReport> {
  const { policyId, policyVersionRowId, actorUserId, tenantId } = params;
  // ★P0-2（CCO 复审）：签字模式覆盖门禁恒用 DEFAULT_THRESHOLDS，**不接受请求级下调**。
  // 若确需放宽须走独立 CCO approval artifact（另表，非临时降阈值）——否则同一 admin 既定阈值
  // 又跑又得 PASS，报告无法证明门禁未为本次升级临时放宽。
  const thresholds: CoverageThresholds = DEFAULT_THRESHOLDS;

  // 载入该版本的所有冻结 case。★P0-5（CCO 复审）：稳定 orderBy(id)——同一 case 集必须以固定
  // 顺序进 reportHash，否则返回序不同算出不同 hash，破坏「同内容可复算」。
  const cases = await db.query.regressionCases.findMany({
    where: and(
      eq(regressionCases.policyId, policyId),
      eq(regressionCases.policyVersionRowId, policyVersionRowId)
    ),
    orderBy: (t, { asc }) => [asc(t.id)],
  });

  // 载入版本内容（replay 需要 source）。★绑 policyId（Codex 复审 #2）：防消费脏 case 用错 policy 版本。
  const pv = await db.query.policyVersions.findFirst({
    where: and(eq(policyVersions.id, policyVersionRowId), eq(policyVersions.policyId, policyId)),
    columns: { id: true, content: true, aliasSet: true, status: true, createdBy: true, vocabularySnapshotIds: true },
  });

  const details: CaseRunDetail[] = [];
  let passed = 0;
  let failed = 0;
  let nonReplayable = 0;
  let compileFailures = 0;
  // 所有成功 capture 的 current toolchain（含 input-mismatch case）——用于 mixed 检测（不漏）。
  const capturedCurrentToolchains = new Set<string>();

  const aliasSet = pv ? parseAliasSet(pv.aliasSet) : null;
  const vocabularyFor = pv ? versionVocabularyLoader(pv) : null;

  for (const c of cases) {
    const base: CaseRunDetail = {
      caseId: c.id,
      status: 'NON_REPLAYABLE',
      // ★m1.2：冻结 case 完整性哈希 + 公式版本进每个 detail（base 展开→全分支带上，含失败 detail）。
      caseHash: c.caseHash,
      caseHashVersion: c.caseHashVersion,
      expectedInputHash: c.canonicalInputHash,
      expectedOutputHash: c.expectedOutputHash,
      expectedDecision: c.expectedDecision,
      functionName: c.functionName,
      locale: c.locale,
      coverageTags: Array.isArray(c.coverageTags) ? (c.coverageTags as string[]) : [],
      sourceKind: c.sourceKind,
    };

    // ★P0-6（CCO 复审）：run 前重算 caseHash 并与存储值比对。expectedOutputHash/input/覆盖元数据
    // 被篡改后存储 hash 不再匹配 → 报证据损坏（GOLDEN_INTEGRITY_FAILURE），该 case 不参与业务判定
    // （标 FAIL_REGRESSION，不算 runnable-PASS——不可信 golden 不能证明无漂移）。按 case 自己的
    // caseHashVersion 选公式（新旧共存，见 CASE_HASH_VERSION）。
    // 未知 caseHashVersion → computeCaseHash 抛错（fail-closed）；这里捕获并标证据损坏，不崩整个 run。
    let recomputedCaseHash: string;
    try {
      recomputedCaseHash = computeCaseHash(
        {
          policyId: c.policyId,
          policyVersionRowId: c.policyVersionRowId,
          functionName: c.functionName,
          locale: c.locale,
          canonicalInputHash: c.canonicalInputHash,
          expectedOutputHash: c.expectedOutputHash,
          expectedDecision: c.expectedDecision,
          canonicalizationVersion: c.canonicalizationVersion,
          aliasSetJson: c.aliasSetJson,
          vocabSnapshotRef: c.vocabSnapshotRef,
          sourceKind: c.sourceKind,
          coverageTags: Array.isArray(c.coverageTags) ? (c.coverageTags as string[]) : [],
          baselineRuntimeToolchainId: c.baselineRuntimeToolchainId,
          sourceToolchainId: c.sourceToolchainId,
          sourceEnvelopeSha256: c.sourceEnvelopeSha256,
          sourceExecutionId: c.sourceExecutionId,
        },
        c.caseHashVersion
      );
    } catch {
      failed++;
      details.push({ ...base, status: 'FAIL_REGRESSION', reason: 'GOLDEN_INTEGRITY_FAILURE_UNKNOWN_VERSION' });
      continue;
    }
    if (recomputedCaseHash !== c.caseHash) {
      failed++;
      details.push({ ...base, status: 'FAIL_REGRESSION', reason: 'GOLDEN_INTEGRITY_FAILURE' });
      continue;
    }

    // ★Item 2：case 自洽（上面已证）但 caseHashVersion 不可签字（m1.0 弱绑定）→ 不参与 runnable-PASS。
    // 放在自洽校验**之后**：先区分「证据已损坏」(GOLDEN_INTEGRITY_FAILURE) vs「证据没损坏但证明力不够」。
    // m1.0 公式没绑 coverageTags/toolchain/decision 等签字级字段，自洽不代表那些字段没被改。
    if (!isSignableCaseHashVersion(c.caseHashVersion)) {
      nonReplayable++;
      details.push({ ...base, reason: 'LEGACY_UNSIGNABLE_CASE_HASH_VERSION' });
      continue;
    }

    // replay-limited：无明文 input 无法 replay。
    if (c.inputJson == null) {
      nonReplayable++;
      details.push({ ...base, reason: 'REPLAY_LIMITED_NO_INPUT' });
      continue;
    }
    // 版本内容缺失（版本被删/查不到）→ 无法编译 replay。
    if (!pv) {
      nonReplayable++;
      details.push({ ...base, reason: 'POLICY_VERSION_NOT_FOUND' });
      continue;
    }

    // 词汇取不到：无法按与执行同一份编译输入回放，标不可回放（不算通过，也不算策略回归）
    const vocab = await caseVocabulary(vocabularyFor, c.locale);
    if (!vocab.ok) {
      nonReplayable++;
      details.push({ ...base, reason: vocab.reason });
      continue;
    }

    let captured;
    try {
      captured = await evaluateForCapture({
        tenantId,
        actorUserId,
        source: pv.content,
        input: c.inputJson as Record<string, unknown> | unknown[],
        locale: c.locale,
        functionName: c.functionName,
        aliasSet,
        vocabulary: vocab.vocabulary,
      });
    } catch (e) {
      // 编译/评估失败 = 回归（Layer 1 编译漂移）。
      compileFailures++;
      failed++;
      details.push({
        ...base,
        status: 'FAIL_REGRESSION',
        reason: `EVALUATE_FAILED:${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    // ★P0-1（CCO 复审，最致命）：强制 baseline≠current toolchain。M1 FROZEN_BASELINE_VS_CURRENT_BACKEND
    // 的可信前提=冻结基线在**旧**工具链下捕获、run 在**新**工具链下回放。若团队升级**后**才 freeze，
    // 基线捕获的是新行为→新后端自比自己→假 PASS（报告没证明升级前后无漂移）。故：
    //   缺 baselineRuntimeToolchainId / 缺 current / 两者相同 → 该 case NON_REPLAYABLE（不算 runnable-PASS）。
    // 诚实标注：这些 case 无法证明「跨升级无漂移」，绝不能计入证明升级安全的 PASS 分母。
    if (
      !c.baselineRuntimeToolchainId ||
      !captured.runtimeToolchainId ||
      c.baselineRuntimeToolchainId === captured.runtimeToolchainId
    ) {
      nonReplayable++;
      const reason = !c.baselineRuntimeToolchainId
        ? 'MISSING_BASELINE_TOOLCHAIN'
        : !captured.runtimeToolchainId
          ? 'MISSING_CURRENT_TOOLCHAIN'
          : 'BASELINE_EQUALS_CURRENT_TOOLCHAIN';
      details.push({
        ...base,
        baselineToolchainId: c.baselineRuntimeToolchainId ?? undefined,
        currentToolchainId: captured.runtimeToolchainId ?? undefined,
        reason,
      });
      continue;
    }

    // ★到此 P0-1 已保证 baseline/current toolchain 齐全且不等。把它们写进**每个成功 capture 后的**
    // detail（PASS/FAIL/mismatch 全带，Codex 复审：否则新 reportHash 字段对有效 case 恒 null + mixed
    // 检测漏掉只出现在 input-mismatch case 的 toolchain）。记录本次 current toolchain 供 mixed 检测。
    const toolchainPair = {
      baselineToolchainId: c.baselineRuntimeToolchainId ?? undefined,
      currentToolchainId: captured.runtimeToolchainId ?? undefined,
    };
    capturedCurrentToolchains.add(captured.runtimeToolchainId);

    // 缺权威 output hash（后端未返回）→ 无法比对，不算通过。
    if (!captured.canonicalOutputHash) {
      nonReplayable++;
      details.push({ ...base, ...toolchainPair, reason: 'MISSING_ACTUAL_OUTPUT_HASH' });
      continue;
    }

    // ★校验 actual input hash（Codex 复审 #1）：证明回放的确是冻结时的同一 canonical input。
    // inputJson 被误写/篡改成另一输入时，即使 output hash 恰好相等也不能算通过——否则回放地基
    // 无法证明「跑的是 golden input」。缺/不等 → FAIL_REGRESSION（回放前提被破坏）。
    if (!captured.canonicalInputHash || captured.canonicalInputHash !== c.canonicalInputHash) {
      failed++;
      details.push({
        ...base,
        ...toolchainPair,
        status: 'FAIL_REGRESSION',
        actualInputHash: captured.canonicalInputHash ?? undefined,
        actualOutputHash: captured.canonicalOutputHash,
        reason: 'INPUT_HASH_MISMATCH',
      });
      continue;
    }

    const actualOutputHash = captured.canonicalOutputHash;
    if (actualOutputHash === c.expectedOutputHash) {
      passed++;
      details.push({
        ...base,
        ...toolchainPair,
        status: 'PASS',
        actualInputHash: captured.canonicalInputHash,
        actualOutputHash,
      });
    } else {
      failed++;
      details.push({
        ...base,
        ...toolchainPair,
        status: 'FAIL_REGRESSION',
        actualInputHash: captured.canonicalInputHash,
        actualOutputHash,
        reason: 'OUTPUT_HASH_MISMATCH',
      });
    }
  }

  // ★P0-1 补（Codex 复审 2）：混合 current toolchain 处理（纯函数，可单测）——只降 PASS，保留真实失败。
  const summary = applyMixedToolchainDowngrade(
    details,
    { passed, failed, nonReplayable, compileFailures },
    capturedCurrentToolchains
  );
  ({ passed, failed, nonReplayable, compileFailures } = summary);
  // 顶层 current toolchain：唯一则取该值，混合或无则 null（不取「最后一个」误导）。
  const currentRuntimeToolchainId =
    capturedCurrentToolchains.size === 1 ? [...capturedCurrentToolchains][0] : null;

  // 纯决策核心（覆盖门禁 + 状态优先级）——抽出以便单测不需 mock DB/backend。
  const reportBody = assembleReport({
    policyId,
    policyVersionRowId,
    cases: cases.map((c) => ({
      id: c.id,
      expectedDecision: c.expectedDecision,
      sourceKind: c.sourceKind,
      coverageTags: Array.isArray(c.coverageTags) ? (c.coverageTags as string[]) : [],
    })),
    details,
    summary: { passed, failed, nonReplayable, compileFailures },
    currentRuntimeToolchainId,
    thresholds,
  });

  const reportHash = computeReportHash(reportBody);
  const reportId = crypto.randomUUID();
  const { status } = reportBody;
  const { runnableCases } = reportBody.coverage;

  await db.insert(regressionReports).values({
    id: reportId,
    policyId,
    policyVersionRowId,
    status,
    comparisonMode: COMPARISON_MODE_FROZEN_BASELINE,
    caseCount: cases.length,
    runnableCaseCount: runnableCases,
    passedCaseCount: passed,
    failedCaseCount: failed,
    nonReplayableCaseCount: nonReplayable,
    coverageJson: reportBody.coverage,
    reportJson: reportBody as unknown as object,
    reportHash,
    currentRuntimeToolchainId,
    createdBy: actorUserId,
  });

  return { ...reportBody, reportId, reportHash };
}

export interface RunSummary {
  passed: number;
  failed: number;
  nonReplayable: number;
  compileFailures: number;
}

/**
 * 混合 current toolchain 降级（纯函数，可单测）。★Codex 复审 2：capturedCurrentToolchains 出现 >1 个
 * 不同 runtime toolchain 时，只把 **PASS** 降为 NON_REPLAYABLE（PASS 在混合后端下无法证明升级安全），
 * **保留** 所有 FAIL_REGRESSION（含 GOLDEN_INTEGRITY_FAILURE/EVALUATE_FAILED/INPUT_HASH_MISMATCH）与既有
 * NON_REPLAYABLE 原状态——真实失败/证据损坏是独立事实，不能被 mixed 洗白。原地改 details 状态，返回新计数。
 */
export function applyMixedToolchainDowngrade(
  details: CaseRunDetail[],
  summary: RunSummary,
  capturedCurrentToolchains: Set<string>
): RunSummary {
  if (capturedCurrentToolchains.size <= 1) return summary;
  let { passed } = summary;
  let { nonReplayable } = summary;
  for (const d of details) {
    if (d.status === 'PASS') {
      passed--;
      nonReplayable++;
      d.status = 'NON_REPLAYABLE';
      d.reason = 'MIXED_CURRENT_TOOLCHAIN';
    }
  }
  return { ...summary, passed, nonReplayable };
}

/** 覆盖统计需要的 case 元信息（纯决策核心用，不含 DB 行全字段）。 */
export interface CaseCoverageMeta {
  id: string;
  expectedDecision: string | null;
  sourceKind: string;
  coverageTags: string[];
}

/**
 * ★不可签字原因的**唯一事实派生源**（assembleReport 产生 + deriveReportSignabilityDetail 读路径共用，
 * 防两处漂移）。全从**报告声称的业务结果 + 版本政策**派生，**不由可删/可改的 artifact 字段决定**（Codex
 * 复审致命 1：用 case 的 toolchain pair 当开关=自证漏洞，攻击者设相等/删除即消除 reason）：
 *
 * - `LEGACY_CASE_HASH_VERSION`：任何 case 的 caseHashVersion 不可签字（m1.0 弱绑定，cases 事实）。
 * - `GOLDEN_COMMITMENT_UNSUPPORTED`：报告版本不含 golden 承诺（m1.0/m1.1，版本事实）。
 * - `TOOLCHAIN_PROVENANCE_UNVERIFIED`：★Item 4 F——报告**声称跨升级安全**（status===PASS，或存在可审批的
 *   OUTPUT_HASH_MISMATCH drift——这两者都在 FROZEN_BASELINE_VS_CURRENT 语义下声称通过了跨 toolchain 门禁），
 *   但 cloud **无 runtime provenance 第 3 层 verifier**（版本政策：当前**所有**版本恒缺，无可翻 true 开关，
 *   未来 E+D 落地再 bump m1.5）。★由 **status/reason 事实**判「是否需 provenance」，toolchain pair 只作诊断，
 *   不当开关。
 *
 * @param status 报告 status（判「是否声称跨升级安全」）。
 * @param goldenCommitmentSupported 该报告版本是否绑了 golden 承诺（m1.2+）。
 */
function deriveUnsignableReasons(
  cases: Pick<CaseRunDetail, 'caseHashVersion' | 'status' | 'reason'>[],
  status: RegressionReportStatus,
  goldenCommitmentSupported: boolean
): UnsignableReason[] {
  const reasons = new Set<UnsignableReason>();
  if (cases.some((c) => !c.caseHashVersion || !isSignableCaseHashVersion(c.caseHashVersion))) {
    reasons.add('LEGACY_CASE_HASH_VERSION');
  }
  if (!goldenCommitmentSupported) {
    reasons.add('GOLDEN_COMMITMENT_UNSUPPORTED');
  }
  // ★F（Codex 复审致命 1）：「是否需 provenance」由**报告声称的业务结果**决定，非 artifact 字段。
  // status===PASS = 报告声称通过了跨 toolchain 门禁（FROZEN_BASELINE_VS_CURRENT 语义）；可审批的
  // OUTPUT_HASH_MISMATCH = 声称是升级后输出漂移（同样跨升级语义）。两者恒加 provenance reason（F 阶段无第 3 层）。
  const claimsCrossUpgrade =
    status === 'PASS' ||
    cases.some((c) => c.status === 'FAIL_REGRESSION' && c.reason === 'OUTPUT_HASH_MISMATCH');
  if (claimsCrossUpgrade) {
    reasons.add('TOOLCHAIN_PROVENANCE_UNVERIFIED');
  }
  return canonicalizeReasons(reasons);
}

/**
 * 纯决策核心（ADR 附录 B.4）——覆盖门禁 + 四态状态优先级。抽出以便单测不需 mock DB/backend。
 *
 * ★状态优先级（防假通过）：
 *   1. 无 case 或全不可运行 → NON_REPLAYABLE
 *   2. 覆盖不达标 → FAIL_INSUFFICIENT_COVERAGE
 *   3. 任一 runnable case 失败（hash mismatch / 编译失败）→ FAIL_REGRESSION
 *   4. 否则 → PASS
 * 即使全 match，覆盖不足也不 PASS。
 */
export function assembleReport(params: {
  policyId: string;
  policyVersionRowId: string;
  cases: CaseCoverageMeta[];
  details: CaseRunDetail[];
  summary: { passed: number; failed: number; nonReplayable: number; compileFailures: number };
  currentRuntimeToolchainId: string | null;
  thresholds: CoverageThresholds;
}): Omit<RunReport, 'reportId' | 'reportHash'> {
  const { policyId, policyVersionRowId, cases, details, summary, currentRuntimeToolchainId, thresholds } = params;

  const runnableIds = new Set(
    details.filter((d) => d.status === 'PASS' || d.status === 'FAIL_REGRESSION').map((d) => d.caseId)
  );
  const runnableCases = runnableIds.size;
  const approvedCases = cases.filter((c) => c.expectedDecision === 'approved' && runnableIds.has(c.id)).length;
  const deniedCases = cases.filter((c) => c.expectedDecision === 'denied' && runnableIds.has(c.id)).length;
  const handwrittenBoundaryCases = cases.filter(
    (c) => c.sourceKind === 'handwritten' && c.coverageTags.includes('boundary') && runnableIds.has(c.id)
  ).length;

  const unmet: string[] = [];
  if (runnableCases < thresholds.minRunnableCases)
    unmet.push(`runnable<${thresholds.minRunnableCases} (${runnableCases})`);
  if (approvedCases < thresholds.minApprovedCases)
    unmet.push(`approved<${thresholds.minApprovedCases} (${approvedCases})`);
  if (deniedCases < thresholds.minDeniedCases)
    unmet.push(`denied<${thresholds.minDeniedCases} (${deniedCases})`);
  if (handwrittenBoundaryCases < thresholds.minHandwrittenBoundaryCases)
    unmet.push(`handwrittenBoundary<${thresholds.minHandwrittenBoundaryCases} (${handwrittenBoundaryCases})`);

  let status: RegressionReportStatus;
  if (cases.length === 0 || runnableCases === 0) {
    status = 'NON_REPLAYABLE';
  } else if (unmet.length > 0) {
    status = 'FAIL_INSUFFICIENT_COVERAGE';
  } else if (summary.failed > 0) {
    status = 'FAIL_REGRESSION';
  } else {
    status = 'PASS';
  }

  // ★Item 2/4：签字资格（独立于 status）。从**事实**派生（非 reason 流程）。unsignableLegacyCases 保持
  // Item 2 语义（进 m1.3/m1.4 hash）；unsignableReasons 是 Item 4 F 的完整多维原因（含 TOOLCHAIN_PROVENANCE
  // _UNVERIFIED）。signability 二值兼容 Item 2：任一 reason 非空 → UNSIGNABLE。可签字通过=status===PASS &&
  // signability===SIGNABLE（报告在哈希层宣告不可签字，防双口径）。
  const unsignableLegacyCases = details.filter(
    (d) => !isSignableCaseHashVersion(d.caseHashVersion)
  ).length;
  // 新报告版本 = RULE_REGRESSION_RUNNER_VERSION（m1.4，∈ GOLDEN_COMMITMENT_REPORT_VERSIONS）→ 有 golden 承诺。
  const unsignableReasons = deriveUnsignableReasons(
    details,
    status,
    GOLDEN_COMMITMENT_REPORT_VERSIONS.has(RULE_REGRESSION_RUNNER_VERSION)
  );
  // ★signability 反映**完整** reasons——任一 reason 非空 → UNSIGNABLE（真二值，Codex 复审：provenance-only
  // 报告不能返回 LEGACY 枚举=自相矛盾）。具体原因见 unsignableReasons。
  const signability: ReportSignability =
    unsignableReasons.length > 0 ? 'UNSIGNABLE' : 'SIGNABLE';

  return {
    status,
    comparisonMode: COMPARISON_MODE_FROZEN_BASELINE,
    baselineSemantics: BASELINE_SEMANTICS,
    policyId,
    policyVersionRowId,
    currentRuntimeToolchainId,
    coverage: {
      totalCases: cases.length,
      runnableCases,
      approvedCases,
      deniedCases,
      handwrittenBoundaryCases,
      thresholds,
      unmet,
    },
    summary,
    cases: details,
    runnerVersion: RULE_REGRESSION_RUNNER_VERSION,
    signability,
    unsignableLegacyCases,
    unsignableReasons,
    // ★S1（m1.5）：新 run 产报告时**无** transition 证据（manifest 由后续独立批准流程附加）。默认 null。
    // ★铁律：这两个字段是额外证据，**不**进 signability/unsignableReasons 派生——携证据的报告仍 UNSIGNABLE。
    approvedTransitionManifestHash: null,
    transitionVerified: null,
  };
}

/**
 * 统一派生一份报告的签字资格（Codex 复审：所有消费端——list API / UI / approval / effective status——
 * **共用**本 helper，防消费端漂移出现「report PASS 但被派生成可签字/ACCEPTED」双口径）。
 *
 * - m1.3：直接读顶层 signability（已冻结进 reportHash）。
 * - m1.2：顶层无 signability 字段，从 cases 的 caseHashVersion 事实派生（含任何非 signable → UNSIGNABLE）。
 * - m1.0/m1.1：无 golden 承诺（cases 不含 caseHashVersion），无法证明 golden 完整性 → 一律 UNSIGNABLE
 *   （诚实：旧版报告不支持签字级证明，不假装可签字）。
 */
/** 签字资格派生结果（结构化，Codex 复审：API 用**派生** count 而非不可信的原始声明）。 */
export interface SignabilityDerivation {
  /** 有效签字资格（矛盾 artifact fail-closed 为 UNSIGNABLE）——消费端判定用此。 */
  signability: ReportSignability;
  /** 纯从 cases caseHashVersion 事实派生的签字资格（**不**因声明矛盾而 fail-closed；诊断用）。 */
  casesDerivedSignability: ReportSignability;
  /** 从 cases 事实派生的不可签字 case 数（唯一真相源，非顶层声明）。 */
  unsignableLegacyCases: number;
  /**
   * ★Item 4 F：从**事实 + 版本政策**派生的**完整**不可签字原因（封闭枚举 canonical 排序）。含
   * TOOLCHAIN_PROVENANCE_UNVERIFIED（版本政策：cloud 无 runtime provenance 第 3 层 → 声称跨升级的报告恒缺）。
   * 消费端「可签字通过」以此为准：reasons 非空 → 不可签字。
   */
  unsignableReasons: UnsignableReason[];
  /** m1.4 顶层声明（signability + count + reasons）是否与派生事实一致（矛盾即 artifact 结构损坏，fail-closed）。 */
  declaredConsistent: boolean;
  /**
   * ★golden 完整性维度是否可信（unsignableReasons 排除 provenance 后为空 + 声明自洽）。「受控接受漂移」
   * （ACCEPTED_DRIFT_WITH_APPROVAL）以此为前置门——与全维度 signability 正交（provenance 缺失不阻断审批）。
   * 见 [[GOLDEN_INTEGRITY_UNSIGNABLE_REASONS]] 注释。
   */
  goldenIntegritySignable: boolean;
}

/**
 * 派生一份报告的签字资格（结构化）。从 cases 的 caseHashVersion **事实**推导（唯一真相源），对 m1.3
 * 还校验顶层声明是否与事实一致——矛盾 artifact（自洽 reportHash 但声明造假）fail-closed 为 UNSIGNABLE。
 */
export function deriveReportSignabilityDetail(
  report: Pick<RunReport, 'runnerVersion' | 'signability' | 'cases' | 'unsignableLegacyCases' | 'unsignableReasons' | 'status'>
): SignabilityDerivation {
  const derivedUnsignable = report.cases.filter(
    (c) => !c.caseHashVersion || !isSignableCaseHashVersion(c.caseHashVersion)
  ).length;
  const casesDerivedSignability: ReportSignability = derivedUnsignable > 0 ? 'UNSIGNABLE' : 'SIGNABLE';

  // ★从**报告声称的业务结果（status）+ 事实 + 版本政策**派生完整 reasons（唯一真相源）。provenance 由
  // status/reason 判「是否声称跨升级」（非可删的 toolchain 字段，Codex 复审致命 1），版本政策恒缺第 3 层。
  const goldenCommitmentSupported = GOLDEN_COMMITMENT_REPORT_VERSIONS.has(report.runnerVersion);
  const derivedReasons = deriveUnsignableReasons(report.cases, report.status, goldenCommitmentSupported);
  const effectiveSignability: ReportSignability = derivedReasons.length > 0 ? 'UNSIGNABLE' : 'SIGNABLE';
  // ★golden 完整性维度：排除 provenance 后是否还有阻断 reason（受控接受漂移的前置门，见
  // GOLDEN_INTEGRITY_UNSIGNABLE_REASONS 注释）。声明不自洽时下方各分支会再叠 declaredConsistent 收紧。
  const goldenIntegrityClean = !derivedReasons.some((r) => GOLDEN_INTEGRITY_UNSIGNABLE_REASONS.has(r));

  if (
    report.runnerVersion === REPORT_HASH_VERSION_M14 ||
    report.runnerVersion === REPORT_HASH_VERSION_M15
  ) {
    // ★m1.4/m1.5：顶层声明（signability + count + reasons）进 reportHash，但 hash 只证「声明没变」不证「声明
    // 正确」——必须与派生事实**严格**一致。★Codex 复审致命 2 + S1 复审 P1：m1.5 必须与 m1.4 共用此严格分支
    // （否则 m1.5 落旧版本默认分支 declaredConsistent 恒 true → 可构造 hash 自洽却声明 SIGNABLE 的 lying artifact）。
    // 顶层 reasons 含未知/重复/非 canonical → 声明结构损坏（不过滤=fail-open）。矛盾 → fail-closed。
    const declared = report.unsignableReasons ?? [];
    const reasonsConsistent =
      isCanonicalReasonList(declared) &&
      declared.length === derivedReasons.length &&
      declared.every((r, i) => r === derivedReasons[i]);
    const declaredConsistent =
      report.signability === effectiveSignability &&
      (report.unsignableLegacyCases ?? -1) === derivedUnsignable &&
      reasonsConsistent;
    return {
      signability: declaredConsistent ? effectiveSignability : 'UNSIGNABLE',
      casesDerivedSignability,
      unsignableLegacyCases: derivedUnsignable,
      unsignableReasons: derivedReasons,
      declaredConsistent,
      goldenIntegritySignable: declaredConsistent && goldenIntegrityClean,
    };
  }
  if (report.runnerVersion === REPORT_HASH_VERSION_M13) {
    // m1.3 顶层声明 signability + count 进 hash（无 reasons 字段）。★历史 m1.3 声明值是 SIGNABLE 或
    // UNSIGNABLE_LEGACY_CASE_HASH_VERSION——与 cases 派生的二值比较时需归一化（UNSIGNABLE_LEGACY→UNSIGNABLE）。
    const declaredBinary: ReportSignability = report.signability === 'SIGNABLE' ? 'SIGNABLE' : 'UNSIGNABLE';
    const declaredConsistent =
      declaredBinary === casesDerivedSignability &&
      (report.unsignableLegacyCases ?? -1) === derivedUnsignable;
    return {
      // ★即使 m1.3 顶层声明自洽，也叠加版本政策派生的 provenance reason → effectiveSignability。
      signability: declaredConsistent ? effectiveSignability : 'UNSIGNABLE',
      casesDerivedSignability,
      unsignableLegacyCases: derivedUnsignable,
      unsignableReasons: derivedReasons,
      declaredConsistent,
      goldenIntegritySignable: declaredConsistent && goldenIntegrityClean,
    };
  }
  // m1.0/m1.1/m1.2：无顶层 reasons 声明——纯从事实 + 版本政策派生（declaredConsistent=true，无声明可矛盾）。
  return {
    signability: effectiveSignability,
    casesDerivedSignability,
    unsignableLegacyCases: derivedUnsignable,
    unsignableReasons: derivedReasons,
    declaredConsistent: true,
    goldenIntegritySignable: goldenIntegrityClean,
  };
}

/** 签字资格枚举（薄封装，消费端判定用；需 count/一致性用 deriveReportSignabilityDetail）。 */
export function deriveReportSignability(
  report: Pick<RunReport, 'runnerVersion' | 'signability' | 'cases' | 'unsignableLegacyCases' | 'unsignableReasons' | 'status'>
): ReportSignability {
  return deriveReportSignabilityDetail(report).signability;
}

/** 报告是否可签字通过（status===PASS && 派生 signability===SIGNABLE）。消费端判「绿色可签字」的唯一入口。 */
export function isSignablePass(
  report: Pick<RunReport, 'runnerVersion' | 'signability' | 'cases' | 'status' | 'unsignableLegacyCases' | 'unsignableReasons'>
): boolean {
  return report.status === 'PASS' && deriveReportSignability(report) === 'SIGNABLE';
}

/**
 * ★受控接受漂移审批的**唯一准入门**（写路径 createDriftApproval + 读路径 computeEffectiveStatus **共用**，
 * 防双口径：Codex 复审 P0——曾因写路径用全维度 signability、读路径用 goldenIntegritySignable 而分叉，导致
 * m1.4 drift 审批在正常 API 全废）。门 = golden 完整性可信（排除 provenance 维度，见
 * GOLDEN_INTEGRITY_UNSIGNABLE_REASONS 注释）。provenance 缺失不阻断审批（ACCEPTED 是有人背书的已知漂移，
 * 不声称跨升级签字级通过）；legacy 弱绑定 / 无 golden 承诺则拦（golden 无法证明，审批不可信）。
 */
export function isDriftApprovable(
  report: Pick<RunReport, 'runnerVersion' | 'signability' | 'cases' | 'status' | 'unsignableLegacyCases' | 'unsignableReasons'>
): boolean {
  return deriveReportSignabilityDetail(report).goldenIntegritySignable;
}

// ============ P0-4 受控接受漂移审批（ACCEPTED_DRIFT_WITH_APPROVAL）============
// 核心不变量：FAIL_REGRESSION 报告**永不**被改成 PASS。真实 bugfix 漂移由独立不可变审批 artifact
// 受控接受；有效状态由 report + 覆盖其全部 FAIL_REGRESSION drift 的有效审批 join **派生**。

/** 审批版本（进 approvalHash，逻辑变更 bump）。 */
export const DRIFT_APPROVAL_VERSION = 'p0a-drift-approval/m1.0';

/** 派生的有效状态：报告行 status 4 态 + 受控接受派生态。 */
export type EffectiveReportStatus = RegressionReportStatus | 'ACCEPTED_DRIFT_WITH_APPROVAL';

/** 一条被受控接受的 case 漂移（钉死 before/after output hash）。 */
export interface AcceptedDrift {
  caseId: string;
  /** 冻结基线的 expectedOutputHash（漂移前）。 */
  baselineOutputHash: string;
  /** 本次回放的 actualOutputHash（漂移后，已批范围）。升级后 case 输出须仍等于它。 */
  acceptedOutputHash: string;
}

/**
 * approvalHash = canonicalHash(审批决定性内容)——**完整性 checksum**（非签名/MAC，无秘密）+ 可复算。
 * 覆盖 reportHash + acceptedDrifts(稳定序) + approver + reason + ticket + expiry + 版本。不含 id/createdAt。
 *
 * ★信任边界（诚实，Codex 复审）：approvalHash 只能检测「审批行被**不同步修改**」（改字段没重算 hash → 读路径
 * 重算不符 → 拒）；它**不**证明审批人身份，也**不**阻止「完整重造」——任何能直接 INSERT 审批行的主体都能自行
 * 重算一致的 hash。抵御完整伪造依赖：API 鉴权 + DB 写权限最小化 + 0039 INSERT trigger 的声明身份 SoD（见
 * docs/p0a-db-sod-decision.md），而非本 checksum。
 */
export function computeApprovalHash(fields: {
  reportHash: string;
  policyVersionRowId: string;
  acceptedDrifts: AcceptedDrift[];
  reason: string;
  ticketRef: string | null;
  approvedBy: string;
  expiresAt: string; // ISO
}): string {
  const drifts = fields.acceptedDrifts
    .slice()
    .sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0))
    .map((d) => ({
      caseId: d.caseId,
      baselineOutputHash: d.baselineOutputHash,
      acceptedOutputHash: d.acceptedOutputHash,
    }));
  return canonicalHash({
    approvalVersion: DRIFT_APPROVAL_VERSION,
    reportHash: fields.reportHash,
    policyVersionRowId: fields.policyVersionRowId,
    acceptedDrifts: drifts,
    reason: fields.reason,
    ticketRef: fields.ticketRef,
    approvedBy: fields.approvedBy,
    expiresAt: fields.expiresAt,
  });
}

export interface CreateApprovalResult {
  approvalId: string;
  approvalHash: string;
}

/**
 * 创建受控接受漂移审批（write 路径）。★职责分离：approvedBy **必须 != 报告 createdBy**（跨表 DB check
 * 做不到，应用层强制 + 审计）。★只接受**当前有效**报告：reportHash 必须匹配 DB 里的报告（防审批已被
 * 替换的旧报告）。★acceptedDrifts 必须精确覆盖报告全部 OUTPUT_HASH_MISMATCH drift（多/少/证据损坏 case
 * 都拒——不能审批不可接受的失败）。
 */
export async function createDriftApproval(params: {
  reportId: string;
  reason: string;
  ticketRef?: string | null;
  approvedBy: string;
  expiresAt: Date;
}): Promise<CreateApprovalResult> {
  const { reportId, reason, approvedBy, expiresAt } = params;
  const ticketRef = params.ticketRef ?? null;

  const report = (await db.query.regressionReports.findFirst({
    where: eq(regressionReports.id, reportId),
  })) as RegressionReport | undefined;
  if (!report) throw new Error('report_not_found');
  if (report.status !== 'FAIL_REGRESSION') {
    throw new Error(`report_not_failing:${report.status}`); // 只失败报告才需受控接受。
  }
  const runReport0 = report.reportJson as unknown as RunReport;
  // ★Item 2（Codex 复审致命 3）：golden 完整性不可信的报告**拒绝**受控接受——否则含 m1.0 弱绑定 case 的
  // FAIL_REGRESSION 报告可被审批派生成 ACCEPTED_DRIFT_WITH_APPROVAL，产出「看似审批完成」却 golden 无法证明
  // 的假有效态。★Item 4 F（Codex 复审 P0）：写路径**必须**与读路径（computeEffectiveStatus）用**同一个**门
  // ——isDriftApprovable（goldenIntegritySignable，排除 provenance 维度）。否则 m1.4 的 OUTPUT_HASH_MISMATCH
  // drift 恒带 provenance reason → 全维度 UNSIGNABLE → createDriftApproval 永远拒绝 → 整个受控接受功能在正常
  // API 流程中全废（读路径虽允许 provenance-only ACCEPTED 却永远到不了）。ACCEPTED 是「有人背书的已知漂移」
  // 不声称跨升级签字级通过，provenance 缺失不该阻断审批。★写/读**共用** isDriftApprovable，防双口径。
  if (!isDriftApprovable(runReport0)) {
    throw new Error('report_unsignable:cannot_approve_drift_on_golden_untrusted_report');
  }
  // ★职责分离：审批人不能是报告创建者。
  if (report.createdBy === approvedBy) {
    throw new Error('separation_of_duties:approver_equals_report_creator');
  }
  if (expiresAt.getTime() <= Date.now()) {
    throw new Error('invalid_expiry:not_in_future');
  }

  const runReport = report.reportJson as unknown as RunReport;
  const failCases = runReport.cases.filter((c) => c.status === 'FAIL_REGRESSION');
  const approvable = extractApprovableDrifts(runReport);
  // 报告有不可受控接受的失败（证据损坏/回放破坏/编译失败）→ 整份不可审批。
  if (approvable.length !== failCases.length || approvable.length === 0) {
    throw new Error('report_has_unapprovable_failures');
  }

  const approvalHash = computeApprovalHash({
    reportHash: report.reportHash,
    policyVersionRowId: report.policyVersionRowId,
    acceptedDrifts: approvable,
    reason,
    ticketRef,
    approvedBy,
    expiresAt: expiresAt.toISOString(),
  });

  const approvalId = crypto.randomUUID();
  await db.insert(regressionDriftApprovals).values({
    id: approvalId,
    reportId,
    reportHash: report.reportHash,
    policyId: report.policyId,
    policyVersionRowId: report.policyVersionRowId,
    acceptedDrifts: approvable,
    reason,
    ticketRef,
    approvedBy,
    expiresAt,
    approvalHash,
  });
  return { approvalId, approvalHash };
}

/**
 * 查报告 + 其有效审批 → 派生有效状态（读路径）。
 */
export async function getEffectiveStatus(reportId: string, now: Date = new Date()): Promise<{
  report: RegressionReport;
  effectiveStatus: EffectiveReportStatus;
} | null> {
  const report = (await db.query.regressionReports.findFirst({
    where: eq(regressionReports.id, reportId),
  })) as RegressionReport | undefined;
  if (!report) return null;
  const approvals = await db.query.regressionDriftApprovals.findMany({
    where: and(eq(regressionDriftApprovals.reportId, reportId), isNull(regressionDriftApprovals.revokedAt)),
  });
  const runReport = report.reportJson as unknown as RunReport;
  const effectiveStatus = computeEffectiveStatus(
    {
      status: report.status as RegressionReportStatus,
      reportHash: report.reportHash,
      policyVersionRowId: report.policyVersionRowId,
      cases: runReport.cases,
      // ★Item 2/4：传 runnerVersion + signability + unsignableLegacyCases + unsignableReasons 供
      // isDriftApprovable（声明自洽性校验 + golden 完整性不可信报告不派生 ACCEPTED；provenance 不阻断）。
      runnerVersion: runReport.runnerVersion,
      signability: runReport.signability,
      unsignableLegacyCases: runReport.unsignableLegacyCases,
      unsignableReasons: runReport.unsignableReasons,
    },
    approvals,
    now
  );
  return { report, effectiveStatus };
}

/**
 * 服务端离线核验薄封装：查存储的报告 + 当前 golden 行（**含 computeCaseHash 所需全字段**，以便重算），
 * 喂纯函数 {@link verifyReportIntegrity}。用于 GET ?verify=1。
 *
 * ★口径（Codex 复审 #2）：期望 reportHash 传的是**同库** report.reportHash 行值——故本封装核验的是
 * 「存储完整性 + 当前 golden 一致性」（能抓 reportJson 被单独改 + golden 与报告承诺不符 + 当前行改字段
 * 没改 caseHash），**不**等同于验证 CCO 外部数字签名（同时改 reportJson+reportHash 检测不到）。要证明
 * CCO 已签，须另传可信签名 artifact 的 reportHash 并验签——超出本封装范围。
 *
 * golden 集范围 = 报告的 (policyId, policyVersionRowId) 下的全部 RegressionCase（签字覆盖集=这一版策略
 * 的全部冻结 case）。EXTRA_IN_GOLDEN 即此范围内报告未覆盖的 case，表覆盖集已变。
 */
export async function verifyStoredReportIntegrity(
  reportId: string
): Promise<{ report: RegressionReport; verdict: ReportIntegrityVerdict } | null> {
  const report = (await db.query.regressionReports.findFirst({
    where: eq(regressionReports.id, reportId),
  })) as RegressionReport | undefined;
  if (!report) return null;

  // 全字段查询——verifier 要从实际字段重算 caseHash，故 computeCaseHash 需要的每个字段都要取。
  const goldenRows = await db.query.regressionCases.findMany({
    where: and(
      eq(regressionCases.policyId, report.policyId),
      eq(regressionCases.policyVersionRowId, report.policyVersionRowId)
    ),
  });
  const currentGolden: GoldenCaseSnapshot[] = goldenRows.map((g) => ({
    id: g.id,
    caseHash: g.caseHash,
    caseHashVersion: g.caseHashVersion,
    // computeCaseHash 所需字段（与 run 重算路径一致）。
    policyId: g.policyId,
    policyVersionRowId: g.policyVersionRowId,
    functionName: g.functionName,
    locale: g.locale,
    canonicalInputHash: g.canonicalInputHash,
    expectedOutputHash: g.expectedOutputHash,
    expectedDecision: g.expectedDecision,
    canonicalizationVersion: g.canonicalizationVersion,
    aliasSetJson: g.aliasSetJson,
    vocabSnapshotRef: g.vocabSnapshotRef,
    sourceKind: g.sourceKind,
    coverageTags: Array.isArray(g.coverageTags) ? (g.coverageTags as string[]) : [],
    baselineRuntimeToolchainId: g.baselineRuntimeToolchainId,
    sourceToolchainId: g.sourceToolchainId,
    sourceEnvelopeSha256: g.sourceEnvelopeSha256,
    sourceExecutionId: g.sourceExecutionId,
  }));

  const runReport = report.reportJson as unknown as RunReport;
  const verdict = verifyReportIntegrity(runReport, report.reportHash, currentGolden);
  return { report, verdict };
}

/**
 * 从 report 的 FAIL_REGRESSION case 抽取 drift 明细（caseId + baseline/actual output hash）。
 * 只 OUTPUT_HASH_MISMATCH 是「有意 bugfix 可受控接受」的漂移；GOLDEN_INTEGRITY_FAILURE / EVALUATE_FAILED /
 * INPUT_HASH_MISMATCH 是证据损坏/回放破坏，**不可**受控接受（不返回，审批无法覆盖它们）。
 */
export function extractApprovableDrifts(report: Pick<RunReport, 'cases'>): AcceptedDrift[] {
  return report.cases
    .filter((c) => c.status === 'FAIL_REGRESSION' && c.reason === 'OUTPUT_HASH_MISMATCH')
    .filter((c) => c.expectedOutputHash != null && c.actualOutputHash != null)
    .map((c) => ({
      caseId: c.caseId,
      baselineOutputHash: c.expectedOutputHash as string,
      acceptedOutputHash: c.actualOutputHash as string,
    }));
}

/**
 * 计算报告**有效状态**（纯函数，可单测）。核心：不改任何行，join report + 有效审批派生。
 *
 * FAIL_REGRESSION → ACCEPTED_DRIFT_WITH_APPROVAL 的条件（全满足）：
 *   1. 报告行 status === 'FAIL_REGRESSION'；
 *   2. 报告全部 FAIL_REGRESSION case **都是可受控接受的漂移**（OUTPUT_HASH_MISMATCH，无证据损坏/回放破坏）；
 *   3. 存在**单条**有效审批（未撤销、未过期、reportHash 匹配、**approvalHash 重算一致**）其 acceptedDrifts
 *      **精确等于**报告全部 approvable drift（不多不少、caseId+before/after hash 一致）。
 * ★Codex 复审 2：不 union 多条部分审批（否则两条各覆盖一半也算通过，放大脏数据影响）；且**重算 approvalHash**
 * 校验（拦截「改了审批字段没重算 hash」的**不同步篡改**——非防身份伪造，见 computeApprovalHash 信任边界注释）。
 * 任一不满足 → 保持原 FAIL_REGRESSION（诚实，不假装受控接受）。
 * 其它状态（PASS/FAIL_INSUFFICIENT_COVERAGE/NON_REPLAYABLE）原样返回（不适用受控接受）。
 */
export function computeEffectiveStatus(
  report: Pick<RunReport, 'status' | 'reportHash' | 'policyVersionRowId' | 'cases' | 'runnerVersion' | 'signability' | 'unsignableLegacyCases' | 'unsignableReasons'>,
  approvals: Array<
    Pick<
      RegressionDriftApproval,
      | 'reportHash'
      | 'policyVersionRowId'
      | 'acceptedDrifts'
      | 'reason'
      | 'ticketRef'
      | 'approvedBy'
      | 'expiresAt'
      | 'revokedAt'
      | 'approvalHash'
    >
  >,
  now: Date
): EffectiveReportStatus {
  if (report.status !== 'FAIL_REGRESSION') return report.status;

  // ★Item 2（Codex 复审致命 3）：golden 完整性不可信的报告**绝不**派生 ACCEPTED_DRIFT_WITH_APPROVAL——含
  // m1.0 弱绑定 / 无 golden 承诺的报告即使有覆盖其 drift 的有效审批，也保持 FAIL_REGRESSION（不假装受控接受
  // 一个 golden 无法证明的报告）。★Item 4 F：与写路径 createDriftApproval **共用** isDriftApprovable（门用
  // goldenIntegritySignable 排除 provenance 维度），防双口径（Codex 复审 P0）。见 isDriftApprovable 注释。
  if (!isDriftApprovable(report)) return 'FAIL_REGRESSION';

  // 报告的全部 FAIL_REGRESSION case。
  const failCases = report.cases.filter((c) => c.status === 'FAIL_REGRESSION');
  const approvable = extractApprovableDrifts(report);
  // 若有任何 FAIL case **不是**可受控接受的漂移（证据损坏/回放破坏）→ 不可受控接受。
  if (approvable.length !== failCases.length) return 'FAIL_REGRESSION';
  if (approvable.length === 0) return 'FAIL_REGRESSION';

  // 期望 drift 集（稳定序，供精确相等比较）。
  const expected = approvable
    .slice()
    .sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0));
  const expectedKey = JSON.stringify(
    expected.map((d) => [d.caseId, d.baselineOutputHash, d.acceptedOutputHash])
  );

  for (const a of approvals) {
    if (a.revokedAt != null) continue;
    if (a.expiresAt.getTime() <= now.getTime()) continue;
    if (a.reportHash !== report.reportHash) continue;
    if (a.policyVersionRowId !== report.policyVersionRowId) continue;

    const drifts = (a.acceptedDrifts as AcceptedDrift[]) ?? [];
    // ★单条审批**精确等于**期望 drift 集（不 union）。
    const sorted = drifts
      .slice()
      .sort((x, y) => (x.caseId < y.caseId ? -1 : x.caseId > y.caseId ? 1 : 0));
    const key = JSON.stringify(
      sorted.map((d) => [d.caseId, d.baselineOutputHash, d.acceptedOutputHash])
    );
    if (key !== expectedKey) continue;

    // ★重算 approvalHash 校验（读路径闭环，检测审批字段被改但 approvalHash 未同步重算；非防身份伪造，
    // 见 computeApprovalHash 信任边界注释）。
    const recomputed = computeApprovalHash({
      reportHash: a.reportHash,
      policyVersionRowId: a.policyVersionRowId,
      acceptedDrifts: drifts,
      reason: a.reason,
      ticketRef: a.ticketRef,
      approvedBy: a.approvedBy,
      expiresAt: a.expiresAt.toISOString(),
    });
    if (recomputed !== a.approvalHash) continue;

    return 'ACCEPTED_DRIFT_WITH_APPROVAL';
  }
  return 'FAIL_REGRESSION';
}
