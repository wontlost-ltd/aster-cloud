// ADR 0060 §7.2–7.3 / 计划 T10：版本内嵌词汇经 execution-input 进入每条读路径（真实 Postgres）。
// 《静夜思》版本（zh-CN + 四个结构词别名 + 两条内嵌词条）保存后，作者又新增了同形个人词条 望明月 → Moon：
// - 草稿执行词汇含内嵌词条，且内嵌优先；
// - 审批冻结按「冻结下层 + 内嵌」复核封印，照常批准；之后执行仍得 Text / 静夜思；
// - 直接改库里的内嵌列：审批拒绝（vocabulary_changed_since_save），已审批版本执行拒绝（vocabulary_seal_mismatch）；
// - Cedar / 包导出、Guard 部署载荷、内部 What-If 回源、resolver 迁移拿到的都是合并后的词汇。
// aster-api 编译调用替换为记录请求的桩，不访问网络。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts execution-input-embedded

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/cache', () => ({ invalidatePolicyCache: vi.fn(async () => undefined) }));
vi.mock('@/lib/metrics/aha-detection', () => ({ recordAhaMomentIfFirst: vi.fn(async () => false) }));
vi.mock('@/lib/internal-signature', () => ({ verifyInternalSignature: vi.fn(async () => ({ ok: true })) }));

const compileCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@/services/policy/policy-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/policy/policy-api')>();
  return {
    ...actual,
    createPolicyApiClient: () => ({
      compile: async (request: Record<string, unknown>) => {
        compileCalls.push(request);
        return { success: true, diagnostics: [] };
      },
    }),
  };
});

import type { DomainVocabulary } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
import { createDb } from '@/db';
import {
  domainTerms,
  policies,
  policyApprovals,
  policyVersions,
  securityEvents,
  userDomainTerms,
  users,
  userVocabularySnapshots,
} from '@/lib/prisma';
import { approveVersion, VocabularyChangedSinceSaveError } from '@/services/policy/version-manager';
import {
  loadStoredVersionCompileContext,
  loadVersionExecutionVocabulary,
  VocabularySealMismatchError,
} from '@/lib/execution-input';
import { loadLiveVocabularyForPolicy } from '@/lib/domain-vocabulary-snapshot';
import { cloudToolchainId, computeSourceEnvelope, vocabularyScopesJson } from '@/lib/policy-alias';
import { withEmbeddedVocabulary } from '@/lib/policy-embedded-vocabulary';
import { findDefaultExecutableVersion } from '@/services/policy/default-executable-version';
import { loadCedarExportInput } from '@/lib/cedar-export-input';
import { loadPackageExportInput } from '@/lib/package-export-input';
import { buildDeploymentPayload } from '@/lib/guard-policy-deploy';
import { migrateVersion } from '@/services/policy/resolver-migration';
import { GET as internalVersionSource } from '@/app/api/internal/policy-versions/route';

const USER = 'user-embedded-vocab-it';
const POLICY = 'pol-embedded-vocab-it';
const LOCALE = 'zh-CN';
/** ADR §8：源码与演示 POEM_ZH.source 逐字节相同。 */
const SOURCE = '床前 明月光。\n疑是 地上霜，举头 望明月：\n  低头 思故乡。';
const ALIAS_SET = '{"FUNC_PRODUCE":["举头"],"FUNC_TO":["疑是"],"MODULE_DECL":["床前"],"RETURN":["低头"]}';
/** 同一首诗的规范关键词写法：Guard 部署不支持结构词别名（ADR 0060 §10 第 4 条），部署载荷用它验证。 */
const CANONICAL_SOURCE = '模块 明月光。\n规则 地上霜，产出 望明月：\n  返回 思故乡。';
const EMBEDDED = '{"v":1,"terms":[{"kind":"literal","localized":"思故乡","canonical":"静夜思"},{"kind":"struct","localized":"望明月","canonical":"Text"}]}';

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

const versionId = (n: number) => `${POLICY}-v${n}`;

async function cleanup(db: Db): Promise<void> {
  await db.delete(policyApprovals).where(sql`${policyApprovals.versionId} LIKE ${`${POLICY}%`}`);
  await db.delete(securityEvents).where(eq(securityEvents.policyId, POLICY));
  await db.delete(policyVersions).where(eq(policyVersions.policyId, POLICY));
  await db.delete(policies).where(eq(policies.id, POLICY));
  await db.delete(userVocabularySnapshots).where(eq(userVocabularySnapshots.ownerId, USER));
  await db.delete(userDomainTerms).where(eq(userDomainTerms.userId, USER));
  await db.delete(domainTerms).where(sql`${domainTerms.id} LIKE 'dt-embedded-vocab-it-%'`);
  await db.delete(users).where(eq(users.id, USER));
}

