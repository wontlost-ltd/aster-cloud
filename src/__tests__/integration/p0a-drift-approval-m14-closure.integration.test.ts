// P0-A Item 4 F：m1.4 受控接受漂移**写路径闭环**真库集成测试（Codex 复审 P0 补）。
//
// 背景：Item 4 F 让 OUTPUT_HASH_MISMATCH → 派生 TOOLCHAIN_PROVENANCE_UNVERIFIED → 全维度 signability=UNSIGNABLE。
// 曾经的 bug：写路径 createDriftApproval 用**全维度** signability 当门 → m1.4 drift 恒被拒 → 整个受控接受功能
// 在正常 API 流程全废；读路径 computeEffectiveStatus 虽已改用 goldenIntegritySignable，但正常业务永远到不了它。
// 单测手工构造审批对象**绕过了写路径**，掩盖了这个回归。
//
// 本测试用**真库 + 真 createDriftApproval + 真 getEffectiveStatus** 闭环证明：
//   (1) m1.4 provenance-only（legacy 干净、golden 可信）FAIL_REGRESSION drift → createDriftApproval **成功**落库；
//   (2) 该审批 → getEffectiveStatus 派生 ACCEPTED_DRIFT_WITH_APPROVAL（完整闭环，非手构对象）；
//   (3) m1.4 **legacy**（golden 不可信）drift → createDriftApproval **拒绝**（golden 完整性门仍在）。
// 即：写/读**共用** isDriftApprovable（goldenIntegritySignable），provenance 缺失不阻断审批、golden 不可信仍阻断。
//
// Run: LICENSE_E2E=1 DATABASE_URL=... pnpm test:integration
// ★前置：DB 须已应用 0039 trigger（drizzle-kit push 不跑迁移 SQL——用 pnpm db:migrate 或手 apply 0039）。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, regressionReports, regressionDriftApprovals, regressionCases } from '@/lib/prisma';
import {
  createDriftApproval,
  getEffectiveStatus,
  computeReportHash,
  type RunReport,
} from '@/services/policy/rule-regression-runner';
import { deleteAppendOnlyRows, setupTestDb, teardownTestDb } from './setup-postgres';

const POL = 'pol-m14c-1';
const PVR = 'pv-m14c-1';
const CREATOR = 'user-creator-m14c';
const APPROVER = 'user-approver-m14c';
const FUTURE = new Date(Date.now() + 365 * 24 * 3600_000);

// m1.4 FAIL_REGRESSION 报告，含一个可受控接受的 OUTPUT_HASH_MISMATCH drift。
// caseHashVersion 决定 golden 完整性维度：m1.1=干净（可审批）；m1.0=弱绑定（golden 不可信，拒审批）。
function reportBody(caseHashVersion: 'case-hash/m1.1' | 'case-hash/m1.0'): Omit<RunReport, 'reportId' | 'reportHash'> {
  return {
    status: 'FAIL_REGRESSION',
    comparisonMode: 'FROZEN_BASELINE_VS_CURRENT_BACKEND',
    baselineSemantics: 'sem',
    policyId: POL,
    policyVersionRowId: PVR,
    currentRuntimeToolchainId: 'tc-cur',
    coverage: {
      totalCases: 4, runnableCases: 4, approvedCases: 2, deniedCases: 2, handwrittenBoundaryCases: 1,
      thresholds: { minRunnableCases: 4, minApprovedCases: 1, minDeniedCases: 1, minHandwrittenBoundaryCases: 1 },
      unmet: [],
    },
    summary: { passed: 3, failed: 1, nonReplayable: 0, compileFailures: 0 },
    // ★cases 与 coverage/summary 汇总一致（3 PASS + 1 FAIL drift = caseCount 4）——贴近真实 runner artifact，
    // 降低未来引入结构校验后的测试维护成本（Codex 复审非阻断建议）。★仅 **drift case** 的 caseHashVersion 受参数
    // 控制（隔离「drift 是 legacy → 拒审批」这一维度）；3 个 PASS 陪衬 case 恒 m1.1（不额外污染 legacy count）。
    cases: [
      {
        caseId: 'c-drift', status: 'FAIL_REGRESSION', reason: 'OUTPUT_HASH_MISMATCH',
        caseHash: 'c-drift-h', caseHashVersion, functionName: 'f', locale: 'en-US',
        coverageTags: [], sourceKind: 'execution', expectedOutputHash: 'base1', actualOutputHash: 'new1',
        baselineToolchainId: 'tc-base', currentToolchainId: 'tc-cur',
      },
      ...(['c-ok-1', 'c-ok-2', 'c-ok-3'] as const).map((caseId) => ({
        caseId, status: 'PASS' as const, caseHash: `${caseId}-h`, caseHashVersion: 'case-hash/m1.1' as const,
        functionName: 'f', locale: 'en-US', coverageTags: [] as string[], sourceKind: 'execution' as const,
        expectedOutputHash: 'same', actualOutputHash: 'same',
        baselineToolchainId: 'tc-base', currentToolchainId: 'tc-cur',
      })),
    ],
    runnerVersion: 'p0a-runner/m1.4',
    // ★顶层声明必须与派生事实一致（deriveReportSignabilityDetail 严格校验，否则 declaredConsistent=false）。
    // drift=m1.1 → 派生 reasons=[TOOLCHAIN_PROVENANCE_UNVERIFIED]，signability=UNSIGNABLE，legacyCount=0。
    // drift=m1.0 → 派生 reasons=[LEGACY_CASE_HASH_VERSION, TOOLCHAIN_PROVENANCE_UNVERIFIED]，legacyCount=1（仅 drift）。
    signability: 'UNSIGNABLE',
    unsignableLegacyCases: caseHashVersion === 'case-hash/m1.0' ? 1 : 0,
    unsignableReasons: caseHashVersion === 'case-hash/m1.0'
      ? ['LEGACY_CASE_HASH_VERSION', 'TOOLCHAIN_PROVENANCE_UNVERIFIED']
      : ['TOOLCHAIN_PROVENANCE_UNVERIFIED'],
  };
}

