// P0-A Item 2（legacy m1.0 签字策略）真库集成测试。
//
// 验证目标：一个 case-hash/m1.0 的 RegressionCase（弱绑定，只绑 9 字段，不含 coverageTags/toolchain/
// decision 等签字级字段）在签字级路径被显式拒绝/降级，而非静默信任：
//   (1) run 侧：m1.0 case 标 LEGACY_UNSIGNABLE_CASE_HASH_VERSION，报告 signability=UNSIGNABLE
//       （即使剩余 case 达标也不可签字通过）。
//   (2) verify 侧：m1.0 golden 行即使自洽也标 LEGACY_WEAK_BINDING_CASE_HASH_VERSION，ok=false。
//
// ★m1.0 行来源：新 freeze 永不产 m1.0（硬写 m1.1）。本测试**直接 INSERT** 一个 m1.0 RegressionCase
// （INSERT 未被 append-only trigger 阻止，只 UPDATE/DELETE 被拦）——模拟 migration 0036 回填/pre-m1.1
// 遗留/直接 DB 写产生的 m1.0 行。这正是 Item 2 要防御的真实来源。
//
// Run: LICENSE_E2E=1 DATABASE_URL=postgresql://postgres:postgres@localhost:5432/aster_cloud pnpm test:integration

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, policies, policyVersions, users, regressionCases, regressionReports } from '@/lib/prisma';
import {
  run,
  computeCaseHash,
  verifyReportIntegrity,
  deriveReportSignability,
  CASE_HASH_VERSION_M10,
  RULE_REGRESSION_RUNNER_VERSION,
  type RunReport,
  type GoldenCaseSnapshot,
  type CaseRunDetail,
} from '@/services/policy/rule-regression-runner';
import { deleteAppendOnlyRows, setupTestDb, teardownTestDb } from './setup-postgres';

const OWNER = 'user-p0a-m10-1';
const POL = 'pol-p0a-m10-1';
const PV_ROW = 'pv-p0a-m10-1';
const CASE_ID = 'rc-m10-1';

// m1.0 case 的字段（computeCaseHash m1.0 公式只绑其中 9 个）。
const M10_FIELDS = {
  policyId: POL, policyVersionRowId: PV_ROW, functionName: 'greet', locale: 'en-US',
  canonicalInputHash: 'in-m10', expectedOutputHash: 'out-m10', canonicalizationVersion: 'aster-canonical-json/v1',
  aliasSetJson: {}, vocabSnapshotRef: [], sourceKind: 'execution',
  expectedDecision: 'approved' as const, coverageTags: [] as string[],
  baselineRuntimeToolchainId: 'tc-base', sourceToolchainId: 'tc-src',
  sourceEnvelopeSha256: 'env-m10', sourceExecutionId: 'ex-m10',
};
const M10_HASH = computeCaseHash(M10_FIELDS, CASE_HASH_VERSION_M10);

// 基线迁移里 User / Policy 的 updatedAt 是 NOT NULL 且无库级默认值（schema 的 defaultNow 未落进迁移），须显式赋值。
async function seedM10Case() {
  await db.insert(users).values({
    id: OWNER, replayRetentionEnabled: true, updatedAt: new Date(),
  } as typeof users.$inferInsert);
  await db.insert(policies).values({
    id: POL, userId: OWNER, name: 'greet', content: 'M.', updatedAt: new Date(),
  } as typeof policies.$inferInsert);
  await db.insert(policyVersions).values({
    id: PV_ROW, policyId: POL, version: 1, content: 'M.', sourceToolchainId: 'tc-src', sourceEnvelopeSha256: 'env-m10',
  } as typeof policyVersions.$inferInsert);
  // ★直接 INSERT 一个 m1.0 RegressionCase（模拟遗留/回填行）。caseHash 用 m1.0 公式算（自洽）。
  await db.insert(regressionCases).values({
    id: CASE_ID, policyId: POL, policyVersionRowId: PV_ROW, functionName: 'greet', locale: 'en-US',
    aliasSetJson: {}, vocabSnapshotRef: [], inputJson: { name: 'Ada' },
    canonicalInputHash: 'in-m10', expectedOutputHash: 'out-m10', expectedDecision: 'approved',
    canonicalizationVersion: 'aster-canonical-json/v1', sourceKind: 'execution', sourceExecutionId: 'ex-m10',
    coverageTags: [], baselineRuntimeToolchainId: 'tc-base', sourceToolchainId: 'tc-src',
    sourceEnvelopeSha256: 'env-m10', caseHash: M10_HASH, caseHashVersion: CASE_HASH_VERSION_M10, createdBy: OWNER,
  } as typeof regressionCases.$inferInsert);
}

