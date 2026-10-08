// 证据导出查询层：投影 executions 的**哈希/溯源字段**（现有 queryExecutionLogs 故意不投影它们）。
//
// 与 policy-execution-log 分开：那里给日志 UI（input/output/error），这里给证据包（哈希/溯源，
// **默认排除 traceJson 等 PII 明文**，只导 traceHash）。

import { db, executions, policies } from '@/lib/prisma';
import { and, eq, gte, lte, asc, isNull, isNotNull, inArray, sql } from 'drizzle-orm';
import { EMPTY_TALLY, type EvidenceRow } from '@/services/evidence/bundle';
import type { DecisionTally, EvidenceAgent, EvidenceDecision, EvidencePreview } from '@/services/evidence/types';

/** 单次导出的执行行数上限（安全阀，防无界 data json / 大响应）。超出即拒，提示用户缩小范围。 */
export const EVIDENCE_EXPORT_ROW_LIMIT = 50_000;

export class EvidenceTooLargeError extends Error {
  constructor(public readonly count: number, public readonly limit: number) {
    super(`Evidence export too large: ${count} executions exceeds limit ${limit}`);
    this.name = 'EvidenceTooLargeError';
  }
}

export interface EvidenceQuery {
  userId: string;
  /** undefined = 该用户全部策略。 */
  policyId?: string;
  startDate?: Date;
  endDate?: Date;
  /**
   * 仅导有可验证 canonical 哈希的执行（排除早于哈希采集接线 ADR 0030 的 legacy 行）。
   * 默认 false（导全部，legacy 行以 null 哈希 + manifest 缺口计数呈现）。
   */
  verifiableOnly?: boolean;
}

/**
 * 统一 WHERE（count/preview/query 三处共用，保证语义一致——Codex 审查：否则预览计数会高于实际
 * 导出、已删策略行还会误触发 413）。
 *
 * 用**非相关**子查询排除已删策略：policyId IN (SELECT id FROM Policy WHERE userId=? AND deletedAt
 * IS NULL)。刻意不用相关 EXISTS——drizzle 的 findMany 把主表 alias 成 "executions" 而 db.select 用
 * 原表名 "Execution"，相关子查询里 executions.policyId 会渲染成错误的表引用（真库实测 42P01）。
 * 非相关子查询自包含，与外层 alias 无关，count/preview/query 三处渲染都正确。
 */
function buildConditions(q: EvidenceQuery) {
  const livePolicyIds = db
    .select({ id: policies.id })
    .from(policies)
    .where(and(eq(policies.userId, q.userId), isNull(policies.deletedAt)));

  const conditions = [
    eq(executions.userId, q.userId),
    inArray(executions.policyId, livePolicyIds),
  ];
  if (q.policyId) conditions.push(eq(executions.policyId, q.policyId));
  if (q.startDate) conditions.push(gte(executions.createdAt, q.startDate));
  if (q.endDate) conditions.push(lte(executions.createdAt, q.endDate));
  // 仅可验证：过滤掉缺 canonical 输入哈希的 legacy 行（canonicalInputHash 是「有哈希地基」的代表列）。
  if (q.verifiableOnly) conditions.push(isNotNull(executions.canonicalInputHash));
  return and(...conditions);
}

/**
 * 查询证据行（投影哈希/溯源，排除已删策略，按 createdAt·id 升序保证 bundleHash 确定性）。
 * 超过 EVIDENCE_EXPORT_ROW_LIMIT 抛 EvidenceTooLargeError（调用方转 413）。
 */
