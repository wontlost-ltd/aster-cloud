/**
 * 存量重编译（ADR 0051 §9，cloud "PolicyVersion"）：把迁移前的版本按「按位置解析」的新规则经 aster-api
 * 签名编译接口重新编译，并用当前工具链重新封印。与 aster-api 的 ResolverMigrationService 同一状态机：
 *
 * - 扫描 resolverVersion IS DISTINCT FROM 1 的行，按主键升序、每批 50，游标推进（同一次运行里每行只尝试一次）；
 *   每行一个事务，SELECT … FOR UPDATE 锁行后复查，并发或中断后重跑都收敛到同一结果。
 * - 编译前先按旧封印核对完整性（有 envelope 按其格式反推编译 locale，无 envelope 比对链式 sourceHash）；
 *   不符只记 "pre-migration integrity mismatch"，不封印、不改链、不归档，留给人工处理。
 * - 成功：用当前 cloudToolchainId 重算 5 段 envelope，同一事务回填 sourceScopesJson（词汇与执行同一选择规则），
 *   resolverVersion=1、清空错误；仅本任务归档过的行恢复 statusBeforeArchive。
 * - 名称解析失败（编译错误诊断、作者词汇无法构成作用域）：旧 envelope / 工具链 / 词汇段不动，记错误；
 *   当前非 ARCHIVED 才记下原状态并归档、置标记；已归档（无论来源）只更新错误。resolverVersion 保持 NULL。
 * - 基础设施故障（编译服务不可用、词汇加载失败、DB 错误）：事务回滚，行不变，只在报告里列出，重跑再试。
 *
 * 哈希链：prevHash = 前驱链接（envelope ?? sourceHash），sourceHash = H(source + prevHash)。成功行链接变了，
 * 就在同一事务里把直接后继的 prevHash 从旧链接改成新链接（比较后才写：迁移前已断的链保持断开），
 * 后继 sourceHash 原本自洽时随之重算；后继没有 envelope 时其链接就是 sourceHash，于是继续向后改写。
 */

import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { RESOLVER_VERSION } from '@aster-cloud/aster-lang-ts/browser';
import type { DomainVocabulary } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
import { db, policies, policyVersions } from '@/lib/prisma';
import { invalidatePolicyCache } from '@/lib/cache';
import { cloudToolchainId, computeSourceEnvelope, vocabularyScopesJson } from '@/lib/policy-alias';
import { recordedCompileLocale, resolveStoredVersionLocale } from '@/lib/policy-version-locale';
import { executionVocabularySource } from '@/lib/execution-input';
import {
  loadLiveVocabularyForPolicy,
  loadVocabularyForExecution,
  type SnapshotRef,
} from '@/lib/domain-vocabulary-snapshot';
import type { PolicyVocabularyContext } from '@/lib/domain-vocabulary-scope';
import { makeCompileValidator } from '@/lib/policy-compile-validator';
import { policyTenantId } from '@/lib/policy-tenant';
import { vocabularyScopeErrorDetails } from '@/lib/vocabulary-scope-error';
import { computeChainedHash } from '@/services/security/policy-security';
import {
  PolicyCompileError,
  PolicyCompileUnavailableError,
  type CompileDiagnostic,
} from '@/services/policy/version-manager';

/** 每批读取的主键数（ADR 0051 §9）。 */
export const RESOLVER_MIGRATION_BATCH_SIZE = 50;

/** 旧封印（envelope 或链式 sourceHash）与当前字段不符时记录的错误。 */
export const INTEGRITY_MISMATCH_ERROR = 'pre-migration integrity mismatch';

const MAX_ERROR_LENGTH = 4000;

/**
 * 无效构造写法 `X mit f = v`（aster-lang-ts#244）的启发式：P005 且源码里有「构造关键词 + 字段 + 单个 =」。
 * 关键词取各语言词表的 TYPE_WITH（with / mit / 包含 / सहित）。只用于分诊归类，不影响迁移结果。
 */
const INVALID_CONSTRUCT_FORM = /(?:\bwith|\bmit|包含|सहित)\s*[\p{L}_][\p{L}\p{N}_]*\s*=(?!=)/u;

