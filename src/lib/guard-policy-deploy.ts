/**
 * Guard 策略部署（aster-api ADR 0054 §11 D1，R66）：策略的默认版本即 aster-api Guard 按
 * `policyModule / policyFunction` 裁决时使用的活跃版本。
 *
 * 「先部署、后提交」：Guard 若继续按旧版本裁决而 cloud 已显示新默认版本，新版本想拒绝的动作会被旧版本放行。
 * 所以默认版本变更与删除都以 aster-api 同步成功为前提：
 *   1. reserve：独立事务里把该策略的 generation 加一并记下期望状态（部署某版本 / 撤回）；
 *   2. push：同步调用 aster-api（PUT / DELETE 带 generation），成功记 appliedGeneration；
 *   3. commit：调用方事务锁住部署行、核对 generation 仍是自己预留的值，再提交默认版本变更 / 删除；
 *      不是则 409 default_changed_concurrently（被更新的请求取代；旧代际的部署在 aster-api 本就不会生效）。
 * aster-api 不可用或拒绝 → 抛 GuardDeployError，默认版本不变。崩溃窗口（aster-api 已切换、cloud 提交失败）
 * 由 cron guard-deploy-sync 收敛：期望或已应用代际与实际默认版本不符时，以 generation+1 重发**实际**状态。
 */
import { createHash } from 'node:crypto';
import { compile } from '@aster-cloud/aster-lang-ts/browser';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getLexicon } from '@/lib/aster-lexicon';
import { loadStoredVersionCompileContext } from '@/lib/execution-input';
import { buildExecutionVocabulary } from '@/lib/execution-input/mapper';
import { resolveEntryFunction } from '@/lib/execution-input/policy-types';
import { policyTenantId } from '@/lib/policy-tenant';
import { db, guardPolicyDeployments, policies, policyVersions } from '@/lib/prisma';
import {
  PolicyApiClient,
  PolicyApiError,
  type GuardPolicyDeploymentBody,
} from '@/services/policy/policy-api';

/** cron / 回填 / 重新同步以此身份签名（aster-api 要求签名用户非空且非 anonymous）。 */
export const GUARD_DEPLOY_SYSTEM_USER = 'system:guard-deploy-sync';

/** 期望状态：部署某个 cloud 版本，或撤回。 */
export type GuardDesired = { cloudVersionId: string } | { withdrawn: true };

/** 部署失败：status 为 aster-api 状态码（0 = 不可达），error 为错误码；设默认 / 删除据此失败。 */
export class GuardDeployError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    message: string,
  ) {
    super(message);
    this.name = 'GuardDeployError';
  }
}

export type PushResult =
  | { ok: true; superseded?: boolean; policyVersionId?: number }
  | { ok: false; status: number; error: string };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 依赖注入点（测试替换 aster-api 与载荷构造）。 */
export interface GuardDeployDeps {
  deploy(tenantId: string, actor: string, policyId: string, body: GuardPolicyDeploymentBody): Promise<{ policyVersionId: number }>;
  withdraw(tenantId: string, actor: string, policyId: string, generation: number): Promise<void>;
  payload(versionId: string): Promise<Omit<GuardPolicyDeploymentBody, 'generation'>>;
}

const defaultDeps: GuardDeployDeps = {
  async deploy(tenantId, actor, policyId, body) {
    return new PolicyApiClient(tenantId, actor).deployGuardPolicy(policyId, body);
  },
  async withdraw(tenantId, actor, policyId, generation) {
    await new PolicyApiClient(tenantId, actor).withdrawGuardPolicy(policyId, generation);
  },
  payload: buildDeploymentPayload,
};

let activeDeps: GuardDeployDeps = defaultDeps;

/** 仅测试：替换 aster-api 调用与载荷构造（传 undefined 还原）。 */
export function setGuardDeployDepsForTest(deps: Partial<GuardDeployDeps> | undefined): void {
  activeDeps = deps ? { ...defaultDeps, ...deps } : defaultDeps;
}