/** 作者个人词条 望明月 → Moon（与内嵌 struct 同形、规范名不同）。 */
async function addCollidingAuthorTerm(db: Db): Promise<void> {
  await db.insert(domainTerms).values({
    id: 'dt-embedded-vocab-it-moon', domain: 'poem', locale: 'zh', kind: 'struct',
    canonical: 'Moon', canonicalNorm: 'moon', localized: '望明月', localizedNorm: '望明月',
    parentCanonical: null, source: 'user', dedupKey: 'embedded-vocab-it-moon',
  } as typeof domainTerms.$inferInsert);
  await db.insert(userDomainTerms).values({
    id: 'udt-embedded-vocab-it-moon', userId: USER, termId: 'dt-embedded-vocab-it-moon', domain: 'poem', locale: 'zh', kind: 'struct',
  } as typeof userDomainTerms.$inferInsert);
}

/** 与 createVersion 同一封印口径：作者现行词汇并入内嵌词汇后的词汇段，进 5 段 envelope。 */
async function insertSealedVersion(
  db: Db,
  version: number,
  status: 'PENDING_APPROVAL' | 'DRAFT' | 'APPROVED',
  { source = SOURCE, aliasSet = ALIAS_SET }: { source?: string; aliasSet?: string | null } = {},
): Promise<string> {
  const lower = await loadLiveVocabularyForPolicy(USER, { source, locale: LOCALE });
  const scopes = vocabularyScopesJson(withEmbeddedVocabulary(lower, EMBEDDED, LOCALE));
  const toolchain = cloudToolchainId();
  await db.insert(policyVersions).values({
    id: versionId(version), policyId: POLICY, version, content: source, source, status, createdBy: USER,
    aliasSet, embeddedVocabulary: EMBEDDED, resolverVersion: 1,
    sourceScopesJson: scopes, sourceToolchainId: toolchain,
    sourceEnvelopeSha256: computeSourceEnvelope(source, aliasSet, LOCALE, toolchain, scopes),
  });
  return scopes;
}

async function versionRow(db: Db, version: number) {
  const [row] = await db.select().from(policyVersions).where(eq(policyVersions.id, versionId(version)));
  return row!;
}

const targetOf = (row: Awaited<ReturnType<typeof versionRow>>) => ({
  status: row.status,
  vocabularySnapshotIds: row.vocabularySnapshotIds,
  authorId: row.createdBy,
  source: row.content,
  locale: LOCALE,
  embeddedVocabulary: row.embeddedVocabulary,
  sourceScopesJson: row.sourceScopesJson,
});

const asVocab = (v: unknown) => v as DomainVocabulary;
const literalTriggers = (v: unknown) => (asVocab(v)?.literals ?? []).map((m) => `${m.localized}→${m.canonical}`);
const structMappings = (v: unknown) => (asVocab(v)?.structs ?? []).map((m) => `${m.localized}→${m.canonical}`);