type VersionRow = typeof policyVersions.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type FailureCategory = 'compile' | 'vocabulary' | 'integrity' | 'infrastructure';

/** 一行失败的明细；vocabulary 类带出错词条（reason/term/kind），compile 类带诊断码。 */
export interface MigrationFailure {
  id: string;
  policyId: string | null;
  version: number | null;
  /** 版本作者，缺失时为策略所有者；分诊按它列出需修词条的用户。 */
  ownerId: string | null;
  category: FailureCategory;
  error: string;
  codes: string[];
  invalidConstructForm?: boolean;
  reason?: string;
  term?: string;
  kind?: string;
}

export type RowResult =
  | { id: string; status: 'SUCCEEDED' | 'SKIPPED' }
  | { id: string; status: 'FAILED'; failure: MigrationFailure };

/** 失败分组：同一行可按诊断码出现在多个编译分组里。 */
export interface ResolverMigrationTriage {
  /** 名称解析 E8xx（E801 单列）：多为依赖旧全局替换的本地化策略。 */
  e8xx: MigrationFailure[];
  /** 无效构造写法 `X mit f = v`（P005，aster-lang-ts#244）。 */
  invalidConstructForm: MigrationFailure[];
  /** E801：未标类型参数上的字段访问等无法解析的字段。 */
  untypedFieldAccess: MigrationFailure[];
  /** 作者词汇无法构成作用域（buildVocabularyScopes 抛错），按用户列出需修的词条。 */
  vocabularyScopeByUser: Record<string, MigrationFailure[]>;
  integrityMismatch: MigrationFailure[];
  /** 其余编译失败。 */
  otherCompile: MigrationFailure[];
  /** 未改动、重跑会再试的行。 */
  infrastructure: MigrationFailure[];
}

export interface ResolverMigrationReport {
  processed: number;
  succeeded: number;
  failed: number;
  failures: MigrationFailure[];
  triage: ResolverMigrationTriage;
}

export interface ResolverMigrationOptions {
  batchSize?: number;
  /** 只处理 policyId 以此开头的行；缺省全部（供测试隔离与单策略重跑）。 */
  policyIdPrefix?: string;
}

interface Owner {
  userId: string;
  teamId: string | null;
}

type Recompiled =
  | { ok: true; scopesJson: string }
  | { ok: false; failure: Omit<MigrationFailure, 'id' | 'policyId' | 'version' | 'ownerId'> };

/**
 * 迁移入口必须显式配置的环境变量：编译服务内部地址与内部签名密钥。共享客户端在缺地址时会回落到生产地址、
 * 缺密钥时不签名照发，这对在线请求是可接受的降级，对批量改写封印的迁移不可接受，故入口拒绝运行（fail closed）。
 */
export const RESOLVER_MIGRATION_REQUIRED_ENV = ['ASTER_POLICY_API_INTERNAL_URL', 'ASTER_PLAN_GATE_HMAC_KEY'] as const;

/** 返回缺失（未设置或为空白）的必需环境变量名；为空表示可以运行。 */
export function missingResolverMigrationEnv(env: Readonly<Record<string, string | undefined>>): string[] {
  return RESOLVER_MIGRATION_REQUIRED_ENV.filter((name) => !env[name]?.trim());
}

/** 跑完所有待迁移行并汇总报告。 */
export async function runResolverMigration(options: ResolverMigrationOptions = {}): Promise<ResolverMigrationReport> {
  const batchSize = options.batchSize ?? RESOLVER_MIGRATION_BATCH_SIZE;
  const results: RowResult[] = [];
  let batch = await pendingBatch('', batchSize, options.policyIdPrefix);
  while (batch.length > 0) {
    for (const id of batch) results.push(await migrateVersion(id));
    batch = await pendingBatch(batch.at(-1)!, batchSize, options.policyIdPrefix);
  }
  return summarize(results);
}

