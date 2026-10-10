// P0-A S1（信任层5）：createUpgradeManifest 全链闭环真库集成测试。
//
// 证明：签发（mock signing-api，用 dev regr 私钥真签，使 verifyRegressionTransition 真通过）→ 验签 →
// 落 RegressionUpgradeManifest（0040 trigger 通过）→ deriveReportTransitionEvidence 派生证据 →
// ★**报告仍派生 UNSIGNABLE**（携已验签 manifest 不移除 TOOLCHAIN_PROVENANCE_UNVERIFIED，层5≠层3）。
//
// Run: LICENSE_E2E=1 DATABASE_URL=postgresql://...:5544/aster_cloud（外部 DB，drizzle-kit push --force + 0040
//   触发器已 apply）AI_KEY_ENCRYPTION_SECRET=... pnpm exec vitest run --config vitest.integration.config.ts <file>

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sign as edSign, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, regressionReports, regressionUpgradeManifests } from '@/lib/prisma';
import { __setConfigForTests, canonicalStringify } from '@/lib/license-signing-client';
import {
  createUpgradeManifest,
  deriveReportTransitionEvidence,
  reportIdsWithVerifiedTransition,
} from '@/services/policy/regression-upgrade-manifest';
import { deriveReportSignabilityDetail, type RunReport } from '@/services/policy/rule-regression-runner';
import { deleteAppendOnlyRows, setupTestDb, teardownTestDb, withAppendOnlyBypass } from './setup-postgres';