async function seedReport(id: string, caseHashVersion: 'case-hash/m1.1' | 'case-hash/m1.0') {
  const body = reportBody(caseHashVersion);
  const reportHash = computeReportHash(body); // 真算 reportHash（写路径读它，须与 body 自洽）。
  await db.insert(regressionReports).values({
    id, policyId: POL, policyVersionRowId: PVR, status: 'FAIL_REGRESSION',
    comparisonMode: 'FROZEN_BASELINE_VS_CURRENT_BACKEND', caseCount: 4, runnableCaseCount: 4,
    passedCaseCount: 3, failedCaseCount: 1, nonReplayableCaseCount: 0,
    coverageJson: body.coverage, reportJson: body as unknown as object,
    reportHash, currentRuntimeToolchainId: 'tc-cur', createdBy: CREATOR,
  } as typeof regressionReports.$inferInsert);
  return reportHash;
}

async function reset() {
  await deleteAppendOnlyRows([regressionDriftApprovals, regressionReports, regressionCases]);
}

async function expectRejected(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  let err: unknown;
  try {
    await run();
  } catch (e) {
    err = e;
  }
  expect(err, 'expected createDriftApproval to be rejected').toBeDefined();
  const causeMsg = (err as { cause?: { message?: string } })?.cause?.message ?? '';
  const topMsg = (err as { message?: string })?.message ?? '';
  expect(`${topMsg}\n${causeMsg}`).toMatch(pattern);
}

describe.skipIf(process.env.LICENSE_E2E !== '1')(
  'P0-A Item 4 F — m1.4 受控接受漂移写路径闭环（真库）',
  () => {
    beforeAll(async () => {
      process.env.AI_KEY_ENCRYPTION_SECRET = 'integration-test-secret-key-32chars';
      await setupTestDb();
    });
    afterAll(async () => {
      await teardownTestDb();
    });
    beforeEach(async () => {
      await reset();
    });

    it('★核心闭环：m1.4 provenance-only drift → createDriftApproval 成功 → getEffectiveStatus=ACCEPTED_DRIFT_WITH_APPROVAL', async () => {
      const REP = 'rep-m14c-ok';
      await seedReport(REP, 'case-hash/m1.1'); // golden 干净（可审批），仅 provenance 未验证

      // 写路径：真 createDriftApproval（曾因全维度 signability 门恒拒——现用 isDriftApprovable=goldenIntegritySignable）。
      const res = await createDriftApproval({
        reportId: REP, reason: 'intentional upgrade drift', approvedBy: APPROVER, expiresAt: FUTURE,
      });
      expect(res.approvalId).toBeTruthy();

      // 读路径闭环：真 getEffectiveStatus（查库 join 审批）→ ACCEPTED_DRIFT_WITH_APPROVAL。
      const es = await getEffectiveStatus(REP);
      expect(es).not.toBeNull();
      expect(es!.effectiveStatus).toBe('ACCEPTED_DRIFT_WITH_APPROVAL');
    });

    it('★golden 完整性门仍在：m1.4 **legacy**（m1.0 弱绑定 case）drift → createDriftApproval 拒绝', async () => {
      const REP = 'rep-m14c-legacy';
      await seedReport(REP, 'case-hash/m1.0'); // golden 不可信 → golden 完整性门拦审批

      await expectRejected(
        () => createDriftApproval({ reportId: REP, reason: 'r', approvedBy: APPROVER, expiresAt: FUTURE }),
        /golden_untrusted|cannot_approve_drift/,
      );

      // 且即使有人绕过写路径直插审批，读路径 getEffectiveStatus 也绝不派生 ACCEPTED（golden 不可信）。
      const es = await getEffectiveStatus(REP);
      expect(es!.effectiveStatus).toBe('FAIL_REGRESSION');
    });
  },
);