export async function queryEvidenceExecutions(q: EvidenceQuery): Promise<EvidenceRow[]> {
  const whereClause = buildConditions(q);

  // 先 count 守卫（避免真拉回超大结果集）。
  const count = await countEvidenceExecutions(q);
  if (count > EVIDENCE_EXPORT_ROW_LIMIT) {
    throw new EvidenceTooLargeError(count, EVIDENCE_EXPORT_ROW_LIMIT);
  }

  const rows = await db.query.executions.findMany({
    where: whereClause,
    orderBy: [asc(executions.createdAt), asc(executions.id)],
    columns: {
      id: true,
      policyId: true,
      policyVersion: true,
      policyVersionRowId: true,
      decision: true,
      canonicalInputHash: true,
      canonicalOutputHash: true,
      traceHash: true,
      canonicalizationVersion: true,
      sourceToolchainId: true,
      runtimeToolchainId: true,
      replayabilityStatus: true,
      replayabilityReasons: true,
      reasonCodes: true,
      source: true,
      durationMs: true,
      createdAt: true,
      outcome: true,
      ruleId: true,
      controls: true,
      agent: true,
      evidenceCorrelationId: true,
      // metadata 只为取 guardDecisionId，不进 entry。
      metadata: true,
      // ⚠️ 故意不选 input/output/traceJson——证据包=哈希/溯源清单，非明文数据 dump（PII）。
    },
    // 已删策略的执行由 buildConditions 的 EXISTS 子查询在 SQL 层排除，无需应用层再过滤。
    // 收据按策略所属租户查询（与 aster-api 的 X-Tenant-Id 口径一致：teamId ?? userId）。
    with: { policy: { columns: { teamId: true, userId: true } } },
  });

  return rows
    .map((r) => ({
      id: r.id,
      policyId: r.policyId,
      policyVersion: r.policyVersion,
      policyVersionRowId: r.policyVersionRowId,
      decision: r.decision as EvidenceDecision | null,
      canonicalInputHash: r.canonicalInputHash,
      canonicalOutputHash: r.canonicalOutputHash,
      traceHash: r.traceHash,
      canonicalizationVersion: r.canonicalizationVersion,
      sourceToolchainId: r.sourceToolchainId,
      runtimeToolchainId: r.runtimeToolchainId,
      replayabilityStatus: r.replayabilityStatus,
      replayabilityReasons: r.replayabilityReasons,
      reasonCodes: r.reasonCodes,
      source: r.source,
      durationMs: r.durationMs,
      createdAt: r.createdAt,
      outcome: r.outcome,
      ruleId: r.ruleId,
      controls: r.controls ?? null,
      // agent 由写入侧（ADR 0041 §4）校验后落库，这里只做类型收窄。
      agent: (r.agent as EvidenceAgent | null) ?? null,
      evidenceCorrelationId: r.evidenceCorrelationId,
      policyTenantId: r.policy.teamId ?? r.policy.userId,
      guardDecisionId: guardDecisionIdOf(r.metadata),
    }));
}

/** 取 metadata.guardDecisionId；非字符串或缺省一律 null。 */
function guardDecisionIdOf(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const v = (metadata as Record<string, unknown>).guardDecisionId;
  return typeof v === 'string' && v !== '' ? v : null;
}

/** 统计范围内执行数（已排除已删策略；与 query 层同一 WHERE，作 count 上限守卫）。 */
export async function countEvidenceExecutions(q: EvidenceQuery): Promise<number> {
  const r = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(executions)
    .where(buildConditions(q));
  return r[0]?.count ?? 0;
}

/**
 * 导出前预览：count + decision 分布 + **哈希覆盖率**（有/无可验证 canonical 哈希的条数）。
 * 覆盖率让用户看清「这批里多少条真有证据」——早于哈希采集接线（ADR 0030）的 legacy 执行没有哈希，
 * 导出会全 null。exceedsLimit 让 UI 提前拦。decision=null（legacy）计入 unknown 桶。
 */
export async function getEvidencePreview(q: EvidenceQuery): Promise<EvidencePreview> {
  const rows = await db
    .select({
      decision: executions.decision,
      // 该 decision 桶里有可验证哈希的条数（canonicalInputHash 非空）。
      withHash: sql<number>`count(*) FILTER (WHERE ${executions.canonicalInputHash} IS NOT NULL)::int`,
      count: sql<number>`count(*)::int`,
    })
    .from(executions)
    .where(buildConditions(q))
    .groupBy(executions.decision);

  const tally: DecisionTally = { ...EMPTY_TALLY };
  let count = 0;
  let withHash = 0;
  for (const r of rows) {
    const key: keyof DecisionTally = (r.decision as EvidenceDecision | null) ?? 'unknown';
    tally[key] += r.count;
    count += r.count;
    withHash += r.withHash;
  }

  return {
    count,
    decisionTally: tally,
    // 哈希覆盖率：verifiable=有 canonical 哈希（真证据）；legacy=无（早于 ADR 0030 采集）。
    coverage: { verifiable: withHash, legacy: count - withHash },
    exceedsLimit: count > EVIDENCE_EXPORT_ROW_LIMIT,
    limit: EVIDENCE_EXPORT_ROW_LIMIT,
  };
}
