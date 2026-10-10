// P0-A 回归工具 freeze 闭环集成回归测试（真实 Postgres，testcontainers 或外部 DATABASE_URL）。
//
// 验证目标（承 aster-cloud#261「上游 REPLAYABLE writer」修复）：
//   #261 之前 buildReplayColumns 硬写 replayabilityStatus='NON_REPLAYABLE'（M1 遗留），导致
//   freezeFromExecutions 的 gate（WHERE replayabilityStatus='REPLAYABLE' ...）永远选不到行（freeze
//   空集，工具对真实数据不可用）。#261 后 writer 按后端 replayMetadata 判 REPLAYABLE。本测试用真库
//   保护「writer 产 REPLAYABLE → freeze 选中 → 冻成 RegressionCase」这条链，防 #261 回退。
//
// ★证据分层（本项目铁律：不伪造证据、不冒充自动断言）：
//   1) 默认套件（LICENSE_E2E=1）——**已核验 backend-fixture 的 writer→freeze 集成回归**。
//      本文件不启动 aster-api；用的 BACKEND_CAPTURE 是一次真实本地捕获（见下），且测试**在运行时
//      重算 hash 契约** sha256(canonicalizationVersion + "\n" + payload) == hash，令 fixture 自洽可审计
//      （不是只把常量和自己比）。它证明的是「给定这份已核验 metadata，writer + freeze 闭环正确」。
//   2) live-backend 用例（P0A_LIVE_BACKEND=1，默认 skip）——**真调 aster-api 的端到端断言**：
//      测试内以 HMAC 内部调用签名打 POST /evaluate-source?replayCapture=true，断言后端真返回
//      REPLAYABLE + traceHash，并重算 hash 契约。这段才是「后端真产 REPLAYABLE」的可执行证据；
//      因依赖本地在跑的 aster-api，CI 无后端故默认 skip，由本地手动跑（见 memory
//      p0a-e2e-local-verification 的捕获步骤）。★注意：本地跑需关**全局** RequestSignatureFilter
//      （aster.security.signature.enabled=false，那是 per-tenant secret 的另一层），但
//      InternalCallerFilter 的 PlanGate HMAC **仍然强制**——live 请求并未绕过 HMAC，签名必须验过。
//   3) run→PASS 不在本测试范围：run 每 case 真调 aster-api 重求值，且 P0-1 铁律要
//      baselineToolchain ≠ currentToolchain（本地单版本→必然相等→BASELINE_EQUALS_CURRENT→
//      NON_REPLAYABLE）。真 PASS 需两个不同 toolchain 版本（跨版本升级场景），非本地单实例可诚实
//      复现——刻意不伪造第二个 toolchain 造假 PASS。
//
// 数据库隔离：vitest.integration.config.ts 设 fileParallelism:false（集成文件串行），故本 suite 的
// 全表 delete 清理不与其他集成文件并发互扰。
//
// Run（fixture 集成）: LICENSE_E2E=1 DATABASE_URL=postgresql://postgres:postgres@localhost:5432/aster_cloud pnpm test:integration
// Run（含 live 端到端）: 额外 P0A_LIVE_BACKEND=1 + 本地 aster-api 在 :8080（signature.enabled=false）+ ASTER_PLAN_GATE_HMAC_KEY

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  db,
  executions,
  policies,
  policyVersions,
  users,
  regressionCases,
} from '@/lib/prisma';
import {
  buildReplayColumns,
  STATUS_REPLAYABLE,
  STATUS_NON_REPLAYABLE,
  type ReplayVersionRefs,
} from '@/lib/policy-execution-log';
import type { PolicyReplayMetadata } from '@/services/policy/policy-api';
import { freezeFromExecutions } from '@/services/policy/rule-regression-runner';
import { deleteAppendOnlyRows, setupTestDb, teardownTestDb } from './setup-postgres';

// ★真实捕获物（provenance）：本地 aster-api quarkusDev（GraalVM/Truffle，M2.1b step-trace armed）
//   对 `Module aster.test. Rule greet given name as Text: Return name.` + {"name":"Ada"} 经 HMAC
//   内部调用 evaluate-source?replayCapture=true 返回的 replayMetadata（含 M2 canonical payload），
//   原样，未改。**hash 由测试运行时重算核对**（见 describe('backend-capture 自洽')），非无法复核的声明。
const BACKEND_CAPTURE = {
  canonicalizationVersion: 'aster-canonical-json/v1',
  canonicalInput: '{"name":"Ada"}',
  canonicalInputHash: '5a5327f5c72ba17c43fdcbc6d2c1153ddf4e96047ddfcd8d540eb6a50148ab0a',
  canonicalOutput: '"Ada"',
  canonicalOutputHash: '2866a8e6184869a75562a0fcd5b5147005189105f23f5f8b6889f0c3209a7369',
  canonicalTrace:
    '{"finalResult":"Ada","functionName":"greet","moduleName":"aster.test","steps":[{"children":[],"expression":"return value","matched":true,"result":"Ada","sequence":1}]}',
  traceHash: 'aafde62c2d55a4484b97eb7354001b837d0051e843e45cae73b3e04175f33ccd',
  runtimeToolchainId: 'abi=1.0;core=dev;validator=1;build=dev',
} as const;

