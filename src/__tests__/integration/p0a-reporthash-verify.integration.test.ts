// P0-A 签字级 m1.2 端到端集成测试（真实 Postgres + 真调 aster-api run）。
//
// 验证目标（Item 1「reportHash 绑 caseHash + 离线核验协议」）：
//   #261 后 freeze 能选真实 REPLAYABLE execution 冻成 golden；本测试再往下走 run → 产出 m1.2 报告，
//   证明：
//     (1) commit 半：真 run 产出的 reportJson.runnerVersion='p0a-runner/m1.3' 且每 case detail 携带
//         caseHash + caseHashVersion，且与其 RegressionCase 行的 caseHash 一致（golden 完整性绑进报告）；
//     (2) verify 半：verifyStoredReportIntegrity 对真库报告 + 真 golden → reportHashValid + goldenCommitment
//         + 全 MATCH；篡改真库某 RegressionCase 的 caseHash → 抓出 CASE_HASH_MISMATCH，ok=false。
//
// ★诚实边界：本地单 aster-api → 单 toolchain → P0-1 BASELINE_EQUALS_CURRENT → run 产 NON_REPLAYABLE 报告
//   （不是 PASS）。**这不影响 m1.2 验证**——caseHash commitment 在 base detail 注入，所有 case 分支（含
//   NON_REPLAYABLE）都携带；verifyReportIntegrity 不依赖报告 status，只核验 reportHash + caseHash 承诺。
//   真 PASS 需两个 toolchain 版本（跨升级），非本地可诚实复现——刻意不伪造。
//
// Run: LICENSE_E2E=1 P0A_LIVE_BACKEND=1 + 本地 aster-api :8080（signature.enabled=false）+ 匹配 HMAC key
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/aster_cloud
//   ASTER_POLICY_API_INTERNAL_URL=http://localhost:8080  ASTER_PLAN_GATE_HMAC_KEY=<同 aster-api>

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  db,
  executions,
  policies,
  policyVersions,
  users,
  regressionCases,
  regressionReports,
} from '@/lib/prisma';
import { buildReplayColumns, type ReplayVersionRefs } from '@/lib/policy-execution-log';
import type { PolicyReplayMetadata } from '@/services/policy/policy-api';
import {
  freezeFromExecutions,
  run,
  verifyStoredReportIntegrity,
  RULE_REGRESSION_RUNNER_VERSION,
  type RunReport,
} from '@/services/policy/rule-regression-runner';
import { deleteAppendOnlyRows, setupTestDb, teardownTestDb } from './setup-postgres';

// 真实后端捕获物（与 freeze 集成测试同源）。
const REAL_BACKEND_REPLAY: PolicyReplayMetadata = {
  runtimeToolchainId: 'abi=1.0;core=dev;validator=1;build=dev',
  canonicalizationVersion: 'aster-canonical-json/v1',
  canonicalInputHash: '5a5327f5c72ba17c43fdcbc6d2c1153ddf4e96047ddfcd8d540eb6a50148ab0a',
  canonicalOutputHash: '2866a8e6184869a75562a0fcd5b5147005189105f23f5f8b6889f0c3209a7369',
  traceHash: 'aafde62c2d55a4484b97eb7354001b837d0051e843e45cae73b3e04175f33ccd',
  reasonCodes: [],
  replayabilityStatus: 'REPLAYABLE',
  replayabilityReasons: [],
};

const OWNER = 'user-p0a-m12-1';
const POL = 'pol-p0a-m12-1';
const PV_ROW = 'pv-p0a-m12-1';
const FN = 'greet';
const LOCALE = 'en-US';
const SOURCE_TOOLCHAIN = 'abi=1.0;core=dev;validator=1;build=envelope';
const CNL = 'Module aster.test.\nRule greet given name as Text:\n  Return name.';

const REFS: ReplayVersionRefs = {
  policyVersionRowId: PV_ROW,
  policyVersion: 1,
  sourceToolchainId: SOURCE_TOOLCHAIN,
  vocabSnapshotRef: [],
  locale: LOCALE,
  aliasSetJson: {},
  functionName: FN,
};

// 基线迁移里 User / Policy 的 updatedAt 是 NOT NULL 且无库级默认值（schema 的 defaultNow 未落进迁移），须显式赋值。
async function seedAll() {
  await db.insert(users).values({
    id: OWNER, replayRetentionEnabled: true, updatedAt: new Date(),
  } as typeof users.$inferInsert);
  await db.insert(policies).values({
    id: POL, userId: OWNER, name: 'greet policy', content: CNL, updatedAt: new Date(),
  } as typeof policies.$inferInsert);
  await db.insert(policyVersions).values({
    id: PV_ROW, policyId: POL, version: 1, content: CNL,
    sourceToolchainId: SOURCE_TOOLCHAIN, sourceEnvelopeSha256: 'envelope-sha-m12-1',
  } as typeof policyVersions.$inferInsert);
  const cols = buildReplayColumns(REAL_BACKEND_REPLAY, REFS);
  await db.insert(executions).values({
    id: 'exec-p0a-m12-1', userId: OWNER, policyId: POL,
    input: { name: 'Ada' }, durationMs: 3, success: false, decision: 'indeterminate', source: 'api',
    ...cols,
  } as typeof executions.$inferInsert);
}

async function resetAll() {
  await deleteAppendOnlyRows([regressionReports, regressionCases]);
  await db.delete(executions);
  await db.delete(policyVersions);
  await db.delete(policies);
  await db.delete(users);
}

