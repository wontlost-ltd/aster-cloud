// P0-A Item 3（INSERT 层 artifact 完整性 + 声明身份 SoD）真库集成测试。
//
// 验证 0039 迁移的 BEFORE INSERT trigger + FK：
//   (1) 应用路径不破坏：createDriftApproval 产出的审批（reportHash/policyId/pvRowId 取自父报告 + approvedBy
//       != creator）通过所有 trigger 校验，成功落库。
//   (2) 直连 DB 攻击路径被拦（拒绝类）：声明 SoD / orphan+FK / 父表 reportHash·policyId·pvRowId 不一致 /
//       预填 revoke（含只设 revokedBy）/ 过期倒置。
//   (3) backdate 覆盖实证：Case/Report/Approval 的 createdAt/approvedAt 均被 trigger 强制为服务器时刻。
//   (4) FK 存在且已 validated（pg_constraint 直查）。
//
// ★信任边界（诚实，见 docs/p0a-db-sod-decision.md）：SoD 是「声明身份不相等」，非真身份 SoD；本控制防受限
//   运行时凭证的普通 INSERT，不抗 DB owner/superuser。
//
// Run: LICENSE_E2E=1 DATABASE_URL=... pnpm test:integration
// ★前置：DB 须已应用 0039 trigger（drizzle-kit push 不跑迁移 SQL——用 pnpm db:migrate 或手 apply 0039）。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, regressionReports, regressionDriftApprovals, regressionCases } from '@/lib/prisma';
import { createDriftApproval } from '@/services/policy/rule-regression-runner';
import { deleteAppendOnlyRows, setupTestDb, teardownTestDb } from './setup-postgres';

const POL = 'pol-ig-1';
const PVR = 'pv-ig-1';
const REP = 'rep-ig-1';
const CREATOR = 'user-creator';
const APPROVER = 'user-approver';
// ★相对未来（避免固定 2027 年后测试腐烂）——ISO 串供 raw SQL 用。
const FUTURE_ISO = new Date(Date.now() + 365 * 24 * 3600_000).toISOString();

// FAIL_REGRESSION 报告，含一个可受控接受的 OUTPUT_HASH_MISMATCH drift（m1.3，signable）。
function reportJson() {
  return {
    status: 'FAIL_REGRESSION', comparisonMode: 'FROZEN_BASELINE_VS_CURRENT_BACKEND', baselineSemantics: 'sem',
    policyId: POL, policyVersionRowId: PVR, currentRuntimeToolchainId: 'tc-cur',
    coverage: { totalCases: 4, runnableCases: 4, approvedCases: 2, deniedCases: 2, handwrittenBoundaryCases: 1,
      thresholds: { minRunnableCases: 4, minApprovedCases: 1, minDeniedCases: 1, minHandwrittenBoundaryCases: 1 }, unmet: [] },
    summary: { passed: 3, failed: 1, nonReplayable: 0, compileFailures: 0 },
    cases: [{
      caseId: 'c1', status: 'FAIL_REGRESSION', reason: 'OUTPUT_HASH_MISMATCH',
      caseHash: 'c1-h', caseHashVersion: 'case-hash/m1.1', functionName: 'f', locale: 'en-US',
      coverageTags: [], sourceKind: 'execution', expectedOutputHash: 'base1', actualOutputHash: 'new1',
    }],
    runnerVersion: 'p0a-runner/m1.3', signability: 'SIGNABLE', unsignableLegacyCases: 0,
  };
}

async function seedReport() {
  await db.insert(regressionReports).values({
    id: REP, policyId: POL, policyVersionRowId: PVR, status: 'FAIL_REGRESSION',
    comparisonMode: 'FROZEN_BASELINE_VS_CURRENT_BACKEND', caseCount: 4, runnableCaseCount: 4,
    passedCaseCount: 3, failedCaseCount: 1, nonReplayableCaseCount: 0,
    coverageJson: reportJson().coverage, reportJson: reportJson() as unknown as object,
    reportHash: 'rhash-ig-1', currentRuntimeToolchainId: 'tc-cur', createdBy: CREATOR,
  } as typeof regressionReports.$inferInsert);
}

async function reset() {
  // append-only：清理须绕 trigger（仅测试）。
  await deleteAppendOnlyRows([regressionDriftApprovals, regressionReports, regressionCases]);
}

/**
 * 断言一个直插被 DB trigger/FK 拒绝，且错误（drizzle 把 PG 错误裹进 error.cause.message）匹配 pattern。
 * db.execute 的 .message 是「Failed query: ...」壳，真实 trigger 消息在 cause。
 */