/** 在独立事务里预留下一代际并记下期望状态；返回预留的代际。 */
export async function reserveGuardGeneration(policyId: string, tenantId: string, desired: GuardDesired): Promise<number> {
  const desiredVersionId = 'withdrawn' in desired ? null : desired.cloudVersionId;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ generation: guardPolicyDeployments.generation })
      .from(guardPolicyDeployments)
      .where(eq(guardPolicyDeployments.policyId, policyId))
      .for('update');
    const generation = (row?.generation ?? 0) + 1;
    if (row) {
      await tx
        .update(guardPolicyDeployments)
        .set({ generation, desiredVersionId, tenantId })
        .where(eq(guardPolicyDeployments.policyId, policyId));
    } else {
      await tx.insert(guardPolicyDeployments).values({ policyId, tenantId, generation, desiredVersionId });
    }
    return generation;
  });
}

/**
 * 按该代际的期望状态同步 aster-api。409 stale_generation 视为已被更新的请求取代（成功、不记 applied）；
 * 撤回时 404（从未部署）视为成功。其余失败记 lastError 并返回失败。
 */
export async function pushGuardDeployment(
  policyId: string,
  generation: number,
  actor: string,
  deps: GuardDeployDeps = activeDeps,
): Promise<PushResult> {
  const row = await db.query.guardPolicyDeployments.findFirst({ where: eq(guardPolicyDeployments.policyId, policyId) });
  if (!row) return { ok: false, status: 0, error: 'not_reserved' };
  try {
    let policyVersionId: number | undefined;
    if (row.desiredVersionId === null) {
      await deps.withdraw(row.tenantId, actor, policyId, generation).catch((e: unknown) => {
        if (!(e instanceof PolicyApiError && e.statusCode === 404)) throw e;
      });
    } else {
      const body = await deps.payload(row.desiredVersionId);
      policyVersionId = (await deps.deploy(row.tenantId, actor, policyId, { ...body, generation })).policyVersionId;
    }
    await recordApplied(policyId, generation);
    return { ok: true, ...(policyVersionId === undefined ? {} : { policyVersionId }) };
  } catch (e) {
    const failure = toFailure(e);
    if (failure.status === 409 && failure.error === 'stale_generation') return { ok: true, superseded: true };
    await db
      .update(guardPolicyDeployments)
      .set({ lastError: `${failure.status} ${failure.error}`.slice(0, 500) })
      .where(eq(guardPolicyDeployments.policyId, policyId));
    return { ok: false, ...failure };
  }
}

/**
 * 先部署、后提交：预留代际 → 同步 aster-api → 在事务里核对代际后执行 commit（设默认版本 / 软删除）。
 * 部署失败抛 {@link GuardDeployError}；代际已被并发请求更新抛 409 default_changed_concurrently。
 */
export async function deployThenCommit(params: {
  policyId: string;
  tenantId: string;
  desired: GuardDesired;
  actor: string;
  commit: (tx: Tx) => Promise<void>;
  deps?: GuardDeployDeps;
}): Promise<void> {
  if ('withdrawn' in params.desired && !(await db.query.guardPolicyDeployments.findFirst({
    where: eq(guardPolicyDeployments.policyId, params.policyId),
    columns: { policyId: true },
  }))) {
    // 从未部署过的策略没有可撤回的 Guard 版本：不依赖 aster-api 可用性。与并发设默认的竞态由 cron 收敛。
    await db.transaction(params.commit);
    return;
  }
  const generation = await reserveGuardGeneration(params.policyId, params.tenantId, params.desired);
  const pushed = await pushGuardDeployment(params.policyId, generation, params.actor, params.deps ?? activeDeps);
  if (!pushed.ok) {
    throw new GuardDeployError(
      pushed.status === 0 || pushed.status >= 500 ? 503 : pushed.status,
      pushed.status === 0 || pushed.status >= 500 ? 'guard_deploy_unavailable' : pushed.error,
      `Guard 策略部署失败（${pushed.status} ${pushed.error}）；默认版本未变更，可稍后重试`,
    );
  }
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ generation: guardPolicyDeployments.generation })
      .from(guardPolicyDeployments)
      .where(eq(guardPolicyDeployments.policyId, params.policyId))
      .for('update');
    if (row?.generation !== generation) {
      throw new GuardDeployError(409, 'default_changed_concurrently', '同一策略的默认版本被并发修改，本次变更已被取代');
    }
    await params.commit(tx);
  });
}