/** replayMetadata 视图（喂 buildReplayColumns 用，字段与 PolicyReplayMetadata 对齐）。 */
const REAL_BACKEND_REPLAY: PolicyReplayMetadata = {
  runtimeToolchainId: BACKEND_CAPTURE.runtimeToolchainId,
  canonicalizationVersion: BACKEND_CAPTURE.canonicalizationVersion,
  canonicalInputHash: BACKEND_CAPTURE.canonicalInputHash,
  canonicalOutputHash: BACKEND_CAPTURE.canonicalOutputHash,
  traceHash: BACKEND_CAPTURE.traceHash,
  reasonCodes: [],
  replayabilityStatus: 'REPLAYABLE',
  replayabilityReasons: [],
};

/** hash 契约：sha256(canonicalizationVersion + "\n" + payload) == hash（ADR 0030 / m2-replay-payload-contract）。 */
function canonicalHashOf(version: string, payload: string): string {
  return createHash('sha256').update(version + '\n' + payload, 'utf8').digest('hex');
}

const OWNER = 'user-p0a-freeze-1';
const POL = 'pol-p0a-freeze-1';
const PV_ROW = 'pv-p0a-freeze-1';
const FN = 'greet';
const LOCALE = 'en-US';
// PolicyVersion.sourceToolchainId（envelope 编译工具链）——刻意 ≠ runtimeToolchainId。
const SOURCE_TOOLCHAIN = 'abi=1.0;core=dev;validator=1;build=envelope';

const REFS: ReplayVersionRefs = {
  policyVersionRowId: PV_ROW,
  policyVersion: 1,
  sourceToolchainId: SOURCE_TOOLCHAIN,
  vocabSnapshotRef: [],
  locale: LOCALE,
  aliasSetJson: {},
  functionName: FN,
};

/**
 * 种 Execution 行。所有可控参数显式传入，便于单变量对照：
 * @param status       replayabilityStatus（REPLAYABLE / NON_REPLAYABLE）
 * @param locale       locale（用于按分组键隔离不同行，避免 RegressionCase 唯一约束撞而**不改** hash）
 */
async function seedExecution(id: string, status: string, locale: string) {
  // buildReplayColumns 产 #261 的回放列（REPLAYABLE 全字段齐全）。
  const cols = buildReplayColumns(REAL_BACKEND_REPLAY, { ...REFS, locale });
  await db.insert(executions).values({
    id,
    userId: OWNER,
    policyId: POL,
    input: { name: 'Ada' },
    durationMs: 3,
    // ★schema 语义（db/schema.ts）：decision=indeterminate（值输出无准入决策）不计失败，
    // 对应 success=false（非「成功准入判定」）。freeze 不筛 success，此处仅为 fixture 语义正确。
    success: false,
    decision: 'indeterminate',
    source: 'api',
    ...cols,
    locale,
    // ★单变量控制：只覆写 status，其余（input/canonical*Hash/traceHash/toolchain）全用真实捕获值。
    replayabilityStatus: status,
  } as typeof executions.$inferInsert);
}

// 基线迁移里 User / Policy 的 updatedAt 是 NOT NULL 且无库级默认值（schema 的 defaultNow 未落进迁移），须显式赋值。
async function seedParents() {
  await db.insert(users).values({
    id: OWNER,
    replayRetentionEnabled: true, // 开 retention → freeze 才存 inputJson（可回放前提）。
    updatedAt: new Date(),
  } as typeof users.$inferInsert);
  await db.insert(policies).values({
    id: POL,
    userId: OWNER,
    name: 'greet policy',
    content: 'Module aster.test. Rule greet given name as Text: Return name.',
    updatedAt: new Date(),
  } as typeof policies.$inferInsert);
  await db.insert(policyVersions).values({
    id: PV_ROW,
    policyId: POL,
    version: 1,
    content: 'Module aster.test. Rule greet given name as Text: Return name.',
    sourceToolchainId: SOURCE_TOOLCHAIN,
    sourceEnvelopeSha256: 'envelope-sha-p0a-1',
  } as typeof policyVersions.$inferInsert);
}

async function resetTables() {
  await deleteAppendOnlyRows([regressionCases]);
  await db.delete(executions);
  await db.delete(policyVersions);
  await db.delete(policies);
  await db.delete(users);
}

