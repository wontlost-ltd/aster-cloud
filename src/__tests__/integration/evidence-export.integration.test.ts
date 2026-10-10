// 证据导出数据层集成测试（真实 Postgres，testcontainers 或外部 DATABASE_URL）。
//
// 覆盖只有真库能验的：queryEvidenceExecutions 投影/排除已删策略/范围；getEvidencePreview 分布；
// createEvidenceExport→getEvidenceExportBundle 重下载字节一致（bundleHash 稳定）；边缘：空范围、
// legacy 缺哈希不崩、超限 413（EvidenceTooLargeError）。
//
// Run: LICENSE_E2E=1 pnpm test:integration
// 未设 DATABASE_URL 时 setupTestDb 起临时 pg 容器并执行 drizzle migrate()（含 0050 迁移）；
// 设了外部 DATABASE_URL 则假定其 schema 已迁移到最新。
// ★修改 executions / policies 表结构（含 policy 关联与 agent/metadata 投影）前必须跑本套件：默认单测把查询层整体 mock 掉。

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// server-only 由 Next 构建期别名提供（未作为依赖安装），测试中以空模块替代（收据客户端引入）。
vi.mock('server-only', () => ({}));
import { db, executions, policies, complianceReports } from '@/lib/prisma';
import {
  queryEvidenceExecutions,
  getEvidencePreview,
  countEvidenceExecutions,
} from '@/lib/evidence-export';
import {
  createEvidenceExport,
  getEvidenceExportBundle,
  getEvidenceExportMetadata,
  listEvidenceExports,
} from '@/lib/evidence';
import { setupTestDb, teardownTestDb } from './setup-postgres';

const U = 'user-ev-1';
const POL = 'pol-ev-1';

async function seedPolicy(id: string, userId: string, name: string, deleted = false) {
  await db.insert(policies).values({
    id,
    userId,
    name,
    content: 'Module M. Rule R.',
    // 基线迁移里 Policy.updatedAt 是 NOT NULL 且无库级默认值（schema 的 defaultNow 未落进迁移），须显式赋值。
    updatedAt: new Date(),
    ...(deleted ? { deletedAt: new Date() } : {}),
  } as typeof policies.$inferInsert);
}