describe.skipIf(process.env.LICENSE_E2E !== '1')('版本内嵌词汇的读路径（真实 Postgres）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db = createDb(undefined, { max: 4 });
  let sealV1 = '';

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
    process.env.ASTER_PLAN_GATE_HMAC_KEY = process.env.ASTER_PLAN_GATE_HMAC_KEY ?? 'embedded-vocab-it';
    await cleanup(db);
    await db.insert(users).values({ id: USER, email: `${USER}@example.test`, updatedAt: new Date() } as typeof users.$inferInsert);
    await db.insert(policies).values({
      id: POLICY, userId: USER, name: 'embedded-vocab-it', content: SOURCE, version: 1, updatedAt: new Date(),
    } as typeof policies.$inferInsert);
    // 保存时作者没有作用域内的词条：封印 = 内嵌词汇本身
    sealV1 = await insertSealedVersion(db, 1, 'PENDING_APPROVAL');
    await insertSealedVersion(db, 3, 'PENDING_APPROVAL');
    // 保存之后、审批之前，作者新增同形个人词条
    await addCollidingAuthorTerm(db);
    await insertSealedVersion(db, 2, 'DRAFT');
    await insertSealedVersion(db, 4, 'APPROVED', { source: CANONICAL_SOURCE, aliasSet: null });
  });

  afterAll(async () => {
    await cleanup(db);
    globalForDb.__asterLocalDevDb = previous;
    await db.$client.end({ timeout: 1 });
  });

  it('the seal of the poem version equals the envelope.literal-macro vector scopesJson', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const vectors = JSON.parse(readFileSync(join(__dirname, '..', '..', 'lib', '__fixtures__', 'envelope-vectors.json'), 'utf8')) as Array<{
      vocabulary: { id: string } | null; scopesJson: string;
    }>;
    expect(sealV1).toBe(vectors.find((v) => v.vocabulary?.id === 'envelope.literal-macro')!.scopesJson);
  });

  it('execution vocabulary of a draft includes embedded terms (and the colliding author term is shadowed)', async () => {
    const live = await loadLiveVocabularyForPolicy(USER, { source: SOURCE, locale: LOCALE });
    expect(structMappings(live)).toEqual(['望明月→Moon']);
    const vocabulary = await loadVersionExecutionVocabulary(targetOf(await versionRow(db, 2)));
    expect(literalTriggers(vocabulary)).toEqual(['思故乡→静夜思']);
    expect(structMappings(vocabulary)).toEqual(['望明月→Text']);
  });

  it('approval freeze compares frozen lower vocabulary plus embedded with the seal: equal → approved', async () => {
    await approveVersion({ policyId: POLICY, version: 1, approverId: USER, decision: 'APPROVED' });
    const v1 = await versionRow(db, 1);
    expect(v1.status).toBe('APPROVED');
    // 冻结的是下层（含被遮蔽的 Moon）词汇，内嵌词汇不进快照
    expect(v1.vocabularySnapshotIds.map((r) => `${r.domain}|${r.locale}`)).toEqual(['poem|zh']);
    expect(v1.sourceScopesJson).toBe(sealV1);
  });

  it('approved version executes with embedded vocabulary after the author adds a colliding term', async () => {
    const vocabulary = await loadVersionExecutionVocabulary(targetOf(await versionRow(db, 1)));
    expect(literalTriggers(vocabulary)).toEqual(['思故乡→静夜思']);
    expect(structMappings(vocabulary)).toEqual(['望明月→Text']);
    expect(vocabularyScopesJson(asVocab(vocabulary))).toBe(sealV1);
  });

  it('package export, cedar export, guard deploy and the internal What-If source receive the merged vocabulary', async () => {
    // 导出选默认的已批准版本：让诗（v1，带结构词别名）成为默认
    await db.update(policyVersions).set({ isDefault: true }).where(eq(policyVersions.id, versionId(1)));
    const version = await findDefaultExecutableVersion(POLICY);
    expect(version?.id).toBe(versionId(1));

    const cedar = await loadCedarExportInput(version!, null);
    expect(literalTriggers(cedar.request.vocabulary)).toEqual(['思故乡→静夜思']);
    expect(structMappings(cedar.request.vocabulary)).toEqual(['望明月→Text']);

    const pkg = await loadPackageExportInput({ id: POLICY, teamId: null }, version!);
    expect(literalTriggers(pkg.request.vocabulary)).toEqual(['思故乡→静夜思']);

    const payload = await buildDeploymentPayload(versionId(4));
    expect(literalTriggers(payload.vocabulary)).toEqual(['思故乡→静夜思']);
    expect(structMappings(payload.vocabulary)).toEqual(['望明月→Text']);
    expect(payload.functionName).toBe('地上霜');

    const res = await internalVersionSource(new Request(
      `https://cloud.test/api/internal/policy-versions?versionId=${versionId(1)}&userId=${USER}`,
    ));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(literalTriggers(body.vocabulary)).toEqual(['思故乡→静夜思']);
    expect(body.aliasSet).toEqual(JSON.parse(ALIAS_SET));
  });

  it('rejects execution when the embedded column no longer matches the seal', async () => {
    const tampered = EMBEDDED.replace('静夜思', '静夜诗');
    await db.update(policyVersions).set({ embeddedVocabulary: tampered }).where(eq(policyVersions.id, versionId(1)));
    try {
      const row = await versionRow(db, 1);
      await expect(loadVersionExecutionVocabulary(targetOf(row))).rejects.toBeInstanceOf(VocabularySealMismatchError);
      await expect(loadStoredVersionCompileContext({ ...row, source: row.content, teamId: null }))
        .rejects.toBeInstanceOf(VocabularySealMismatchError);
      const res = await internalVersionSource(new Request(
        `https://cloud.test/api/internal/policy-versions?versionId=${versionId(1)}&userId=${USER}`,
      ));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'vocabulary_seal_mismatch' });
    } finally {
      await db.update(policyVersions).set({ embeddedVocabulary: EMBEDDED }).where(eq(policyVersions.id, versionId(1)));
    }
  });

  it('approval rejects a version whose embedded column was changed directly in the database', async () => {
    await db.update(policyVersions)
      .set({ embeddedVocabulary: EMBEDDED.replace('Text', 'Moon') })
      .where(eq(policyVersions.id, versionId(3)));

    await expect(approveVersion({ policyId: POLICY, version: 3, approverId: USER, decision: 'APPROVED' }))
      .rejects.toBeInstanceOf(VocabularyChangedSinceSaveError);
    const v3 = await versionRow(db, 3);
    expect(v3.status).toBe('PENDING_APPROVAL');
    expect(v3.vocabularySnapshotIds).toEqual([]);
  });

  it('resolver migration compiles with embedded terms', async () => {
    await db.update(policyVersions).set({ resolverVersion: null }).where(eq(policyVersions.id, versionId(2)));
    compileCalls.length = 0;

    const result = await migrateVersion(versionId(2));

    expect(result).toEqual({ id: versionId(2), status: 'SUCCEEDED' });
    expect(compileCalls).toHaveLength(1);
    expect(literalTriggers(compileCalls[0]!.vocabulary)).toEqual(['思故乡→静夜思']);
    expect(structMappings(compileCalls[0]!.vocabulary)).toEqual(['望明月→Text']);
    const v2 = await versionRow(db, 2);
    expect(v2.resolverVersion).toBe(1);
    expect(v2.sourceScopesJson).toBe(sealV1);
  });
});