async function expectRejected(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  let err: unknown;
  try {
    await run();
  } catch (e) {
    err = e;
  }
  expect(err, 'expected insert to be rejected by DB guard').toBeDefined();
  const causeMsg = (err as { cause?: { message?: string } })?.cause?.message ?? '';
  const topMsg = (err as { message?: string })?.message ?? '';
  expect(`${topMsg}\n${causeMsg}`).toMatch(pattern);
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('P0-A Item 3 INSERT guards（真库 0039 trigger）', () => {
  beforeAll(async () => {
    process.env.AI_KEY_ENCRYPTION_SECRET = 'integration-test-secret-key-32chars';
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await reset();
    await seedReport();
  });

  it('★应用路径：createDriftApproval（approver!=creator）通过 trigger 成功落库', async () => {
    const res = await createDriftApproval({
      reportId: REP, reason: 'intentional bugfix', approvedBy: APPROVER,
      expiresAt: new Date(FUTURE_ISO),
    });
    expect(res.approvalId).toBeTruthy();
    const rows = await db.select().from(regressionDriftApprovals).where(eq(regressionDriftApprovals.id, res.approvalId));
    expect(rows).toHaveLength(1);
    // ★backdate 防护：approvedAt/createdAt 被 trigger 强制为服务器时刻（近当下）。
    expect(rows[0].approvedAt.getTime()).toBeGreaterThan(new Date('2025-01-01').getTime());
  });

  it('★backdate 防护：直插 report 设 createdAt=2020 → trigger 覆盖为 now', async () => {
    await db.execute(sql`
      INSERT INTO "RegressionReport"(id,"policyId","policyVersionRowId",status,"comparisonMode","caseCount",
        "runnableCaseCount","passedCaseCount","failedCaseCount","nonReplayableCaseCount","coverageJson",
        "reportJson","reportHash","createdBy","createdAt")
      VALUES ('rep-bd','pol1','pv1','PASS','FROZEN_BASELINE_VS_CURRENT_BACKEND',1,1,1,0,0,'{}'::jsonb,'{}'::jsonb,
        'rhash-bd','x','2020-01-01T00:00:00Z')
    `);
    const rows = await db.select().from(regressionReports).where(eq(regressionReports.id, 'rep-bd'));
    expect(rows[0].createdAt.getTime()).toBeGreaterThan(new Date('2025-01-01').getTime());
  });

  it('★声明 SoD：直插 approvedBy=creator → trigger 拒绝', async () => {
    await expectRejected(() => db.execute(sql`
        INSERT INTO "RegressionDriftApproval"(id,"reportId","reportHash","policyId","policyVersionRowId",
          "acceptedDrifts",reason,"approvedBy","expiresAt","approvalHash")
        VALUES ('a-sod',${REP},'rhash-ig-1',${POL},${PVR},'[]'::jsonb,'r',${CREATOR},${FUTURE_ISO},'ah-sod')
      `), /separation_of_duties/);
  });

  it('★FK/orphan：直插引用不存在报告 → 拒绝', async () => {
    await expectRejected(() => db.execute(sql`
        INSERT INTO "RegressionDriftApproval"(id,"reportId","reportHash","policyId","policyVersionRowId",
          "acceptedDrifts",reason,"approvedBy","expiresAt","approvalHash")
        VALUES ('a-orph','NOEXIST','rhash-ig-1',${POL},${PVR},'[]'::jsonb,'r',${APPROVER},${FUTURE_ISO},'ah-orph')
      `), /missing report|foreign key|violates/i);
  });

  it('★父表 hash 一致：reportHash 与父报告不符 → 拒绝', async () => {
    await expectRejected(() => db.execute(sql`
        INSERT INTO "RegressionDriftApproval"(id,"reportId","reportHash","policyId","policyVersionRowId",
          "acceptedDrifts",reason,"approvedBy","expiresAt","approvalHash")
        VALUES ('a-hm',${REP},'WRONGHASH',${POL},${PVR},'[]'::jsonb,'r',${APPROVER},${FUTURE_ISO},'ah-hm')
      `), /reportHash does not match/);
  });

  it('★预填 revoke：INSERT 带 revokedAt → 拒绝', async () => {
    await expectRejected(() => db.execute(sql`
        INSERT INTO "RegressionDriftApproval"(id,"reportId","reportHash","policyId","policyVersionRowId",
          "acceptedDrifts",reason,"approvedBy","expiresAt","approvalHash","revokedAt","revokedBy")
        VALUES ('a-rv',${REP},'rhash-ig-1',${POL},${PVR},'[]'::jsonb,'r',${APPROVER},${FUTURE_ISO},'ah-rv',
          '2026-01-01T00:00:00Z','x')
      `), /must be inserted un-revoked/);
  });

  it('★过期倒置：expiresAt 在过去 → 拒绝', async () => {
    await expectRejected(() => db.execute(sql`
        INSERT INTO "RegressionDriftApproval"(id,"reportId","reportHash","policyId","policyVersionRowId",
          "acceptedDrifts",reason,"approvedBy","expiresAt","approvalHash")
        VALUES ('a-exp',${REP},'rhash-ig-1',${POL},${PVR},'[]'::jsonb,'r',${APPROVER},'2020-01-01T00:00:00Z','ah-exp')
      `), /expiresAt must be after approvedAt/);
  });

  // ── Codex 复审补：父表其余两字段 + 只设 revokedBy + Case stamp + approval backdate + FK validated ──

  it('★父表 policyId 不符 → 拒绝', async () => {
    await expectRejected(() => db.execute(sql`
        INSERT INTO "RegressionDriftApproval"(id,"reportId","reportHash","policyId","policyVersionRowId",
          "acceptedDrifts",reason,"approvedBy","expiresAt","approvalHash")
        VALUES ('a-pm',${REP},'rhash-ig-1','WRONGPOL',${PVR},'[]'::jsonb,'r',${APPROVER},${FUTURE_ISO},'ah-pm')
      `), /policyId does not match/);
  });

  it('★父表 policyVersionRowId 不符 → 拒绝', async () => {
    await expectRejected(() => db.execute(sql`
        INSERT INTO "RegressionDriftApproval"(id,"reportId","reportHash","policyId","policyVersionRowId",
          "acceptedDrifts",reason,"approvedBy","expiresAt","approvalHash")
        VALUES ('a-pvm',${REP},'rhash-ig-1',${POL},'WRONGPV','[]'::jsonb,'r',${APPROVER},${FUTURE_ISO},'ah-pvm')
      `), /policyVersionRowId does not match/);
  });

  it('★只设 revokedBy（revokedAt=NULL）也拒（初始状态必须双 NULL）', async () => {
    await expectRejected(() => db.execute(sql`
        INSERT INTO "RegressionDriftApproval"(id,"reportId","reportHash","policyId","policyVersionRowId",
          "acceptedDrifts",reason,"approvedBy","expiresAt","approvalHash","revokedBy")
        VALUES ('a-rvb',${REP},'rhash-ig-1',${POL},${PVR},'[]'::jsonb,'r',${APPROVER},${FUTURE_ISO},'ah-rvb','x')
      `), /must be inserted un-revoked/);
  });

  it('★RegressionCase createdAt 也被 trigger 强制为服务器时刻（backdate 覆盖，非 2020）', async () => {
    await db.execute(sql`
      INSERT INTO "RegressionCase"(id,"policyId","policyVersionRowId","functionName",locale,"aliasSetJson",
        "vocabSnapshotRef","canonicalInputHash","expectedOutputHash","canonicalizationVersion","sourceKind",
        "coverageTags","caseHash","caseHashVersion","createdBy","createdAt")
      VALUES ('case-bd',${POL},${PVR},'greet','en-US','{}'::jsonb,'[]'::jsonb,'in','out','aster-canonical-json/v1',
        'execution','[]'::jsonb,'case-bd-hash','case-hash/m1.1','x','2020-01-01T00:00:00Z')
    `);
    // 用 drizzle typed select（与其它 backdate 测同款解析，避开 timestamp-without-tz 的字符串歧义）。
    const rows = await db.select().from(regressionCases).where(eq(regressionCases.id, 'case-bd'));
    // 被强制为服务器 statement_timestamp（>2025）——若 backdate 保留会是 2020。
    expect(rows[0].createdAt.getTime()).toBeGreaterThan(new Date('2025-01-01').getTime());
  });

  it('★approval 显式 backdate approvedAt/createdAt=2020 → 均被 trigger 覆盖为服务器时刻（非 2020）', async () => {
    await db.execute(sql`
      INSERT INTO "RegressionDriftApproval"(id,"reportId","reportHash","policyId","policyVersionRowId",
        "acceptedDrifts",reason,"approvedBy","approvedAt","expiresAt","approvalHash","createdAt")
      VALUES ('a-bd',${REP},'rhash-ig-1',${POL},${PVR},'[]'::jsonb,'r',${APPROVER},'2020-01-01T00:00:00Z',
        ${FUTURE_ISO},'ah-bd','2020-01-01T00:00:00Z')
    `);
    const rows = await db.select().from(regressionDriftApprovals).where(eq(regressionDriftApprovals.id, 'a-bd'));
    expect(rows[0].approvedAt.getTime()).toBeGreaterThan(new Date('2025-01-01').getTime());
    expect(rows[0].createdAt.getTime()).toBeGreaterThan(new Date('2025-01-01').getTime());
  });

  it('★FK 存在且已 validated（pg_constraint 直查）', async () => {
    const rows = await db.execute(sql`
      SELECT conname, convalidated FROM pg_constraint
      WHERE conname = 'RegressionDriftApproval_reportId_fkey' AND contype = 'f'
    `);
    const arr = rows as unknown as Array<{ conname: string; convalidated: boolean }>;
    expect(arr).toHaveLength(1);
    expect(arr[0].convalidated).toBe(true);
  });
});