const REP = 'rep-tm-1';
const POL = 'pol-tm-1';
const PVR = 'pv-tm-1';
const CREATOR = 'user-creator-tm';
const APPROVER = 'user-approver-tm';
const X = 'abi=1.0;core=1.0.13;validator=1;build=oldsha';
const Y = 'abi=1.0;core=1.0.14;validator=1;build=newsha';
// ★signing keyId 必须匹配 trust-bundle 条目（验签按 keyId 解析公钥）。dev bundle 是 __dev-regr-2026-01__；
// 生产 release pipeline 会把 dev 占位替换为真实 Vault key 名（同 license/revocation）。测试用 dev keyId。
const REGR_KEY = '__dev-regr-2026-01__';
// 与 trust-bundle __dev-regr-2026-01__ 公钥配对的私钥（同 verify 单测）。
const DEV_REGR_PRIV_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIERdgmfGWeAqshxs4u2OMasCeBryUM+ogO1UYmisfv4c
-----END PRIVATE KEY-----`;

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 一份 cross-toolchain PASS 报告（派生 TOOLCHAIN_PROVENANCE_UNVERIFIED → UNSIGNABLE），m1.5。
function reportJson(): Omit<RunReport, 'reportId' | 'reportHash'> {
  return {
    status: 'PASS', comparisonMode: 'FROZEN_BASELINE_VS_CURRENT_BACKEND', baselineSemantics: 'sem',
    policyId: POL, policyVersionRowId: PVR, currentRuntimeToolchainId: Y,
    coverage: { totalCases: 4, runnableCases: 4, approvedCases: 2, deniedCases: 2, handwrittenBoundaryCases: 1,
      thresholds: { minRunnableCases: 4, minApprovedCases: 1, minDeniedCases: 1, minHandwrittenBoundaryCases: 1 }, unmet: [] },
    summary: { passed: 4, failed: 0, nonReplayable: 0, compileFailures: 0 },
    cases: [{ caseId: 'c1', status: 'PASS', caseHash: 'c1-h', caseHashVersion: 'case-hash/m1.1',
      functionName: 'f', locale: 'en-US', coverageTags: [], sourceKind: 'execution',
      expectedOutputHash: 'h', actualOutputHash: 'h', baselineToolchainId: X, currentToolchainId: Y }],
    runnerVersion: 'p0a-runner/m1.5', signability: 'UNSIGNABLE',
    unsignableReasons: ['TOOLCHAIN_PROVENANCE_UNVERIFIED'], unsignableLegacyCases: 0,
    approvedTransitionManifestHash: null, transitionVerified: null,
  };
}

async function seedReport() {
  await db.insert(regressionReports).values({
    id: REP, policyId: POL, policyVersionRowId: PVR, status: 'PASS',
    comparisonMode: 'FROZEN_BASELINE_VS_CURRENT_BACKEND', caseCount: 4, runnableCaseCount: 4,
    passedCaseCount: 4, failedCaseCount: 0, nonReplayableCaseCount: 0,
    coverageJson: reportJson().coverage, reportJson: reportJson() as unknown as object,
    reportHash: 'rhash-tm-1', currentRuntimeToolchainId: Y, createdBy: CREATOR,
  } as typeof regressionReports.$inferInsert);
}

async function reset() {
  await deleteAppendOnlyRows([regressionUpgradeManifests, regressionReports]);
}

function rsaPem(): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString();
}

function testSigningConfig() {
  // ★JWT mint 用真实 RSA keypair（signPayloadRaw 会 RS256 签 operator/witness JWT）；
  // manifest 的 Ed25519 签名走 mock 的 sign 响应（dev regr 私钥）。
  return {
    baseUrl: 'http://signing-api.test', signingKeyId: REGR_KEY,
    issuer: 'https://billing-idp.test', audience: 'aster-license-signing-api',
    operatorSub: 'op-svc', witnessSub: 'wit-svc',
    operatorPrivateKeyPem: rsaPem(), witnessPrivateKeyPem: rsaPem(),
    operatorKid: 'op', witnessKid: 'wit', timeoutMs: 5000,
  };
}

describe.skipIf(process.env.LICENSE_E2E !== '1' || process.env.DEPLOYMENT_MODE === 'on-prem')(
  'P0-A S1 transition manifest 闭环（真库 + dev regr 私钥真签）',
  () => {
    const realFetch = globalThis.fetch;

    beforeAll(async () => {
      process.env.AI_KEY_ENCRYPTION_SECRET = 'integration-test-secret-key-32chars';
      process.env.REGRESSION_TRANSITION_SIGNING_KEY_ID = REGR_KEY;
      await setupTestDb();
    });
    afterAll(async () => {
      delete process.env.REGRESSION_TRANSITION_SIGNING_KEY_ID;
      await teardownTestDb();
    });
    beforeEach(async () => {
      await reset();
      await seedReport();
      __setConfigForTests(testSigningConfig());
      // mock signing-api：approve 返回 token；sign 用 dev regr 私钥真签 canonical manifest。
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as URL | Request).toString();
        if (url.endsWith('/v1/approve')) {
          return new Response(JSON.stringify({ approvalToken: 'a'.repeat(64) }), { status: 200 });
        }
        // sign：从请求体取 payload，canonical 化后用 dev 私钥真签（signing-api 也签 canonical bytes）。
        const reqBody = JSON.parse((init?.body as string) ?? '{}');
        const canonical = canonicalStringify(reqBody.payload);
        const sig = edSign(null, Buffer.from(canonical, 'utf8'), createPrivateKey(DEV_REGR_PRIV_PEM));
        return new Response(
          JSON.stringify({ signature: b64url(sig), keyVersion: '1', canonicalPayload: b64url(Buffer.from(canonical, 'utf8')) }),
          { status: 200 },
        );
      }) as typeof fetch;
    });
    afterEach(() => {
      __setConfigForTests(null);
      globalThis.fetch = realFetch;
    });

    it('★核心闭环：createUpgradeManifest 签+验+落库 → 报告派生证据，但**仍 UNSIGNABLE**（层5≠层3）', async () => {
      const result = await createUpgradeManifest({
        reportId: REP, baselineToolchainId: X, currentToolchainId: Y,
        approvedBy: APPROVER, expiresAt: new Date(Date.now() + 365 * 24 * 3600_000),
      });
      expect(result.transitionVerified).toBe(true);
      expect(result.keyId).toBe(REGR_KEY);

      // 真库落了 manifest 行（0040 trigger 全过）。
      const rows = await db.select().from(regressionUpgradeManifests).where(eq(regressionUpgradeManifests.reportId, REP));
      expect(rows).toHaveLength(1);
      expect(rows[0].manifestHash).toBe(result.manifestHash);

      // 读路径派生证据。
      const ev = await deriveReportTransitionEvidence(REP);
      expect(ev.approvedTransitionManifestHash).toBe(result.manifestHash);
      expect(ev.transitionVerified).toBe(true);

      // ★★铁律：报告携已验签 manifest 证据仍 UNSIGNABLE（provenance 未验证，层5≠层3）。
      const stored = (await db.select().from(regressionReports).where(eq(regressionReports.id, REP)))[0];
      const runReport = { ...(stored.reportJson as unknown as RunReport),
        approvedTransitionManifestHash: ev.approvedTransitionManifestHash, transitionVerified: ev.transitionVerified };
      const d = deriveReportSignabilityDetail(runReport);
      expect(d.unsignableReasons).toContain('TOOLCHAIN_PROVENANCE_UNVERIFIED');
      expect(d.signability).toBe('UNSIGNABLE');
    });

    it('★声明身份 SoD：approvedBy=creator → 拒绝（应用层）', async () => {
      await expect(createUpgradeManifest({
        reportId: REP, baselineToolchainId: X, currentToolchainId: Y,
        approvedBy: CREATOR, expiresAt: new Date(Date.now() + 3600_000),
      })).rejects.toThrow(/separation_of_duties/);
    });

    it('★X===Y → 拒绝（应用层，无方向）', async () => {
      await expect(createUpgradeManifest({
        reportId: REP, baselineToolchainId: X, currentToolchainId: X,
        approvedBy: APPROVER, expiresAt: new Date(Date.now() + 3600_000),
      })).rejects.toThrow(/must differ/);
    });

    it('★撤销后证据消失：revoke manifest → deriveReportTransitionEvidence 返回 null', async () => {
      const r = await createUpgradeManifest({
        reportId: REP, baselineToolchainId: X, currentToolchainId: Y,
        approvedBy: APPROVER, expiresAt: new Date(Date.now() + 365 * 24 * 3600_000),
      });
      await db.update(regressionUpgradeManifests)
        .set({ revokedAt: new Date(), revokedBy: 'revoker' })
        .where(eq(regressionUpgradeManifests.id, r.manifestId));
      const ev = await deriveReportTransitionEvidence(REP);
      expect(ev.approvedTransitionManifestHash).toBeNull();
      expect(ev.transitionVerified).toBeNull();
    });

    it('★★Codex 复审 P0：直插**伪造签名**的 manifest 行 → 读路径重新验签拒绝 → transitionVerified=null（不信表行）', async () => {
      // 攻击：普通 DB 写直插一行任意 canonicalPayload/signature（触发器只查结构不验签）。读路径必须重新验签
      // 才算 verified——伪造字节验签失败 → 不计入证据。这是 P0「表里有行≠已验签」的防线。
      await db.execute(sql`
        INSERT INTO "RegressionUpgradeManifest"(id,"reportId","reportHash","policyId","policyVersionRowId",
          "baselineToolchainId","currentToolchainId","canonicalPayloadB64url",signature,"keyId","keyVersion",
          "approvedBy","expiresAt","manifestHash")
        VALUES ('mf-forged',${REP},'rhash-tm-1',${POL},${PVR},${X},${Y},'ZmFrZQ','ZmFrZXNpZw',${REGR_KEY},'1',
          ${APPROVER},${new Date(Date.now() + 365 * 24 * 3600_000).toISOString()},'mh-forged')
      `);
      // 行确实落库了（触发器只查结构，伪造字节通过）。
      const rows = await db.select().from(regressionUpgradeManifests).where(eq(regressionUpgradeManifests.id, 'mf-forged'));
      expect(rows).toHaveLength(1);
      // ★但读路径重新验签 → 伪造签名验不过 → 证据为 null（不被伪造）。
      const ev = await deriveReportTransitionEvidence(REP);
      expect(ev.approvedTransitionManifestHash).toBeNull();
      expect(ev.transitionVerified).toBeNull();
    });

    it('★★Codex 复审 v2 P0：合法签名**改挂别报告**（存储 reportId/reportHash 改）→ 读路径拒（签名体 reportHash 不符）', async () => {
      // 先合法签一个 manifest（针对 REP）。
      const r = await createUpgradeManifest({
        reportId: REP, baselineToolchainId: X, currentToolchainId: Y,
        approvedBy: APPROVER, expiresAt: new Date(Date.now() + 365 * 24 * 3600_000),
      });
      // 造第二份报告（同 policy 不同 reportHash）。
      await db.insert(regressionReports).values({
        id: 'rep-tm-2', policyId: POL, policyVersionRowId: PVR, status: 'PASS',
        comparisonMode: 'FROZEN_BASELINE_VS_CURRENT_BACKEND', caseCount: 4, runnableCaseCount: 4,
        passedCaseCount: 4, failedCaseCount: 0, nonReplayableCaseCount: 0,
        coverageJson: reportJson().coverage, reportJson: reportJson() as unknown as object,
        reportHash: 'rhash-tm-2', currentRuntimeToolchainId: Y, createdBy: CREATOR,
      } as typeof regressionReports.$inferInsert);
      // 攻击：直改存储行改挂到 rep-tm-2（存储 reportId/reportHash 改，但签名体仍绑 REP 的 rhash-tm-1）。
      // append-only guard 冻结列，须绕 trigger 直改（模拟 DB 层攻击）。
      await withAppendOnlyBypass(async (tx) => {
        await tx.execute(sql`UPDATE "RegressionUpgradeManifest" SET "reportId"='rep-tm-2',"reportHash"='rhash-tm-2' WHERE id=${r.manifestId}`);
      });
      // ★读路径重新验签：签名体 reportHash=rhash-tm-1 ≠ 存储/父报告 rhash-tm-2 → 拒。
      const ev = await deriveReportTransitionEvidence('rep-tm-2');
      expect(ev.transitionVerified).toBeNull();
    });

    it('★★Codex 复审 v2 P0：合法签名**延寿**（存储 expiresAt 改长）→ 读路径拒（签名体 expiresAt 不符）', async () => {
      const shortExpiry = new Date(Date.now() + 60_000); // 1 分钟后过期
      const r = await createUpgradeManifest({
        reportId: REP, baselineToolchainId: X, currentToolchainId: Y,
        approvedBy: APPROVER, expiresAt: shortExpiry,
      });
      // 攻击：直改存储 expiresAt 延长到 1 年后（签名体仍是 shortExpiry）。
      await withAppendOnlyBypass(async (tx) => {
        await tx.execute(sql`UPDATE "RegressionUpgradeManifest" SET "expiresAt"=${new Date(Date.now() + 365 * 24 * 3600_000).toISOString()} WHERE id=${r.manifestId}`);
      });
      // ★读路径：签名体 expiresAt(short) ≠ 存储 expiresAt(延长) → 拒。
      const ev = await deriveReportTransitionEvidence(REP);
      expect(ev.transitionVerified).toBeNull();
    });

    it('★Codex 复审 v2：列表 reportIdsWithVerifiedTransition 也重新验签——伪造行不显 badge（防双口径）', async () => {
      await db.execute(sql`
        INSERT INTO "RegressionUpgradeManifest"(id,"reportId","reportHash","policyId","policyVersionRowId",
          "baselineToolchainId","currentToolchainId","canonicalPayloadB64url",signature,"keyId","keyVersion",
          "approvedBy","expiresAt","manifestHash")
        VALUES ('mf-list-forged',${REP},'rhash-tm-1',${POL},${PVR},${X},${Y},'ZmFrZQ','ZmFrZXNpZw',${REGR_KEY},'1',
          ${APPROVER},${new Date(Date.now() + 365 * 24 * 3600_000).toISOString()},'mh-list-forged')
      `);
      const verified = await reportIdsWithVerifiedTransition([REP]);
      expect(verified.has(REP)).toBe(false); // 伪造行不显 badge
    });

    it('★Codex 复审 v2 P1：currentRuntimeToolchainId=null（mixed）→ create fail-closed', async () => {
      await db.insert(regressionReports).values({
        id: 'rep-tm-null', policyId: POL, policyVersionRowId: PVR, status: 'PASS',
        comparisonMode: 'FROZEN_BASELINE_VS_CURRENT_BACKEND', caseCount: 1, runnableCaseCount: 1,
        passedCaseCount: 1, failedCaseCount: 0, nonReplayableCaseCount: 0,
        coverageJson: reportJson().coverage, reportJson: reportJson() as unknown as object,
        reportHash: 'rhash-tm-null', currentRuntimeToolchainId: null, createdBy: CREATOR,
      } as typeof regressionReports.$inferInsert);
      await expect(createUpgradeManifest({
        reportId: 'rep-tm-null', baselineToolchainId: X, currentToolchainId: Y,
        approvedBy: APPROVER, expiresAt: new Date(Date.now() + 3600_000),
      })).rejects.toThrow(/no single currentRuntimeToolchainId/);
    });
  }
);