async function reset() {
  // ★RegressionCase/Report 是 append-only（0037 trigger 禁 DELETE），须绕过 trigger 清理
  // （deterministic reportHash 会与上次 run 的残留撞 unique 约束）。
  await deleteAppendOnlyRows([regressionReports, regressionCases]);
  await db.delete(policyVersions);
  await db.delete(policies);
  await db.delete(users);
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('P0-A Item 2 m1.0 签字策略（真库）', () => {
  beforeAll(async () => {
    process.env.AI_KEY_ENCRYPTION_SECRET = 'integration-test-secret-key-32chars';
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await reset();
    await seedM10Case();
  });

  it('★真库能落一个 m1.0 RegressionCase（INSERT 未被 append-only 阻止）+ 其自洽', async () => {
    const rows = await db.select().from(regressionCases).where(eq(regressionCases.id, CASE_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0].caseHashVersion).toBe(CASE_HASH_VERSION_M10);
    // 自洽：存储 caseHash == 用 m1.0 公式从字段重算。
    expect(rows[0].caseHash).toBe(M10_HASH);
  });

  it('★verify：m1.0 golden 自洽也标 LEGACY_WEAK_BINDING（m1.3 报告承诺它）→ ok=false', async () => {
    const row = (await db.select().from(regressionCases).where(eq(regressionCases.id, CASE_ID)))[0];
    const golden: GoldenCaseSnapshot = {
      id: row.id, caseHash: row.caseHash, caseHashVersion: row.caseHashVersion,
      policyId: row.policyId, policyVersionRowId: row.policyVersionRowId, functionName: row.functionName,
      locale: row.locale, canonicalInputHash: row.canonicalInputHash, expectedOutputHash: row.expectedOutputHash,
      expectedDecision: row.expectedDecision, canonicalizationVersion: row.canonicalizationVersion,
      aliasSetJson: row.aliasSetJson, vocabSnapshotRef: row.vocabSnapshotRef, sourceKind: row.sourceKind,
      coverageTags: Array.isArray(row.coverageTags) ? (row.coverageTags as string[]) : [],
      baselineRuntimeToolchainId: row.baselineRuntimeToolchainId, sourceToolchainId: row.sourceToolchainId,
      sourceEnvelopeSha256: row.sourceEnvelopeSha256, sourceExecutionId: row.sourceExecutionId,
    };
    // 一份 m1.3 报告承诺这个 m1.0 case。
    const cases: CaseRunDetail[] = [{
      caseId: CASE_ID, status: 'NON_REPLAYABLE', caseHash: M10_HASH, caseHashVersion: CASE_HASH_VERSION_M10,
      functionName: 'greet', locale: 'en-US', coverageTags: [], sourceKind: 'execution',
      reason: 'LEGACY_UNSIGNABLE_CASE_HASH_VERSION',
    }];
    const report: Omit<RunReport, 'reportId' | 'reportHash'> = {
      status: 'NON_REPLAYABLE', comparisonMode: 'FROZEN_BASELINE_VS_CURRENT_BACKEND', baselineSemantics: 'sem',
      policyId: POL, policyVersionRowId: PV_ROW, currentRuntimeToolchainId: null,
      coverage: { totalCases: 1, runnableCases: 0, approvedCases: 0, deniedCases: 0, handwrittenBoundaryCases: 0,
        thresholds: { minRunnableCases: 4, minApprovedCases: 1, minDeniedCases: 1, minHandwrittenBoundaryCases: 1 }, unmet: [] },
      summary: { passed: 0, failed: 0, nonReplayable: 1, compileFailures: 0 },
      cases, runnerVersion: 'p0a-runner/m1.3',
      signability: 'UNSIGNABLE_LEGACY_CASE_HASH_VERSION', unsignableLegacyCases: 1,
    };
    const { computeReportHash } = await import('@/services/policy/rule-regression-runner');
    const v = verifyReportIntegrity(report, computeReportHash(report), [golden]);
    // m1.0 golden 自洽（recomputed==stored）+ 匹配承诺，但弱绑定 → LEGACY_WEAK_BINDING，不计 MATCH。
    expect(v.cases[0].status).toBe('LEGACY_WEAK_BINDING_CASE_HASH_VERSION');
    expect(v.ok).toBe(false);
  });

  it('★真调 run()：纯 m1.0 case → 报告 signability=UNSIGNABLE 且持久化（Codex 复审：不许手构报告冒充 run）', async () => {
    // ★不需真 backend：m1.0 case 在 run 循环里走 legacy 分支（自洽校验后、backend 调用前）即 continue，
    // 不发远程 replay。这才真正走 base detail / legacy 分支 / summary 计数 / assembleReport / 持久化。
    const report = await run({ policyId: POL, policyVersionRowId: PV_ROW, actorUserId: OWNER, tenantId: OWNER });

    // run 真实产出：m1.4 报告（Item 4 F），signability=**真二值** 'UNSIGNABLE'（含 m1.0 弱绑定 case），
    // legacy case 不算 runnable。★Codex 复审致命 3：m1.4 顶层 signability 只用真二值，不用 LEGACY 枚举。
    expect(report.runnerVersion).toBe(RULE_REGRESSION_RUNNER_VERSION);
    expect(report.signability).toBe('UNSIGNABLE');
    // ★纯 m1.0 且 status=NON_REPLAYABLE（0 runnable，不声称跨升级）→ 只 LEGACY reason，无 provenance reason。
    expect(report.unsignableReasons).toEqual(['LEGACY_CASE_HASH_VERSION']);
    expect(report.unsignableLegacyCases).toBe(1);
    const legacyCase = report.cases.find((c) => c.caseId === CASE_ID);
    expect(legacyCase?.reason).toBe('LEGACY_UNSIGNABLE_CASE_HASH_VERSION');
    // 纯 m1.0 → 0 runnable → status=NON_REPLAYABLE（不可签字通过）。
    expect(report.status).toBe('NON_REPLAYABLE');

    // ★持久化验证：读回 RegressionReport，reportJson.signability 落库。
    const stored = await db.select().from(regressionReports).where(eq(regressionReports.id, report.reportId));
    expect(stored).toHaveLength(1);
    const storedReport = stored[0].reportJson as unknown as RunReport;
    expect(deriveReportSignability(storedReport)).toBe('UNSIGNABLE');
  });
});