/** 策略此刻实际应有的 Guard 状态：未删除且有已批准的默认版本 → 部署它；否则撤回。 */
export async function actualDesired(policyId: string): Promise<GuardDesired> {
  const policy = await db.query.policies.findFirst({
    where: and(eq(policies.id, policyId), isNull(policies.deletedAt)),
    columns: { id: true },
  });
  if (!policy) return { withdrawn: true };
  const version = await db.query.policyVersions.findFirst({
    where: and(eq(policyVersions.policyId, policyId), eq(policyVersions.isDefault, true), eq(policyVersions.status, 'APPROVED')),
    columns: { id: true },
  });
  return version ? { cloudVersionId: version.id } : { withdrawn: true };
}

export interface ReconcileReport {
  checked: number;
  pushed: number;
  failed: Array<{ policyId: string; status: number; error: string }>;
}

/**
 * 收敛（cron guard-deploy-sync 与「重新同步」共用）：对 applied 落后于 generation、或期望与实际默认版本不符的策略，
 * 以 generation+1 重发实际状态。onlyPolicyId 限定单个策略（重新同步按钮）。
 */
export async function reconcileGuardDeployments(
  opts: { onlyPolicyId?: string; deps?: GuardDeployDeps } = {},
): Promise<ReconcileReport> {
  const rows = await db.query.guardPolicyDeployments.findMany({
    ...(opts.onlyPolicyId ? { where: eq(guardPolicyDeployments.policyId, opts.onlyPolicyId) } : {}),
  });
  const report: ReconcileReport = { checked: rows.length, pushed: 0, failed: [] };
  for (const row of rows) {
    const actual = await actualDesired(row.policyId);
    const actualVersionId = 'withdrawn' in actual ? null : actual.cloudVersionId;
    const behind = row.appliedGeneration === null || row.appliedGeneration < row.generation;
    if (!behind && row.desiredVersionId === actualVersionId && !opts.onlyPolicyId) continue;
    const generation = await reserveGuardGeneration(row.policyId, row.tenantId, actual);
    const pushed = await pushGuardDeployment(row.policyId, generation, GUARD_DEPLOY_SYSTEM_USER, opts.deps ?? activeDeps);
    if (pushed.ok) report.pushed++;
    else report.failed.push({ policyId: row.policyId, status: pushed.status, error: pushed.error });
  }
  return report;
}

/** 回填（上线时一次）：每个未删除、有已批准默认版本但从未部署的策略，按实际状态部署一次。 */
export async function backfillGuardDeployments(
  opts: { apply: boolean; deps?: GuardDeployDeps },
): Promise<Array<{ policyId: string; versionId: string; result: PushResult | 'dry-run' }>> {
  const defaults = await db
    .select({ policyId: policyVersions.policyId, versionId: policyVersions.id, teamId: policies.teamId, userId: policies.userId })
    .from(policyVersions)
    .innerJoin(policies, eq(policies.id, policyVersions.policyId))
    .where(and(eq(policyVersions.isDefault, true), eq(policyVersions.status, 'APPROVED'), isNull(policies.deletedAt)));
  const out: Array<{ policyId: string; versionId: string; result: PushResult | 'dry-run' }> = [];
  for (const d of defaults) {
    const existing = await db.query.guardPolicyDeployments.findFirst({ where: eq(guardPolicyDeployments.policyId, d.policyId) });
    if (existing?.appliedGeneration != null && existing.desiredVersionId === d.versionId) continue;
    if (!opts.apply) {
      out.push({ policyId: d.policyId, versionId: d.versionId, result: 'dry-run' });
      continue;
    }
    const generation = await reserveGuardGeneration(d.policyId, policyTenantId(d), { cloudVersionId: d.versionId });
    out.push({
      policyId: d.policyId,
      versionId: d.versionId,
      result: await pushGuardDeployment(d.policyId, generation, GUARD_DEPLOY_SYSTEM_USER, opts.deps ?? activeDeps),
    });
  }
  return out;
}