describe.skipIf(process.env.LICENSE_E2E !== '1' || process.env.P0A_LIVE_BACKEND !== '1')(
  'P0-A m1.2 reportHash 绑 caseHash + 离线核验（真库 + 真 run）',
  () => {
    beforeAll(async () => {
      process.env.AI_KEY_ENCRYPTION_SECRET = 'integration-test-secret-key-32chars';
      await setupTestDb();
    });
    afterAll(async () => {
      await teardownTestDb();
    });
    beforeEach(async () => {
      await resetAll();
      await seedAll();
    });

    it('★真 run 产出 m1.2 报告，每 case detail 携带 caseHash（= 其 RegressionCase.caseHash）', async () => {
      const fr = await freezeFromExecutions({ policyId: POL, actorUserId: OWNER, ownerUserId: OWNER });
      expect(fr.frozen).toBe(1);

      const report = await run({ policyId: POL, policyVersionRowId: PV_ROW, actorUserId: OWNER, tenantId: OWNER });
      // commit 半：逐 case 带 caseHash + caseHashVersion。★Item 4 F 后 run 产 m1.4（+ unsignableReasons 轴）；
      // m1.2/m1.3/m1.4 都绑 caseHash（golden 承诺，verifyReportIntegrity 认这些）。
      expect(report.runnerVersion).toBe(RULE_REGRESSION_RUNNER_VERSION);
      expect(report.cases.length).toBeGreaterThanOrEqual(1);

      const goldenRows = await db
        .select()
        .from(regressionCases)
        .where(eq(regressionCases.policyId, POL));
      const goldenById = new Map(goldenRows.map((g) => [g.id, g]));
      for (const c of report.cases) {
        expect(c.caseHash).toBeTruthy();
        expect(c.caseHashVersion).toBe('case-hash/m1.1');
        // 报告承诺的 caseHash 必须 = 该 RegressionCase 行的 caseHash（golden 完整性绑进报告）。
        expect(c.caseHash).toBe(goldenById.get(c.caseId)?.caseHash);
      }
    });

    it('★verifyStoredReportIntegrity：真库报告 + 真 golden → 全 MATCH, ok', async () => {
      await freezeFromExecutions({ policyId: POL, actorUserId: OWNER, ownerUserId: OWNER });
      const report = await run({ policyId: POL, policyVersionRowId: PV_ROW, actorUserId: OWNER, tenantId: OWNER });

      const res = await verifyStoredReportIntegrity(report.reportId);
      expect(res).not.toBeNull();
      expect(res!.verdict.reportHashValid).toBe(true);
      expect(res!.verdict.goldenCommitmentSupported).toBe(true);
      expect(res!.verdict.cases.every((c) => c.status === 'MATCH')).toBe(true);
      expect(res!.verdict.ok).toBe(true);
    });

    it('★攻击 A（更简单/更危险）：直改真库 expectedOutputHash 但**不改** caseHash → CURRENT_GOLDEN_INTEGRITY_FAILURE', async () => {
      await freezeFromExecutions({ policyId: POL, actorUserId: OWNER, ownerUserId: OWNER });
      const report = await run({ policyId: POL, policyVersionRowId: PV_ROW, actorUserId: OWNER, tenantId: OWNER });
      const before = await verifyStoredReportIntegrity(report.reportId);
      expect(before!.verdict.ok).toBe(true);

      // 攻击者改被 hash 保护的字段，但**保留原 caseHash**（不重算）。verifier 从字段重算 → 与存储不符。
      const target = report.cases[0].caseId;
      await db
        .update(regressionCases)
        .set({ expectedOutputHash: 'TAMPERED-OUTPUT-DIRECT-DB' })
        .where(eq(regressionCases.id, target));

      const after = await verifyStoredReportIntegrity(report.reportId);
      expect(after!.verdict.reportHashValid).toBe(true); // 报告 JSON 未改。
      expect(after!.verdict.ok).toBe(false); // 当前行不自洽 → 抓出。
      const t = after!.verdict.cases.find((c) => c.caseId === target);
      expect(t?.status).toBe('CURRENT_GOLDEN_INTEGRITY_FAILURE');
      expect(t?.recomputedCaseHash).not.toBe(t?.currentCaseHash);
    });

    it('★攻击 B：直改真库 caseHash → 与签字承诺不符（CASE_HASH_MISMATCH 或当前行不自洽）', async () => {
      await freezeFromExecutions({ policyId: POL, actorUserId: OWNER, ownerUserId: OWNER });
      const report = await run({ policyId: POL, policyVersionRowId: PV_ROW, actorUserId: OWNER, tenantId: OWNER });
      const before = await verifyStoredReportIntegrity(report.reportId);
      expect(before!.verdict.ok).toBe(true);

      // 只改存储 caseHash（不改字段）→ 存储 ≠ 重算 → CURRENT_GOLDEN_INTEGRITY_FAILURE（当前行不自洽）。
      const target = report.cases[0].caseId;
      await db
        .update(regressionCases)
        .set({ caseHash: 'TAMPERED-CASEHASH-DIRECT-DB' })
        .where(eq(regressionCases.id, target));

      const after = await verifyStoredReportIntegrity(report.reportId);
      expect(after!.verdict.ok).toBe(false);
      const t = after!.verdict.cases.find((c) => c.caseId === target);
      // 存储 caseHash 被改成随意值 → 与从字段重算的不符 → 当前行不自洽。
      expect(t?.status).toBe('CURRENT_GOLDEN_INTEGRITY_FAILURE');
    });
  }
);

// 类型引用保活（RunReport 用于文档化 run 返回结构）。
export type _M12RunReport = RunReport;