// ── 证据段 1：backend-capture 自洽（不依赖 DB，令 fixture 可审计而非无法复核的声明） ──
describe.skipIf(process.env.LICENSE_E2E !== '1')('P0-A backend-capture 自洽（hash 契约重算）', () => {
  it('★捕获的 canonical payload 与其 hash 自洽（运行时重算 sha256，非常量自比）', () => {
    const v = BACKEND_CAPTURE.canonicalizationVersion;
    expect(canonicalHashOf(v, BACKEND_CAPTURE.canonicalInput)).toBe(BACKEND_CAPTURE.canonicalInputHash);
    expect(canonicalHashOf(v, BACKEND_CAPTURE.canonicalOutput)).toBe(BACKEND_CAPTURE.canonicalOutputHash);
    expect(canonicalHashOf(v, BACKEND_CAPTURE.canonicalTrace)).toBe(BACKEND_CAPTURE.traceHash);
  });
});

// ── 证据段 2：writer→freeze 闭环（真库集成回归，保护 #261） ──
describe.skipIf(process.env.LICENSE_E2E !== '1')('P0-A freeze 闭环（真库，承 #261）', () => {
  beforeAll(async () => {
    process.env.AI_KEY_ENCRYPTION_SECRET = 'integration-test-secret-key-32chars';
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await resetTables();
    await seedParents();
  });

  it('★#261 writer 对真实 backend replayMetadata 产 REPLAYABLE + freeze-gate 字段齐全', () => {
    const cols = buildReplayColumns(REAL_BACKEND_REPLAY, REFS);
    expect(cols.replayabilityStatus).toBe(STATUS_REPLAYABLE);
    // freeze WHERE 依赖的每个字段都必须非空——否则 gate 会漏（#261 完整性正在于此）。
    expect(cols.traceHash).toBe(BACKEND_CAPTURE.traceHash);
    expect(cols.canonicalInputHash).toBe(BACKEND_CAPTURE.canonicalInputHash);
    expect(cols.canonicalOutputHash).toBe(BACKEND_CAPTURE.canonicalOutputHash);
    expect(cols.canonicalizationVersion).toBe(BACKEND_CAPTURE.canonicalizationVersion);
    expect(cols.runtimeToolchainId).toBe(BACKEND_CAPTURE.runtimeToolchainId);
    expect(cols.sourceToolchainId).toBe(SOURCE_TOOLCHAIN);
    expect(cols.policyVersionRowId).toBe(PV_ROW);
    expect(cols.functionName).toBe(FN);
    expect(cols.locale).toBe(LOCALE);
    // ★M1 语义：REPLAYABLE 不代表 M2 完整 capture——replayCaptureVersion 仍 null（两条独立轴）。
    expect(cols.replayCaptureVersion).toBeNull();
  });

  it('★freeze 选中 REPLAYABLE Execution 并冻结成 RegressionCase（#261 闭环核心）', async () => {
    await seedExecution('exec-p0a-ok-1', STATUS_REPLAYABLE, LOCALE);

    const result = await freezeFromExecutions({ policyId: POL, actorUserId: OWNER, ownerUserId: OWNER });

    // #261 前此处 frozen=0（gate 空集）；#261 后 frozen=1。修复价值的直接翻转证据。
    expect(result.frozen).toBe(1);
    expect(result.caseIds).toHaveLength(1);

    const rows = await db.select().from(regressionCases).where(eq(regressionCases.policyId, POL));
    expect(rows).toHaveLength(1);
    const c = rows[0];
    expect(c.sourceKind).toBe('execution');
    expect(c.sourceExecutionId).toBe('exec-p0a-ok-1');
    expect(c.caseHashVersion).toBe('case-hash/m1.1');
    expect(c.functionName).toBe(FN);
    expect(c.locale).toBe(LOCALE);
    expect(c.canonicalInputHash).toBe(BACKEND_CAPTURE.canonicalInputHash);
    expect(c.expectedOutputHash).toBe(BACKEND_CAPTURE.canonicalOutputHash);
    expect(c.baselineRuntimeToolchainId).toBe(BACKEND_CAPTURE.runtimeToolchainId);
    expect(c.sourceToolchainId).toBe(SOURCE_TOOLCHAIN);
    expect(c.sourceEnvelopeSha256).toBe('envelope-sha-p0a-1');
    expect(c.inputJson).toEqual({ name: 'Ada' }); // retention 开 → 明文冻结。
    expect(c.caseHash).toBeTruthy();
  });

  it('★单变量翻转对照：仅 replayabilityStatus=NON_REPLAYABLE 即被 gate 排除（隔离 #261 因果）', async () => {
    // 与上一用例**完全相同**的 input / canonical*Hash / traceHash / toolchain / locale，
    // 唯一差异是 replayabilityStatus。若 freeze 空集，因果只能归于 status（#261 前的硬写值）。
    await seedExecution('exec-p0a-non-1', STATUS_NON_REPLAYABLE, LOCALE);

    const result = await freezeFromExecutions({ policyId: POL, actorUserId: OWNER, ownerUserId: OWNER });

    expect(result.frozen).toBe(0);
    const rows = await db.select().from(regressionCases).where(eq(regressionCases.policyId, POL));
    expect(rows).toHaveLength(0);
  });

  it('★混合精确性：REPLAYABLE 与 NON_REPLAYABLE 并存时只冻 REPLAYABLE', async () => {
    // 用不同 locale 分组两行（避免 RegressionCase 唯一键 (pvRow,fn,locale,inputHash) 撞），
    // 而**不改** input/hash——保持除 status+locale 外一致。
    await seedExecution('exec-p0a-mix-ok', STATUS_REPLAYABLE, 'en-US');
    await seedExecution('exec-p0a-mix-non', STATUS_NON_REPLAYABLE, 'de-DE');

    const result = await freezeFromExecutions({ policyId: POL, actorUserId: OWNER, ownerUserId: OWNER });

    expect(result.frozen).toBe(1);
    const rows = await db
      .select()
      .from(regressionCases)
      .where(and(eq(regressionCases.policyId, POL), eq(regressionCases.sourceKind, 'execution')));
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceExecutionId).toBe('exec-p0a-mix-ok');
    expect(rows[0].locale).toBe('en-US');
  });
});