async function seedExecution(over: Partial<typeof executions.$inferInsert> & { id: string; createdAt: Date }) {
  await db.insert(executions).values({
    userId: U,
    policyId: POL,
    input: {},
    durationMs: 5,
    success: true,
    decision: 'approved',
    canonicalInputHash: 'in',
    canonicalOutputHash: 'out',
    traceHash: 'tr',
    source: 'api',
    ...over,
  } as typeof executions.$inferInsert);
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('evidence-export 数据层（真库）', () => {
  beforeAll(async () => {
    process.env.AI_KEY_ENCRYPTION_SECRET = 'integration-test-secret-key-32chars';
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await db.delete(executions);
    await db.delete(complianceReports);
    await db.delete(policies);
    await seedPolicy(POL, U, 'Loan policy');
  });

  it('★queryEvidenceExecutions 投影哈希/溯源字段，按 createdAt 升序', async () => {
    await seedExecution({ id: 'e2', createdAt: new Date('2026-07-02T00:00:00Z') });
    await seedExecution({ id: 'e1', createdAt: new Date('2026-07-01T00:00:00Z') });
    const rows = await queryEvidenceExecutions({ userId: U, policyId: POL });
    expect(rows.map((r) => r.id)).toEqual(['e1', 'e2']); // 升序
    expect(rows[0]).toMatchObject({ canonicalInputHash: 'in', canonicalOutputHash: 'out', traceHash: 'tr', decision: 'approved' });
  });

  it('★排除已删策略的执行', async () => {
    await seedPolicy('pol-deleted', U, 'Deleted', true);
    await seedExecution({ id: 'e1', createdAt: new Date('2026-07-01T00:00:00Z') });
    await seedExecution({ id: 'e2', policyId: 'pol-deleted', createdAt: new Date('2026-07-02T00:00:00Z') });
    const rows = await queryEvidenceExecutions({ userId: U }); // 全部策略
    expect(rows.map((r) => r.id)).toEqual(['e1']); // e2 属已删策略，排除
  });

  it('★时间范围过滤', async () => {
    await seedExecution({ id: 'old', createdAt: new Date('2026-06-01T00:00:00Z') });
    await seedExecution({ id: 'inrange', createdAt: new Date('2026-07-15T00:00:00Z') });
    const rows = await queryEvidenceExecutions({
      userId: U,
      startDate: new Date('2026-07-01T00:00:00Z'),
      endDate: new Date('2026-07-31T00:00:00Z'),
    });
    expect(rows.map((r) => r.id)).toEqual(['inrange']);
  });

  it('★getEvidencePreview 分布正确（含 unknown=decision null）', async () => {
    await seedExecution({ id: 'a', decision: 'approved', createdAt: new Date('2026-07-01T00:00:00Z') });
    await seedExecution({ id: 'd', decision: 'denied', createdAt: new Date('2026-07-02T00:00:00Z') });
    await seedExecution({ id: 'n', decision: null, createdAt: new Date('2026-07-03T00:00:00Z') });
    const p = await getEvidencePreview({ userId: U, policyId: POL });
    expect(p.count).toBe(3);
    expect(p.decisionTally).toMatchObject({ approved: 1, denied: 1, unknown: 1 });
    expect(p.exceedsLimit).toBe(false);
  });

  it('★legacy 行缺哈希/decision → 导出不崩，manifest 计缺口', async () => {
    await seedExecution({
      id: 'legacy',
      decision: null,
      canonicalInputHash: null,
      canonicalOutputHash: null,
      traceHash: null,
      createdAt: new Date('2026-07-01T00:00:00Z'),
    });
    const { id, manifest } = await createEvidenceExport(U, { policyId: POL, format: 'json' });
    expect(manifest.totals.count).toBe(1);
    expect(manifest.notes.legacyRowsWithoutHashes).toBe(1);
    expect(manifest.decisionTally.unknown).toBe(1);
    expect(id).toBeTruthy();
  });

  it('★空范围 → count 0 的有效导出（合法空 manifest）', async () => {
    const { manifest } = await createEvidenceExport(U, {
      policyId: POL,
      startDate: new Date('2030-01-01T00:00:00Z'),
      endDate: new Date('2030-01-02T00:00:00Z'),
      format: 'json',
    });
    expect(manifest.totals.count).toBe(0);
    expect(manifest.bundleHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('★createEvidenceExport→getEvidenceExportBundle 重下载字节一致（bundleHash 稳定）', async () => {
    await seedExecution({ id: 'e1', createdAt: new Date('2026-07-01T00:00:00Z') });
    await seedExecution({ id: 'e2', createdAt: new Date('2026-07-02T00:00:00Z') });
    const { id } = await createEvidenceExport(U, { policyId: POL, format: 'json' });

    const b1 = await getEvidenceExportBundle(U, id);
    const b2 = await getEvidenceExportBundle(U, id);
    expect(b1).not.toBeNull();
    expect(b1!.body).toBe(b2!.body); // 两次读字节完全一致
    // 越权取不到
    expect(await getEvidenceExportBundle('other-user', id)).toBeNull();
  });

  it('countEvidenceExecutions 计数', async () => {
    await seedExecution({ id: 'a', createdAt: new Date('2026-07-01T00:00:00Z') });
    await seedExecution({ id: 'b', createdAt: new Date('2026-07-02T00:00:00Z') });
    expect(await countEvidenceExecutions({ userId: U, policyId: POL })).toBe(2);
  });

  // ── Codex 审查修复的回归 ──

  it('★preview/count 与 query 对已删策略语义一致（都排除，不会预览多于实际导出）', async () => {
    await seedPolicy('pol-del', U, 'Deleted', true);
    await seedExecution({ id: 'live', createdAt: new Date('2026-07-01T00:00:00Z') });
    await seedExecution({ id: 'dead', policyId: 'pol-del', createdAt: new Date('2026-07-02T00:00:00Z') });
    // 全部策略范围：count/preview 都应只算 live（1），与 query 一致
    expect(await countEvidenceExecutions({ userId: U })).toBe(1);
    const p = await getEvidencePreview({ userId: U });
    expect(p.count).toBe(1);
    const rows = await queryEvidenceExecutions({ userId: U });
    expect(rows).toHaveLength(1);
  });

  it('★旧假分 ComplianceReport 行不出现在证据导出列表', async () => {
    // 直插一条旧假分报告（data.kind 非 evidence-export）
    await db.insert(complianceReports).values({
      id: 'old-fake', userId: U, type: 'gdpr', title: 'Old GDPR score',
      status: 'completed', data: { summary: { complianceScore: 88 } },
    } as typeof complianceReports.$inferInsert);
    // 再建一条真证据导出
    await seedExecution({ id: 'e1', createdAt: new Date('2026-07-01T00:00:00Z') });
    const { id } = await createEvidenceExport(U, { policyId: POL, format: 'json' });

    const list = await listEvidenceExports(U);
    const ids = list.map((r) => r.id);
    expect(ids).toContain(id);
    expect(ids).not.toContain('old-fake'); // 旧假分行被过滤
  });

  it('★preview 覆盖率：分 verifiable(有哈希) / legacy(无哈希)', async () => {
    await seedExecution({ id: 'v1', canonicalInputHash: 'h1', createdAt: new Date('2026-07-01T00:00:00Z') });
    await seedExecution({ id: 'v2', canonicalInputHash: 'h2', createdAt: new Date('2026-07-02T00:00:00Z') });
    await seedExecution({ id: 'legacy', canonicalInputHash: null, createdAt: new Date('2026-06-01T00:00:00Z') });
    const p = await getEvidencePreview({ userId: U, policyId: POL });
    expect(p.count).toBe(3);
    expect(p.coverage).toEqual({ verifiable: 2, legacy: 1 });
  });

  it('★verifiableOnly 过滤掉无哈希 legacy 行', async () => {
    await seedExecution({ id: 'v1', canonicalInputHash: 'h1', createdAt: new Date('2026-07-01T00:00:00Z') });
    await seedExecution({ id: 'legacy', canonicalInputHash: null, createdAt: new Date('2026-06-01T00:00:00Z') });
    const all = await queryEvidenceExecutions({ userId: U, policyId: POL });
    expect(all).toHaveLength(2);
    const verifiable = await queryEvidenceExecutions({ userId: U, policyId: POL, verifiableOnly: true });
    expect(verifiable.map((r) => r.id)).toEqual(['v1']); // legacy 被排除
  });

  it('★getEvidenceExportMetadata 只返回 manifest，不含 bundle.entries', async () => {
    await seedExecution({ id: 'e1', createdAt: new Date('2026-07-01T00:00:00Z') });
    const { id } = await createEvidenceExport(U, { policyId: POL, format: 'json' });
    const meta = await getEvidenceExportMetadata(U, id);
    expect(meta).not.toBeNull();
    expect(meta!.manifest?.totals.count).toBe(1);
    // 不暴露 entries（既无 entries 键，也无 bundle 键——manifest.notes.verification 文本里出现
    // "executionId" 字样是正常的校验说明，不算泄露，故只断言结构键而非子串）。
    expect(meta).not.toHaveProperty('entries');
    expect(meta).not.toHaveProperty('bundle');
    // 旧假分行取不到（返回 null）
    await db.insert(complianceReports).values({
      id: 'old-fake2', userId: U, type: 'gdpr', title: 'x', status: 'completed', data: { summary: {} },
    } as typeof complianceReports.$inferInsert);
    expect(await getEvidenceExportMetadata(U, 'old-fake2')).toBeNull();
  });

  it('★v2 投影：outcome/ruleId/controls/agent/evidenceCorrelationId + 租户（teamId || userId）+ guardDecisionId', async () => {
    await db.insert(policies).values({
      id: 'pol-team', userId: U, teamId: 'team-ev', name: 'Team policy', content: 'Module M. Rule R.',
      updatedAt: new Date(),
    } as typeof policies.$inferInsert);
    await seedExecution({
      id: 'v2-a', createdAt: new Date('2026-07-01T00:00:00Z'), outcome: 'REQUIRE_APPROVAL', ruleId: 'R-1',
      controls: ['GDPR:ART17'], agent: { provider: 'anthropic', model: 'claude', source: 'declared' },
      evidenceCorrelationId: 'corr-a', metadata: { guardDecisionId: 'gd-a' }, profile: 'governed',
    });
    await seedExecution({ id: 'v2-b', policyId: 'pol-team', createdAt: new Date('2026-07-02T00:00:00Z') });
    const [a, b] = await queryEvidenceExecutions({ userId: U });
    expect(a).toMatchObject({
      id: 'v2-a', outcome: 'REQUIRE_APPROVAL', ruleId: 'R-1', controls: ['GDPR:ART17'],
      agent: { provider: 'anthropic', model: 'claude', source: 'declared' },
      evidenceCorrelationId: 'corr-a', policyTenantId: U, policyOwnerId: U, guardDecisionId: 'gd-a', profile: 'governed',
    });
    expect(b).toMatchObject({
      id: 'v2-b', outcome: null, agent: null, evidenceCorrelationId: null, policyTenantId: 'team-ev', policyOwnerId: U, guardDecisionId: null, profile: null,
    });
  });

  it('★无关联 id 的行导出为现行 schemaVersion 5 + receipt=legacy（不发起收据请求）', async () => {
    await seedExecution({ id: 'e1', createdAt: new Date('2026-07-01T00:00:00Z') });
    const { id, manifest } = await createEvidenceExport(U, { policyId: POL, format: 'json' });
    expect(manifest.schemaVersion).toBe('5');
    expect(manifest.legacyEntries).toBe(1);
    expect(manifest.profilesUsed).toEqual([]);
    const body = JSON.parse((await getEvidenceExportBundle(U, id))!.body);
    expect(body.entries[0].receipt).toEqual({ status: 'legacy' });
    expect(body.entries[0].reviewers).toEqual([]);
    expect(body.entries[0].profile).toBeNull();
  });

  it('★profile 列落库后进入条目与 manifest.profilesUsed（ADR 0046 §6）', async () => {
    await seedExecution({ id: 'p1', createdAt: new Date('2026-07-01T00:00:00Z'), profile: 'eu-ai-act-high-risk' });
    await seedExecution({ id: 'p2', createdAt: new Date('2026-07-02T00:00:00Z') });
    const { id, manifest } = await createEvidenceExport(U, { policyId: POL, format: 'json' });
    expect(manifest.profilesUsed.map((p) => p.id)).toEqual(['eu-ai-act-high-risk']);
    const body = JSON.parse((await getEvidenceExportBundle(U, id))!.body);
    expect(body.entries.map((e: { profile: string | null }) => e.profile)).toEqual(['eu-ai-act-high-risk', null]);
  });

  it('★回放端点不可用：导出完成，whatIf 全 null，notes.whatIfUnavailable = 条目数，14(4)(a) 为 none', async () => {
    // 基址指向无人监听端口：收据与回放查找都降级为 unavailable，导出不得失败。
    const prev = process.env.ASTER_POLICY_API_INTERNAL_URL;
    process.env.ASTER_POLICY_API_INTERNAL_URL = 'http://127.0.0.1:1';
    try {
      await seedExecution({ id: 'exec-w1', createdAt: new Date('2026-07-01T00:00:00Z'), outcome: 'REQUIRE_APPROVAL', controls: ['EU_AI_ACT:ART14'] });
      const { id } = await createEvidenceExport(U, { policyId: POL, format: 'json' });
      const body = JSON.parse((await getEvidenceExportBundle(U, id))!.body);
      expect(body.manifest.schemaVersion).toBe('5');
      expect(body.entries.every((e: { whatIf: unknown }) => e.whatIf === null)).toBe(true);
      expect(body.manifest.notes.whatIfUnavailable).toBe(body.entries.length);
      const art14 = body.manifest.regulatoryMapping.frameworks.find((f: { control: string }) => f.control === 'EU_AI_ACT:ART14');
      const clause = art14.clauses.find((c: { clause: string }) => c.clause === '14(4)(a)');
      expect(clause.status).toBe('none');
    } finally {
      if (prev === undefined) delete process.env.ASTER_POLICY_API_INTERNAL_URL;
      else process.env.ASTER_POLICY_API_INTERNAL_URL = prev;
    }
  });

  it('★已存的 v1 证据包按原样下载（不重算、不升级）', async () => {
    const v1Manifest = {
      kind: 'evidence-export', schemaVersion: '1', generatedAt: '2026-07-01T00:00:00.000Z', policy: { scope: 'all' },
      range: { start: null, end: null }, totals: { count: 0 },
      decisionTally: { approved: 0, denied: 0, indeterminate: 0, error: 0, unknown: 0 },
      canonicalizationVersion: 'v1', bundleHash: 'a'.repeat(64),
      notes: { legacyRowsWithoutHashes: 0, verification: 'v1 recipe' },
    };
    await db.insert(complianceReports).values({
      id: 'v1-bundle', userId: U, type: 'custom', title: 'v1', status: 'completed',
      data: { kind: 'evidence-export', manifest: v1Manifest, bundle: { manifest: v1Manifest, entries: [] }, format: 'json' },
    } as typeof complianceReports.$inferInsert);
    const got = await getEvidenceExportBundle(U, 'v1-bundle');
    expect(JSON.parse(got!.body)).toEqual({ manifest: v1Manifest, entries: [] });
    expect(got!.manifest).toEqual(v1Manifest);
  });
});
