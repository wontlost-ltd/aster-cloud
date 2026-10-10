// P0-A S1（信任层5）：RegressionUpgradeManifest 表 + 触发器（迁移 0040）真库集成测试。
//
// 验证 append-only（0037 同款）+ INSERT 守卫（0039 同款）+ manifest 专属方向性约束：
//   (1) 应用路径：合法 manifest（approver != creator，父一致，X≠Y）INSERT 成功落库 + backdate 被覆盖。
//   (2) 直连攻击路径被拦：声明 SoD / orphan+FK / 父表 hash·policy·pvRow 不一致 / 预填 revoke / 过期倒置 /
//       X===Y 无方向。
//   (3) append-only：DELETE 被禁；UPDATE 只允许一次性 revoke（双 NULL→双非 NULL）。
//
// ★信任边界（诚实，见 docs/p0a-db-sod-decision.md）：SoD 是声明身份不相等，非真身份；防受限凭证普通 INSERT，
//   不抗 DB superuser。真身份 SoD 靠 2-人 ceremony（operator/witness）+ 应用可信 session。
//
// Run: LICENSE_E2E=1 pnpm test:integration（Testcontainers 自管 postgres:16 + migrate；或外部 DATABASE_URL）。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, regressionReports, regressionUpgradeManifests } from '@/lib/prisma';
import { deleteAppendOnlyRows, setupTestDb, teardownTestDb } from './setup-postgres';

const POL = 'pol-mg-1';
const PVR = 'pv-mg-1';
const REP = 'rep-mg-1';
const CREATOR = 'user-creator-mg';
const APPROVER = 'user-approver-mg';
const RHASH = 'rhash-mg-1';
const X = 'abi=1.0;core=1.0.13;validator=1;build=oldsha';
const Y = 'abi=1.0;core=1.0.14;validator=1;build=newsha';
const FUTURE_ISO = new Date(Date.now() + 365 * 24 * 3600_000).toISOString();

async function seedReport() {
  await db.insert(regressionReports).values({
    id: REP, policyId: POL, policyVersionRowId: PVR, status: 'PASS',
    comparisonMode: 'FROZEN_BASELINE_VS_CURRENT_BACKEND', caseCount: 4, runnableCaseCount: 4,
    passedCaseCount: 4, failedCaseCount: 0, nonReplayableCaseCount: 0,
    coverageJson: {}, reportJson: {} as unknown as object,
    reportHash: RHASH, currentRuntimeToolchainId: Y, createdBy: CREATOR,
  } as typeof regressionReports.$inferInsert);
}

async function reset() {
  // append-only：清理须绕 trigger（仅测试）。
  await deleteAppendOnlyRows([regressionUpgradeManifests, regressionReports]);
}

async function expectRejected(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  let err: unknown;
  try {
    await run();
  } catch (e) {
    err = e;
  }
  expect(err, 'expected insert/update to be rejected by DB guard').toBeDefined();
  const causeMsg = (err as { cause?: { message?: string } })?.cause?.message ?? '';
  const topMsg = (err as { message?: string })?.message ?? '';
  expect(`${topMsg}\n${causeMsg}`).toMatch(pattern);
}