// ── 证据段 3：live-backend 端到端（默认 skip，需本地 aster-api，真调后端） ──
// 只有 P0A_LIVE_BACKEND=1 才跑。这段是「后端真产 REPLAYABLE」的**可执行**证据（非注释声明）：
// 真发 HMAC 签名请求打 aster-api，断言真返回 REPLAYABLE + traceHash，并重算 hash 契约。
describe.skipIf(process.env.P0A_LIVE_BACKEND !== '1')('P0-A live-backend 端到端（真调 aster-api）', () => {
  const BASE = process.env.ASTER_POLICY_API_INTERNAL_URL || 'http://localhost:8080';
  const HMAC_KEY = process.env.ASTER_PLAN_GATE_HMAC_KEY || '';
  const PATH = '/api/v1/policies/evaluate-source';

  function sha256Hex(s: string): string {
    return createHash('sha256').update(s, 'utf8').digest('hex');
  }
  function signHmac(key: string, msg: string): string {
    return createHmac('sha256', key).update(msg, 'utf8').digest('hex');
  }

  it('★真调后端返回 REPLAYABLE + traceHash，且 hash 契约成立', async () => {
    expect(HMAC_KEY, 'ASTER_PLAN_GATE_HMAC_KEY 必须与 aster-api 一致').not.toBe('');
    const tenant = 'tenant-e2e';
    const role = 'admin';
    const bodyObj = {
      source: 'Module aster.test.\nRule greet given name as Text:\n  Return name.',
      context: { name: 'Ada' },
      locale: 'en-US',
      functionName: 'greet',
    };
    const body = JSON.stringify(bodyObj);
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'p0a-live-' + randomUUID();
    // canonical = method\npath\nts\nnonce\nsha256Hex(body)\ntenant\nrole（InternalCallerFilter 7 行）。
    const canonical = `POST\n${PATH}\n${ts}\n${nonce}\n${sha256Hex(body)}\n${tenant}\n${role}`;
    const sig = signHmac(HMAC_KEY, canonical);

    const resp = await fetch(`${BASE}${PATH}?replayCapture=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Caller': 'cloud-bff',
        'X-Aster-Timestamp': String(ts),
        'X-Aster-Nonce': nonce,
        'X-Internal-Signature': sig,
        'X-Tenant-Id': tenant,
        'X-User-Role': role,
      },
      body,
    });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { replayMetadata?: PolicyReplayMetadata & {
      canonicalInput?: string; canonicalOutput?: string; canonicalTrace?: string;
    } };
    const rm = json.replayMetadata;
    expect(rm, '后端应返回 replayMetadata（HMAC 内部调用 + replayCapture=true）').toBeTruthy();
    expect(rm!.replayabilityStatus).toBe('REPLAYABLE');
    expect(rm!.traceHash).toBeTruthy();
    // 重算 hash 契约（后端权威 payload → 本地 sha256 == 后端 hash）。
    const v = rm!.canonicalizationVersion!;
    expect(canonicalHashOf(v, rm!.canonicalInput!)).toBe(rm!.canonicalInputHash);
    expect(canonicalHashOf(v, rm!.canonicalOutput!)).toBe(rm!.canonicalOutputHash);
    expect(canonicalHashOf(v, rm!.canonicalTrace!)).toBe(rm!.traceHash);
  });
});
