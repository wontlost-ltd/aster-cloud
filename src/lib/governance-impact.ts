/**
 * 控制项影响分析（#739）：给定 `@control` 键或整个注册表，列出调用方可见的受影响策略。
 *
 * 数据来源：
 *   - 引用关系：PolicyVersion 源码经 aster-lang-ts 解析取 AST 注解（见 policy-control-references），覆盖全部
 *     未归档版本与全部规则；只把含 `@control` 字样的版本源码读进来解析，解析失败的版本记入 `unparsed`；
 *   - 可见范围：policiesVisibleTo(userId, 'view') + 未删除（与报告页 / 证据导出同一口径）；
 *   - active：当前可执行版本（isDefault 的 APPROVED，否则最新 APPROVED）是否引用该控制项；
 *   - 近 30 天执行数：按 executionAggregateScope 口径——团队策略计全部执行，个人策略只计所有者本人；
 *   - 待审批数：status = PENDING_APPROVAL 的版本数。
 *
 * 只读、无缓存：注册表变更（新条款、改号）时作者据此逐条处理，结果必须与当下源码一致。
 */
import 'server-only';

import { and, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { db, executions, policies, policyVersions, teams } from '@/lib/prisma';
import { policiesVisibleTo } from '@/lib/policy-access';
import { parseControlReferences } from '@/lib/policy-control-references';
import { resolveStoredVersionLocale } from '@/lib/policy-version-locale';
import { defaultControlRegistry, type ControlRegistryData, type LocalizedTitle } from '@/services/evidence/control-registry';

/** 控制键形态（ADR 0045 §2.1）：与注册表构建期校验一致。 */
const CONTROL_KEY = /^[A-Z0-9_]+:[A-Z0-9_().]+$/;
export function isControlKey(value: string): boolean {
  return value.length <= 64 && CONTROL_KEY.test(value);
}

const THIRTY_DAYS_MS = 30 * 86_400_000;

type VersionStatus = typeof policyVersions.$inferSelect.status;

export interface ImpactVersion {
  version: number;
  status: VersionStatus;
  isDefault: boolean;
}

export interface PolicyActivity {
  id: string;
  name: string;
  teamId: string | null;
  teamName: string | null;
  /** 近 30 天执行数（团队策略计全部执行；个人策略只计所有者本人）。 */
  executions30d: number;
  /** 待审批（PENDING_APPROVAL）版本数。 */
  pendingApprovals: number;
}

export interface ImpactPolicy extends PolicyActivity {
  /** 当前可执行版本引用了该控制项。 */
  active: boolean;
  /** 引用该控制项的版本（已归档版本不计），按版本号升序。 */
  versions: ImpactVersion[];
}

/** 含 `@control` 字样但无法解析的版本：引用关系未知，如实列出而不是当作无引用。 */
export interface UnparsedVersion {
  policyId: string;
  version: number;
  diagnostics: string[];
}

export interface ControlImpact {
  control: string;
  registryVersion: string;
  /** 注册表登记信息；未登记的键为 null。 */
  registry: { framework: string; article: string; title: LocalizedTitle } | null;
  policies: ImpactPolicy[];
  unparsed: UnparsedVersion[];
}

export interface ControlGroup {
  key: string;
  article: string;
  title: LocalizedTitle;
  policies: ImpactPolicy[];
}

export interface GovernanceOverview {
  registryVersion: string;
  frameworks: Array<{ id: string; title: LocalizedTitle; controls: ControlGroup[] }>;
  /** 源码里出现、注册表未登记的键（编译期 W704），按键排序。 */
  unregistered: Array<{ key: string; policies: ImpactPolicy[] }>;
  /** 没有任何未归档版本引用 @control 的策略（有无法解析版本的策略不在此列：引用关系未知）。 */
  unlinked: PolicyActivity[];
  unparsed: UnparsedVersion[];
}

interface ScannedPolicy extends PolicyActivity {
  /** 当前可执行版本号；没有 APPROVED 版本为 null。 */
  activeVersion: number | null;
  /** 控制键 → 引用它的版本。 */
  byControl: Map<string, ImpactVersion[]>;
  unparsed: UnparsedVersion[];
}

interface VersionRow {
  policyId: string;
  version: number;
  status: VersionStatus;
  isDefault: boolean;
  /** 只在源码含 `@control` 字样时非空（SQL 预筛）。 */
  content: string | null;
  aliasSet: string | null;
  sourceEnvelopeSha256: string | null;
  sourceToolchainId: string | null;
  sourceScopesJson: string | null;
  vocabularySnapshotIds: unknown;
}

/** 解析一条候选版本：lexicon 按版本记录的 locale 选，别名用版本冻结的那份（与执行同口径）。 */
function referencesOf(v: VersionRow, content: string) {
  const aliasSet = v.aliasSet ? (JSON.parse(v.aliasSet) as Record<string, string[]>) : null;
  const locale = resolveStoredVersionLocale({
    source: content,
    aliasSet: v.aliasSet,
    sourceEnvelopeSha256: v.sourceEnvelopeSha256,
    sourceToolchainId: v.sourceToolchainId,
    sourceScopesJson: v.sourceScopesJson,
    vocabularySnapshotIds: v.vocabularySnapshotIds,
  });
  return parseControlReferences({ source: content, locale, aliasSet });
}

/** 当前可执行版本：isDefault 的 APPROVED，否则最新 APPROVED（与 default-executable-version 同口径）。 */
function activeVersionOf(versions: readonly VersionRow[]): number | null {
  const approved = versions.filter((v) => v.status === 'APPROVED');
  const preferred = approved.find((v) => v.isDefault);
  if (preferred) return preferred.version;
  return approved.reduce<number | null>((max, v) => (max === null || v.version > max ? v.version : max), null);
}

async function countByPolicy(policyIds: string[], query: () => Promise<Array<{ policyId: string; count: number }>>) {
  const counts = new Map<string, number>();
  if (policyIds.length === 0) return counts;
  for (const row of await query()) counts.set(row.policyId, row.count);
  return counts;
}

/** 调用方可见的全部策略及其控制项引用、执行与审批活动。 */
async function scanVisiblePolicies(userId: string): Promise<ScannedPolicy[]> {
  const rows = await db
    .select({ id: policies.id, name: policies.name, userId: policies.userId, teamId: policies.teamId, teamName: teams.name })
    .from(policies)
    .leftJoin(teams, eq(teams.id, policies.teamId))
    .where(and(policiesVisibleTo(userId, 'view'), isNull(policies.deletedAt)))
    .orderBy(policies.name, policies.id);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  // 只把含 `@control` 字样的版本源码读进来：大多数版本没有注解，不必搬运全文。
  // 规模假设（2026-11-06 本地实测，M 系列 Mac + podman PG）：解析约 0.4–0.5 ms / 版本（800 字节源码），
  // 100 策略 × 20 版本 = 2000 个候选版本的总览端到端约 620 ms。阈值定为单租户 5000 个候选版本（≈ 2 s）；
  // 超过时改为 createVersion 时把引用键落列（后续项，见 PR #740），当前不做缓存、不加列。
  const versions: VersionRow[] = await db
    .select({
      policyId: policyVersions.policyId,
      version: policyVersions.version,
      status: policyVersions.status,
      isDefault: policyVersions.isDefault,
      content: sql<string | null>`case when ${policyVersions.content} like '%@control%' then ${policyVersions.content} else null end`,
      aliasSet: policyVersions.aliasSet,
      sourceEnvelopeSha256: policyVersions.sourceEnvelopeSha256,
      sourceToolchainId: policyVersions.sourceToolchainId,
      sourceScopesJson: policyVersions.sourceScopesJson,
      vocabularySnapshotIds: policyVersions.vocabularySnapshotIds,
    })
    .from(policyVersions)
    .where(and(inArray(policyVersions.policyId, ids), ne(policyVersions.status, 'ARCHIVED')))
    .orderBy(policyVersions.policyId, policyVersions.version);

  const since = new Date(Date.now() - THIRTY_DAYS_MS);
  const [executions30d, pending] = await Promise.all([
    countByPolicy(ids, () =>
      db
        .select({ policyId: executions.policyId, count: sql<number>`count(*)::int` })
        .from(executions)
        .innerJoin(policies, eq(policies.id, executions.policyId))
        .where(and(
          inArray(executions.policyId, ids),
          gte(executions.createdAt, since),
          // 团队策略计全部执行；个人策略只计所有者本人（executionAggregateScope）
          or(sql`coalesce(${policies.teamId}, '') <> ''`, eq(executions.userId, policies.userId)),
        ))
        .groupBy(executions.policyId)),
    countByPolicy(ids, () =>
      db
        .select({ policyId: policyVersions.policyId, count: sql<number>`count(*)::int` })
        .from(policyVersions)
        .where(and(inArray(policyVersions.policyId, ids), eq(policyVersions.status, 'PENDING_APPROVAL')))
        .groupBy(policyVersions.policyId)),
  ]);

  const versionsByPolicy = new Map<string, VersionRow[]>();
  for (const v of versions) {
    const list = versionsByPolicy.get(v.policyId);
    if (list) list.push(v);
    else versionsByPolicy.set(v.policyId, [v]);
  }

  return rows.map((row) => {
    const own = versionsByPolicy.get(row.id) ?? [];
    const byControl = new Map<string, ImpactVersion[]>();
    const unparsed: UnparsedVersion[] = [];
    for (const v of own) {
      if (v.content === null) continue;
      const parsed = referencesOf(v, v.content);
      if (!parsed.ok) {
        unparsed.push({ policyId: row.id, version: v.version, diagnostics: parsed.diagnostics });
        continue;
      }
      for (const key of parsed.controls) {
        const refs = byControl.get(key);
        const ref = { version: v.version, status: v.status, isDefault: v.isDefault };
        if (refs) refs.push(ref);
        else byControl.set(key, [ref]);
      }
    }
    return {
      id: row.id,
      name: row.name,
      teamId: row.teamId || null,
      teamName: row.teamId ? row.teamName : null,
      executions30d: executions30d.get(row.id) ?? 0,
      pendingApprovals: pending.get(row.id) ?? 0,
      activeVersion: activeVersionOf(own),
      byControl,
      unparsed,
    };
  });
}

function impactOf(policy: ScannedPolicy, key: string): ImpactPolicy | null {
  const versions = policy.byControl.get(key);
  if (!versions) return null;
  const { activeVersion: _active, byControl: _refs, unparsed: _unparsed, ...activity } = policy;
  return { ...activity, active: versions.some((v) => v.version === policy.activeVersion), versions };
}

function impactedBy(scanned: readonly ScannedPolicy[], key: string): ImpactPolicy[] {
  return scanned.flatMap((p) => impactOf(p, key) ?? []);
}

function unparsedOf(scanned: readonly ScannedPolicy[]): UnparsedVersion[] {
  return scanned.flatMap((p) => p.unparsed);
}

export async function loadControlImpact(
  userId: string,
  control: string,
  registry: ControlRegistryData = defaultControlRegistry,
): Promise<ControlImpact> {
  const scanned = await scanVisiblePolicies(userId);
  const entry = registry.controls.find((c) => c.key === control) ?? null;
  return {
    control,
    registryVersion: registry.version,
    registry: entry && { framework: entry.framework, article: entry.article, title: entry.title },
    policies: impactedBy(scanned, control),
    unparsed: unparsedOf(scanned),
  };
}

export async function loadGovernanceOverview(
  userId: string,
  registry: ControlRegistryData = defaultControlRegistry,
): Promise<GovernanceOverview> {
  const scanned = await scanVisiblePolicies(userId);
  const registered = new Set(registry.controls.map((c) => c.key));
  const unregisteredKeys = [...new Set(scanned.flatMap((p) => [...p.byControl.keys()]))]
    .filter((key) => !registered.has(key))
    .sort();
  return {
    registryVersion: registry.version,
    frameworks: registry.frameworks.map((f) => ({
      id: f.id,
      title: f.title,
      controls: registry.controls
        .filter((c) => c.framework === f.id)
        .map((c) => ({ key: c.key, article: c.article, title: c.title, policies: impactedBy(scanned, c.key) })),
    })),
    unregistered: unregisteredKeys.map((key) => ({ key, policies: impactedBy(scanned, key) })),
    unlinked: scanned
      .filter((p) => p.byControl.size === 0 && p.unparsed.length === 0)
      .map(({ activeVersion: _active, byControl: _refs, unparsed: _unparsed, ...activity }) => activity),
    unparsed: unparsedOf(scanned),
  };
}