/** 合法 manifest 的 raw INSERT（供攻击变体覆盖单列）。 */
function insertManifestSql(over: Partial<Record<string, string>> = {}): Promise<unknown> {
  const v = {
    id: 'mf-ok', reportId: REP, reportHash: RHASH, policyId: POL, policyVersionRowId: PVR,
    baselineToolchainId: X, currentToolchainId: Y,
    canonicalPayloadB64url: 'cGF5', signature: 'c2ln', keyId: 'regression-transition-signing-v2-2026-01',
    keyVersion: '1', approvedBy: APPROVER, expiresAt: FUTURE_ISO, manifestHash: 'mh-ok', ...over,
  };
  return db.execute(sql`
    INSERT INTO "RegressionUpgradeManifest"(id,"reportId","reportHash","policyId","policyVersionRowId",
      "baselineToolchainId","currentToolchainId","canonicalPayloadB64url",signature,"keyId","keyVersion",
      "approvedBy","expiresAt","manifestHash")
    VALUES (${v.id},${v.reportId},${v.reportHash},${v.policyId},${v.policyVersionRowId},
      ${v.baselineToolchainId},${v.currentToolchainId},${v.canonicalPayloadB64url},${v.signature},${v.keyId},
      ${v.keyVersion},${v.approvedBy},${v.expiresAt},${v.manifestHash})
  `);
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('P0-A S1 RegressionUpgradeManifest guards（真库 0040 trigger）', () => {
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

  it('★应用路径：合法 manifest（approver!=creator, 父一致, X≠Y）INSERT 成功 + backdate 覆盖', async () => {
    await insertManifestSql();
    const rows = await db.select().from(regressionUpgradeManifests).where(eq(regressionUpgradeManifests.id, 'mf-ok'));
    expect(rows).toHaveLength(1);
    // backdate 防护：approvedAt/createdAt 被 trigger 强制为服务器时刻（近当下）。
    expect(rows[0].approvedAt.getTime()).toBeGreaterThan(new Date('2025-01-01').getTime());
    expect(rows[0].createdAt.getTime()).toBeGreaterThan(new Date('2025-01-01').getTime());
  });

  it('★backdate：直插 approvedAt/createdAt=2020 → 被 trigger 覆盖为服务器时刻', async () => {
    await db.execute(sql`
      INSERT INTO "RegressionUpgradeManifest"(id,"reportId","reportHash","policyId","policyVersionRowId",
        "baselineToolchainId","currentToolchainId","canonicalPayloadB64url",signature,"keyId","keyVersion",
        "approvedBy","approvedAt","expiresAt","manifestHash","createdAt")
      VALUES ('mf-bd',${REP},${RHASH},${POL},${PVR},${X},${Y},'p','s','k','1',${APPROVER},
        '2020-01-01T00:00:00Z',${FUTURE_ISO},'mh-bd','2020-01-01T00:00:00Z')
    `);
    const rows = await db.select().from(regressionUpgradeManifests).where(eq(regressionUpgradeManifests.id, 'mf-bd'));
    expect(rows[0].approvedAt.getTime()).toBeGreaterThan(new Date('2025-01-01').getTime());
    expect(rows[0].createdAt.getTime()).toBeGreaterThan(new Date('2025-01-01').getTime());
  });

  it('★声明 SoD：approvedBy=creator → 拒绝', async () => {
    await expectRejected(() => insertManifestSql({ id: 'mf-sod', manifestHash: 'mh-sod', approvedBy: CREATOR }), /separation_of_duties/);
  });

  it('★FK/orphan：引用不存在报告 → 拒绝', async () => {
    await expectRejected(() => insertManifestSql({ id: 'mf-orph', manifestHash: 'mh-orph', reportId: 'NOEXIST' }), /missing report|foreign key|violates/i);
  });

  it('★父表 reportHash 不符 → 拒绝', async () => {
    await expectRejected(() => insertManifestSql({ id: 'mf-hm', manifestHash: 'mh-hm', reportHash: 'WRONG' }), /reportHash does not match/);
  });

  it('★父表 policyId 不符 → 拒绝', async () => {
    await expectRejected(() => insertManifestSql({ id: 'mf-pm', manifestHash: 'mh-pm', policyId: 'WRONGPOL' }), /policyId does not match/);
  });

  it('★父表 policyVersionRowId 不符 → 拒绝', async () => {
    await expectRejected(() => insertManifestSql({ id: 'mf-pvm', manifestHash: 'mh-pvm', policyVersionRowId: 'WRONGPV' }), /policyVersionRowId does not match/);
  });

  it('★X===Y（无方向）→ 拒绝 manifest-not-directional', async () => {
    await expectRejected(() => insertManifestSql({ id: 'mf-dir', manifestHash: 'mh-dir', currentToolchainId: X }), /must differ from currentToolchainId/);
  });

  it('★过期倒置：expiresAt 在过去 → 拒绝', async () => {
    await expectRejected(() => insertManifestSql({ id: 'mf-exp', manifestHash: 'mh-exp', expiresAt: '2020-01-01T00:00:00Z' }), /expiresAt must be after approvedAt/);
  });

  it('★预填 revoke：INSERT 带 revokedAt → 拒绝', async () => {
    await expectRejected(() => db.execute(sql`
      INSERT INTO "RegressionUpgradeManifest"(id,"reportId","reportHash","policyId","policyVersionRowId",
        "baselineToolchainId","currentToolchainId","canonicalPayloadB64url",signature,"keyId","keyVersion",
        "approvedBy","expiresAt","manifestHash","revokedAt","revokedBy")
      VALUES ('mf-rv',${REP},${RHASH},${POL},${PVR},${X},${Y},'p','s','k','1',${APPROVER},${FUTURE_ISO},'mh-rv',
        '2026-01-01T00:00:00Z','x')
    `), /must be inserted un-revoked/);
  });

  it('★append-only：DELETE 被禁', async () => {
    await insertManifestSql({ id: 'mf-del', manifestHash: 'mh-del' });
    await expectRejected(() => db.execute(sql`DELETE FROM "RegressionUpgradeManifest" WHERE id='mf-del'`), /DELETE.*forbidden/i);
  });

  it('★append-only：UPDATE 非 revoke 列 → 拒绝', async () => {
    await insertManifestSql({ id: 'mf-imm', manifestHash: 'mh-imm' });
    await expectRejected(() => db.execute(sql`UPDATE "RegressionUpgradeManifest" SET signature='TAMPER' WHERE id='mf-imm'`), /immutable except revoke/);
  });

  it('★revoke 一次性：只设 revokedBy（revokedAt=NULL）→ 拒绝；双设 → 成功', async () => {
    await insertManifestSql({ id: 'mf-rev', manifestHash: 'mh-rev' });
    await expectRejected(() => db.execute(sql`UPDATE "RegressionUpgradeManifest" SET "revokedBy"='x' WHERE id='mf-rev'`), /both revokedAt and revokedBy/);
    // 双设 → 成功。
    await db.execute(sql`UPDATE "RegressionUpgradeManifest" SET "revokedAt"=now(),"revokedBy"='revoker' WHERE id='mf-rev'`);
    const rows = await db.select().from(regressionUpgradeManifests).where(eq(regressionUpgradeManifests.id, 'mf-rev'));
    expect(rows[0].revokedAt).not.toBeNull();
    // 二次 revoke → 拒绝（一次性）。
    await expectRejected(() => db.execute(sql`UPDATE "RegressionUpgradeManifest" SET "revokedAt"=now(),"revokedBy"='again' WHERE id='mf-rev'`), /already revoked/);
  });
});