/** 在独立事务里迁移一行；事务内抛出的异常一律视为基础设施故障（行不变，重跑再试）。 */
export async function migrateVersion(id: string): Promise<RowResult> {
  let migrated: { result: RowResult; policyId: string | null };
  try {
    migrated = await db.transaction((tx) => migrateLocked(tx, id));
  } catch (err) {
    console.warn('[resolver-migration] row failed, left pending', id, err);
    const error = truncateMigrationError(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return failed({ id, policyId: null, version: null, ownerId: null, category: 'infrastructure', error, codes: [] });
  }
  if (migrated.policyId) await invalidateCache(migrated.policyId);
  return migrated.result;
}

async function migrateLocked(tx: Tx, id: string): Promise<{ result: RowResult; policyId: string | null }> {
  const [row] = await tx.select().from(policyVersions).where(eq(policyVersions.id, id)).for('update');
  if (!row || row.resolverVersion === RESOLVER_VERSION) {
    return { result: { id, status: 'SKIPPED' }, policyId: null };
  }
  const owner = await ownerOf(tx, row.policyId);
  const where = { id, policyId: row.policyId, version: row.version, ownerId: row.createdBy ?? owner?.userId ?? null };
  if (!sealIntact(row)) {
    await tx.update(policyVersions).set({ resolverMigrationError: INTEGRITY_MISMATCH_ERROR }).where(eq(policyVersions.id, id));
    const failure = { ...where, category: 'integrity' as const, error: INTEGRITY_MISMATCH_ERROR, codes: [] };
    return { result: failed(failure), policyId: null };
  }
  const locale = resolveStoredVersionLocale(localeInput(row));
  const recompiled = await recompile(row, owner, locale);
  if (!recompiled.ok) {
    await writeFailure(tx, row, recompiled.failure.error);
    return { result: failed({ ...where, ...recompiled.failure }), policyId: row.policyId };
  }
  await writeSuccess(tx, row, locale, recompiled.scopesJson);
  return { result: { id, status: 'SUCCEEDED' }, policyId: row.policyId };
}

/**
 * 按旧封印核对完整性。有 envelope 时用其格式（5 段或 4 段旧格式，见 policy-version-locale）在候选 locale 中反推，
 * 推不出即不符；有 envelope 却缺工具链串时无法重算旧封印，按不符处理；无 envelope 时比对链式 sourceHash。
 */
function sealIntact(row: VersionRow): boolean {
  if (!row.sourceEnvelopeSha256) {
    return row.sourceHash === computeChainedHash(sourceOf(row), row.prevHash);
  }
  if (!row.sourceToolchainId) return false;
  return recordedCompileLocale(localeInput(row)) !== undefined;
}

/**
 * 带版本词汇经 aster-api 重新编译。词汇选择与执行一致：成功后版本将处于的状态（本任务归档过的行取归档前状态）
 * 已审批/已弃用取冻结快照，其余取作者现行词汇。词汇加载失败、编译服务不可用原样抛出（基础设施故障）。
 */
async function recompile(row: VersionRow, owner: Owner | null, locale: string): Promise<Recompiled> {
  const source = sourceOf(row);
  const vocabulary = await loadVersionVocabulary(row, { source, locale });
  let scopesJson: string;
  try {
    scopesJson = vocabularyScopesJson(vocabulary);
  } catch (err) {
    const details = vocabularyScopeErrorDetails(err);
    if (!details) throw err;
    const error = truncateMigrationError(`vocabulary_scope_invalid: ${details.reason ?? 'unknown'}: ${details.message}`);
    const { reason, term, kind } = details;
    return { ok: false, failure: { category: 'vocabulary', error, codes: [], reason, term, kind } };
  }
  const userId = row.createdBy ?? owner?.userId ?? 'resolver-migration';
  const compile = makeCompileValidator(userId, vocabulary, owner ? policyTenantId(owner) : userId);
  try {
    // 冻结别名在创建时已校验并授权，与执行一致按已授权应用结构词别名
    const { diagnostics } = await compile({ source, locale, aliasSet: parseAliasSet(row.aliasSet), allowStructural: true });
    const errors = (diagnostics ?? []).filter((d) => d.severity === 'error');
    return errors.length === 0 ? { ok: true, scopesJson } : compileFailure(errors, source);
  } catch (err) {
    if (err instanceof PolicyCompileUnavailableError || !(err instanceof PolicyCompileError)) throw err;
    return compileFailure(err.diagnostics ?? [], source, err.message);
  }
}

async function loadVersionVocabulary(row: VersionRow, policy: PolicyVocabularyContext): Promise<DomainVocabulary | null> {
  const status = row.archivedByResolverMigration ? (row.statusBeforeArchive ?? row.status) : row.status;
  if (executionVocabularySource(status) === 'frozen') {
    return loadVocabularyForExecution(row.vocabularySnapshotIds as SnapshotRef[], policy);
  }
  return row.createdBy ? loadLiveVocabularyForPolicy(row.createdBy, policy) : null;
}

function compileFailure(errors: readonly CompileDiagnostic[], source: string, fallback?: string): Recompiled {
  const codes = [...new Set(errors.map((d) => d.code ?? 'compile_error'))];
  const message = errors.map((d) => `${d.code ?? 'compile_error'}: ${d.message ?? ''}`).join('; ');
  const error = truncateMigrationError(message || fallback || 'compile failed');
  const invalidConstructForm = codes.includes('P005') && INVALID_CONSTRUCT_FORM.test(source);
  return { ok: false, failure: { category: 'compile', error, codes, invalidConstructForm } };
}

async function writeSuccess(tx: Tx, row: VersionRow, locale: string, scopesJson: string): Promise<void> {
  const toolchain = cloudToolchainId();
  const envelope = computeSourceEnvelope(sourceOf(row), row.aliasSet, locale, toolchain, scopesJson);
  const restore = row.archivedByResolverMigration
    ? { status: row.statusBeforeArchive ?? row.status, statusBeforeArchive: null }
    : {};
  await tx.update(policyVersions).set({
    sourceEnvelopeSha256: envelope,
    sourceToolchainId: toolchain,
    sourceScopesJson: scopesJson,
    resolverVersion: RESOLVER_VERSION,
    resolverMigrationError: null,
    archivedByResolverMigration: false,
    ...restore,
  }).where(eq(policyVersions.id, row.id));
  await relinkSuccessors(tx, row, envelope);
}

async function writeFailure(tx: Tx, row: VersionRow, error: string): Promise<void> {
  const archive = row.status === 'ARCHIVED'
    ? {}
    : { status: 'ARCHIVED' as const, statusBeforeArchive: row.status, archivedByResolverMigration: true };
  await tx.update(policyVersions).set({ resolverMigrationError: error, ...archive }).where(eq(policyVersions.id, row.id));
}

interface LinkChange {
  version: number;
  oldLink: string | null;
  newLink: string | null;
}

/** 本行链接变了就沿链改写后继，直到某个后继的链接不再变化（有 envelope，或 sourceHash 未重算）。 */
async function relinkSuccessors(tx: Tx, row: VersionRow, newLink: string): Promise<void> {
  let change: LinkChange | null = { version: row.version, oldLink: chainLink(row), newLink };
  while (change && change.oldLink !== change.newLink) {
    change = await relinkSuccessor(tx, row.policyId, change);
  }
}

/** 改写直接后继：prevHash 必须仍等于旧链接（否则链本已断开，保持原样）；sourceHash 原本自洽才重算。 */
async function relinkSuccessor(tx: Tx, policyId: string, change: LinkChange): Promise<LinkChange | null> {
  const [next] = await tx.select().from(policyVersions)
    .where(and(eq(policyVersions.policyId, policyId), gt(policyVersions.version, change.version)))
    .orderBy(asc(policyVersions.version))
    .limit(1)
    .for('update');
  if (!next || next.prevHash !== change.oldLink) return null;
  const source = sourceOf(next);
  const selfConsistent = next.sourceHash === computeChainedHash(source, change.oldLink);
  const sourceHash = selfConsistent ? computeChainedHash(source, change.newLink) : next.sourceHash;
  await tx.update(policyVersions).set({ prevHash: change.newLink, sourceHash }).where(eq(policyVersions.id, next.id));
  if (next.sourceEnvelopeSha256) return null;
  return { version: next.version, oldLink: next.sourceHash, newLink: sourceHash };
}

function chainLink(row: VersionRow): string | null {
  return row.sourceEnvelopeSha256 ?? row.sourceHash;
}

function sourceOf(row: VersionRow): string {
  return row.source ?? row.content;
}

function localeInput(row: VersionRow) {
  return {
    source: sourceOf(row),
    aliasSet: row.aliasSet,
    sourceEnvelopeSha256: row.sourceEnvelopeSha256,
    sourceToolchainId: row.sourceToolchainId,
    sourceScopesJson: row.sourceScopesJson,
    vocabularySnapshotIds: row.vocabularySnapshotIds,
  };
}

function parseAliasSet(aliasSet: string | null): Record<string, string[]> | null {
  return aliasSet ? (JSON.parse(aliasSet) as Record<string, string[]>) : null;
}

async function ownerOf(tx: Tx, policyId: string): Promise<Owner | null> {
  const [owner] = await tx
    .select({ userId: policies.userId, teamId: policies.teamId })
    .from(policies)
    .where(eq(policies.id, policyId));
  return owner ?? null;
}

async function pendingBatch(cursor: string, batchSize: number, prefix: string | undefined): Promise<string[]> {
  const rows = await db
    .select({ id: policyVersions.id })
    .from(policyVersions)
    .where(and(
      sql`${policyVersions.resolverVersion} IS DISTINCT FROM ${RESOLVER_VERSION}`,
      gt(policyVersions.id, cursor),
      prefix ? sql`starts_with(${policyVersions.policyId}, ${prefix})` : undefined,
    ))
    .orderBy(asc(policyVersions.id))
    .limit(batchSize);
  return rows.map((r) => r.id);
}

/** 行事务已提交，失效失败只影响缓存新鲜度（另有 TTL 兜底），不改变该行的迁移结果。 */
async function invalidateCache(policyId: string): Promise<void> {
  try {
    await invalidatePolicyCache(policyId);
  } catch (err) {
    console.warn('[resolver-migration] committed, but cache invalidation failed', policyId, err);
  }
}

function failed(failure: MigrationFailure): RowResult {
  return { id: failure.id, status: 'FAILED', failure };
}

/** 截断到上限；截断点落在代理对中间时少截一位，避免留下孤立的高代理。 */
export function truncateMigrationError(error: string | null | undefined): string {
  const safe = error && error.trim() !== '' ? error : 'unknown error';
  if (safe.length <= MAX_ERROR_LENGTH) return safe;
  const splitsPair = /[\uD800-\uDBFF]/.test(safe.charAt(MAX_ERROR_LENGTH - 1));
  return safe.slice(0, splitsPair ? MAX_ERROR_LENGTH - 1 : MAX_ERROR_LENGTH);
}

function summarize(results: readonly RowResult[]): ResolverMigrationReport {
  const failures = results.flatMap((r) => (r.status === 'FAILED' ? [r.failure] : []));
  const succeeded = results.filter((r) => r.status === 'SUCCEEDED').length;
  return {
    processed: succeeded + failures.length,
    succeeded,
    failed: failures.length,
    failures,
    triage: buildTriage(failures),
  };
}

/** 按原因/诊断码分组，供迁移后人工处置。 */
export function buildTriage(failures: readonly MigrationFailure[]): ResolverMigrationTriage {
  const compile = failures.filter((f) => f.category === 'compile');
  const isE8xx = (code: string) => /^E8\d\d$/.test(code) && code !== 'E801';
  const vocabularyScopeByUser: Record<string, MigrationFailure[]> = {};
  for (const failure of failures.filter((f) => f.category === 'vocabulary')) {
    const user = failure.ownerId ?? 'unknown';
    vocabularyScopeByUser[user] = [...(vocabularyScopeByUser[user] ?? []), failure];
  }
  return {
    e8xx: compile.filter((f) => f.codes.some(isE8xx)),
    invalidConstructForm: compile.filter((f) => f.invalidConstructForm === true),
    untypedFieldAccess: compile.filter((f) => f.codes.includes('E801')),
    vocabularyScopeByUser,
    integrityMismatch: failures.filter((f) => f.category === 'integrity'),
    otherCompile: compile.filter((f) => !f.invalidConstructForm && !f.codes.some((c) => c === 'E801' || isE8xx(c))),
    infrastructure: failures.filter((f) => f.category === 'infrastructure'),
  };
}