/**
 * 部署载荷：版本源码、冻结别名、与 What-If / Cedar 导出同一口径的语言与冻结词汇（严格加载，失败抛错）、
 * /execute 同一取法的入口函数、源码 Module 头，以及源码 UTF-8 的 sha256。
 */
export async function buildDeploymentPayload(versionId: string): Promise<Omit<GuardPolicyDeploymentBody, 'generation'>> {
  const version = await db.query.policyVersions.findFirst({ where: eq(policyVersions.id, versionId) });
  if (!version) throw new GuardDeployError(404, 'version_not_found', `版本 ${versionId} 不存在`);
  const policy = await db.query.policies.findFirst({ where: eq(policies.id, version.policyId), columns: { teamId: true } });
  const source = version.content;
  const { locale, vocabulary } = await loadStoredVersionCompileContext({
    source,
    aliasSet: version.aliasSet,
    sourceEnvelopeSha256: version.sourceEnvelopeSha256,
    sourceToolchainId: version.sourceToolchainId,
    sourceScopesJson: version.sourceScopesJson,
    vocabularySnapshotIds: version.vocabularySnapshotIds,
    status: version.status,
    createdBy: version.createdBy,
    teamId: policy?.teamId ?? null,
    policyId: version.policyId,
  });
  const aliasSet = parseAliasSet(version.aliasSet);
  const entry = resolveEntryFunction({ source, locale, aliasSet: aliasSet ?? null, vocabulary: buildExecutionVocabulary(vocabulary) });
  if (!entry.ok) {
    throw new GuardDeployError(422, 'function_not_found', `无法确定入口函数（${entry.reason}）`);
  }
  return {
    cloudVersionId: version.id,
    cloudVersion: version.version,
    moduleName: moduleNameOf(source, locale),
    functionName: entry.functionName,
    source,
    locale,
    ...(aliasSet ? { aliasSet } : {}),
    ...(vocabulary ? { vocabulary } : {}),
    sourceSha256: createHash('sha256').update(source, 'utf8').digest('hex'),
  };
}

/** 源码的 Module 头：先按 Core IR 取；编译不过（如依赖别名）时按词法的 Module 关键字取首行。 */
export function moduleNameOf(source: string, locale: string): string {
  const lexicon = getLexicon(locale);
  const compiled = compile(source, { lexicon });
  if (compiled.success && compiled.core?.name) return compiled.core.name;
  const keyword = (lexicon as unknown as { keywords?: Record<string, string> }).keywords?.MODULE_DECL ?? 'Module';
  for (const line of source.split('\n')) {
    const m = new RegExp(`^\\s*${escapeRegExp(keyword)}\\s+(\\S+?)[.。]\\s*$`).exec(line);
    if (m) return m[1];
  }
  throw new GuardDeployError(422, 'module_not_found', '源码缺少 Module 头');
}

function parseAliasSet(json: string | null): Record<string, string[]> | undefined {
  if (!json) return undefined;
  const parsed = JSON.parse(json) as Record<string, string[]>;
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function recordApplied(policyId: string, generation: number): Promise<void> {
  // 只前进不后退：并发的旧代际成功不得把 applied 拉回去。
  await db
    .update(guardPolicyDeployments)
    .set({
      appliedGeneration: sql`GREATEST(COALESCE(${guardPolicyDeployments.appliedGeneration}, 0), ${generation})`,
      lastError: null,
    })
    .where(eq(guardPolicyDeployments.policyId, policyId));
}

function toFailure(e: unknown): { status: number; error: string } {
  if (e instanceof GuardDeployError) return { status: e.status, error: e.error };
  if (e instanceof PolicyApiError) {
    const unreachable = e.statusCode === 408 || e.code === 'UNKNOWN';
    return { status: unreachable ? 0 : e.statusCode, error: e.code ?? `http_${e.statusCode}` };
  }
  return { status: 0, error: e instanceof Error ? e.name : 'error' };
}
