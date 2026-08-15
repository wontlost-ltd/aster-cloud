// src/lib/policy-execution-log.ts
// 策略执行日志服务：查询、分页、统计

import { db, executions } from '@/lib/prisma';
import { eq, and, gte, lte, desc, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { PolicyReplayMetadata, PolicyTraceSkeleton } from '@/services/policy/policy-api';

/** 回放捕获里程碑（M1）——只落漂移检测地基 hash，trace 明文 payload 待 M2 PII envelope。 */
export const REPLAY_CAPTURE_MILESTONE_M1 = 'p0a.m1';
/**
 * REPLAYABLE 行的诊断（**非**不可回放原因）：本行有可信「重求值」回放路径（P0-A M1 用），但尚无 M2
 * 完整自包含加密 capture（replayPayload*）。放在 reasons 里供审计区分「M1 重求值可回放」vs「M2 完整 capture」。
 * ★Codex 复审：与旧 REPLAY_PAYLOAD_NOT_CAPTURED_M1 语义分开——那个易被误读为「不可回放」。
 */
export const FULL_CAPTURE_PAYLOAD_NOT_CAPTURED_M1 = 'FULL_CAPTURE_PAYLOAD_NOT_CAPTURED_M1';
/** 行级回放完整性状态。 */
export const STATUS_REPLAYABLE = 'REPLAYABLE';
export const STATUS_NON_REPLAYABLE = 'NON_REPLAYABLE';

/** 缺项机器可读码（NON_REPLAYABLE reasons 用，固定顺序，全记不止第一个）。 */
export const REPLAY_MISSING_REASONS = {
  BACKEND_STATUS_NOT_REPLAYABLE: 'BACKEND_STATUS_NOT_REPLAYABLE',
  MISSING_TRACE_HASH: 'MISSING_TRACE_HASH',
  MISSING_CANONICAL_INPUT_HASH: 'MISSING_CANONICAL_INPUT_HASH',
  MISSING_CANONICAL_OUTPUT_HASH: 'MISSING_CANONICAL_OUTPUT_HASH',
  MISSING_CANONICALIZATION_VERSION: 'MISSING_CANONICALIZATION_VERSION',
  MISSING_RUNTIME_TOOLCHAIN_ID: 'MISSING_RUNTIME_TOOLCHAIN_ID',
  MISSING_SOURCE_TOOLCHAIN_ID: 'MISSING_SOURCE_TOOLCHAIN_ID',
  MISSING_POLICY_VERSION_ROW_ID: 'MISSING_POLICY_VERSION_ROW_ID',
  MISSING_FUNCTION_NAME: 'MISSING_FUNCTION_NAME',
  MISSING_LOCALE: 'MISSING_LOCALE',
} as const;

/** 非空且 trim 后非空白。 */
function nonBlank(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * 回放列取值（ADR 0030 附录 A）——把 aster-api 的 replayMetadata + 不可变 PolicyVersion 字段
 * 映射成 Execution 回放列的 insert 片段。两个 execute 写路径共用，保证口径一致。
 *
 * <p><b>语义（M2.1b 后修正，Codex 设计审 88）：</b>本里程碑落「漂移检测地基」（canonical hash + trace
 * hash + 工具链 + status/reasons），**不**落 trace 明文 / replayPayload*（PII envelope 待 M2 KMS）。
 * <ul>
 *   <li><b>replayCaptureVersion 留 null</b>——schema 不变式「replayCaptureVersion 非空→其余 payload 列
 *       全 set」（单向蕴含）。replayCaptureVersion 专表「M2 完整自包含加密 capture」（M2 才置），与
 *       replayabilityStatus 是**两条独立轴**：REPLAYABLE 不要求 replayCaptureVersion 非空。</li>
 *   <li><b>replayabilityStatus 行级由 gate 判</b>（M2.1b 后行级确实可回放，非恒 NON_REPLAYABLE）——
 *       后端判 REPLAYABLE **且** freeze 所需字段（traceHash / canonicalInput+OutputHash /
 *       canonicalizationVersion / runtime+sourceToolchainId / policyVersionRowId / functionName /
 *       locale）全非空白 → REPLAYABLE；否则 NON_REPLAYABLE + 全部缺项机器码。★REPLAYABLE=有可信
 *       「从冻结 input 重求值」的 P0-A 回放路径（M1 run 不读 replayPayload），≠「M2 完整 capture」。</li>
 *   <li>REPLAYABLE 行 reasons 追加 {@link FULL_CAPTURE_PAYLOAD_NOT_CAPTURED_M1}（capture 局限诊断，
 *       **非**不可回放原因）；NON_REPLAYABLE 追加 {@link REPLAY_MISSING_REASONS} 全部缺项。</li>
 *   <li>replayPayload* / traceJson / piiRetentionUntil / piiPolicyVersion 全 null（M2 才落）。</li>
 * </ul>
 *
 * <p>replayMetadata 缺失（未开 capture / 后端未返回）→ 回放列全 null，status=**null**（「未捕获」≠
 * 「已评估但不满足」，两者都被 freeze 排除但审计语义不同）。不阻断 Execution 写入（执行成功就该记录）。
 *
 * <p>★注意：通用 {@code createExecutionLog()} **不**经本 builder（legacy/non-capture writer，回放列全 null），
 * 故不会误标 REPLAYABLE；正式 capture 只走 dashboard execute + v1 API execute 两路径（共用本 builder）。
 */
export interface ReplayVersionRefs {
  /** 不可变 PolicyVersion 行 id（Execution.policyVersionRowId）。 */
  policyVersionRowId: string | null;
  /** 人类可读的策略版本号（Policy.version / PolicyVersion.version）。证据包给审计员看「第几版」，
   *  而非只有 UUID。执行时已 JOIN 到该值，随手带上即可。 */
  policyVersion: number | null;
  /** PolicyVersion.sourceToolchainId（envelope 编译工具链）。 */
  sourceToolchainId: string | null;
  /** PolicyVersion.vocabularySnapshotIds（不可变引用）。 */
  vocabSnapshotRef: unknown;
  /** 执行时实际 locale。 */
  locale: string | null;
  /** 冻结 aliasSet（无别名传 {} 非 null；未捕获传 null）。 */
  aliasSetJson: unknown;
  /** 实际执行的 function 名。 */
  functionName: string | null;
}

/** Execution 回放列 insert 片段（drizzle 列名）。 */
export interface ExecutionReplayColumns {
  policyVersionRowId: string | null;
  /** 人类可读版本号（Execution.policyVersion）。总是可填（不依赖 replayMetadata）。 */
  policyVersion: number | null;
  functionName: string | null;
  locale: string | null;
  aliasSetJson: unknown;
  vocabSnapshotRef: unknown;
  sourceToolchainId: string | null;
  runtimeToolchainId: string | null;
  reasonCodes: unknown;
  traceJson: unknown;
  /**
   * 决策骨架（Phase 0）。★与 traceJson 不同轴：后者含业务值待 M2 PII envelope，
   * 骨架结构上无值，故可常态落库。
   */
  traceSkeletonJson: unknown;
  traceHash: string | null;
  canonicalInputHash: string | null;
  canonicalOutputHash: string | null;
  canonicalizationVersion: string | null;
  replayCaptureVersion: string | null;
  replayabilityStatus: string | null;
  replayabilityReasons: unknown;
  replayPayloadCiphertext: string | null;
  replayPayloadAlg: string | null;
  replayPayloadKeyId: string | null;
  replayPayloadNonce: string | null;
  replayPayloadHash: string | null;
  piiRetentionUntil: Date | null;
  piiPolicyVersion: string | null;
}

/**
 * 把决策骨架**按白名单重建**，只保留结构上允许的字段。
 *
 * <p>★这是 PII 边界的**运行时**执行点，不是类型断言。aster-api 侧的
 * `TraceSkeleton.SkeletonStep` 通过「没有 result 字段」做结构性保证，但那条保证
 * 止于 JVM 边界：跨服务后是一段 JSON，`response.json()` 产出的是普通对象，
 * TypeScript 的 interface 在运行时**不存在**、不会剥离任何多余字段。
 *
 * <p>所以这里不做「校验 + 放行原对象」（那样多余字段仍会跟着走），而是
 * **只挑出已知字段拼一个新对象**。上游无论多出什么（`result`、`inputs`、
 * 调试字段），都不可能进入落库对象——白名单之外的一切默认丢弃。
 *
 * <p>丢弃是静默的：骨架是分析用的辅助数据，不该因为上游多塞字段就让整条
 * 执行记录写入失败。真正的风险是「悄悄多写」，不是「悄悄少写」。
 */
export function projectTraceSkeleton(input: PolicyTraceSkeleton): PolicyTraceSkeleton {
  const rawSteps = Array.isArray(input?.steps) ? input.steps : [];
  return {
    schemaVersion: String(input?.schemaVersion ?? ''),
    moduleName: input?.moduleName ?? null,
    functionName: input?.functionName ?? null,
    steps: rawSteps.map((s) => ({
      stepId: String(s?.stepId ?? ''),
      expression: String(s?.expression ?? ''),
      matched: Boolean(s?.matched),
      depth: Number.isFinite(s?.depth) ? Number(s.depth) : 0,
    })),
  };
}

/**
 * 构建 Execution 回放列（M1）。见 {@link ReplayVersionRefs} doc 的 M1 语义。
 */
export function buildReplayColumns(
  replay: PolicyReplayMetadata | undefined,
  refs: ReplayVersionRefs,
  /**
   * 决策骨架（Phase 0，可选）。★独立于 replay 参数：骨架不含业务值，
   * 即便 replayMetadata 缺失（未开 capture）也应落库——它是零 PII 成本的分析地基。
   */
  traceSkeleton?: PolicyTraceSkeleton
): ExecutionReplayColumns {
  // 版本引用列总是可填（不依赖 replayMetadata）——即使未开 capture，记录执行时的不可变版本引用
  // 仍有审计价值。回放 hash 列则依赖 replayMetadata。
  const base: ExecutionReplayColumns = {
    policyVersionRowId: refs.policyVersionRowId,
    policyVersion: refs.policyVersion,
    functionName: refs.functionName,
    locale: refs.locale,
    aliasSetJson: refs.aliasSetJson,
    vocabSnapshotRef: refs.vocabSnapshotRef ?? null,
    sourceToolchainId: refs.sourceToolchainId,
    runtimeToolchainId: null,
    reasonCodes: null,
    traceJson: null,
    traceSkeletonJson: null,
    traceHash: null,
    canonicalInputHash: null,
    canonicalOutputHash: null,
    canonicalizationVersion: null,
    // ★M1 留 null（见 doc）：不假装完整 capture。
    replayCaptureVersion: null,
    replayabilityStatus: null,
    replayabilityReasons: null,
    replayPayloadCiphertext: null,
    replayPayloadAlg: null,
    replayPayloadKeyId: null,
    replayPayloadNonce: null,
    replayPayloadHash: null,
    piiRetentionUntil: null,
    piiPolicyVersion: null,
  };

  // ★骨架在 replay 早退之前赋值：它与 replayMetadata 是**独立的两条轴**。
  // 骨架不含任何业务值，即便未开 replay capture（replay 为 undefined）也应落库——
  // 否则条件漏斗的样本会被 capture 开关白白砍掉一大块，而那个开关管的是 PII，
  // 与骨架无关。
  //
  // ★必须走 projectTraceSkeleton 白名单重建，不能直接赋值上游对象：
  // TypeScript 的 interface 只在编译期存在，运行时不会剥离多余字段。上游一次回归、
  // 版本漂移或异常响应，业务值就会随对象整体落进 traceSkeletonJson——而这一列
  // 不受 replayRetentionEnabled 管辖，等于绕过 PII 保留策略永久留存。
  if (traceSkeleton) {
    base.traceSkeletonJson = projectTraceSkeleton(traceSkeleton);
  }

  // ★replayMetadata 缺失（未开 capture / 后端未返回）→ 回放列全 null，status=**null**（不是
  // NON_REPLAYABLE）。「未捕获/未评估」与「已评估但不满足」审计语义不同（Codex 复审）；两者都会被
  // freeze 排除（谓词要 = 'REPLAYABLE'）。
  if (!replay) {
    return base;
  }

  // ★行级 replayabilityStatus（M2.1b 后修正陈旧）：REPLAYABLE 表示「本行有可信『从冻结 input 重求值』的
  // P0-A 回放路径」——**不**等于「已形成 M2 完整自包含加密 capture」（那由 replayCaptureVersion 表达）。
  // M1 run 从 RegressionCase.inputJson 重求值比 hash，**不读 replayPayload**，故 payload=null 时仍可 REPLAYABLE。
  // 门（全满足才 REPLAYABLE，否则 NON_REPLAYABLE + 全部缺项码）：后端判 REPLAYABLE + freeze 所需字段齐全。
  // ★后端 `replayable` 判定 `(trace==null||...)`/`(input==null||...)` 在无 trace/input 时也算 REPLAYABLE——
  // 故 cloud 侧独立硬 gate traceHash/canonicalInputHash 等非空，挡住后端宽松态（Codex 复审）。
  const missing: string[] = [];
  if (replay.replayabilityStatus !== STATUS_REPLAYABLE)
    missing.push(REPLAY_MISSING_REASONS.BACKEND_STATUS_NOT_REPLAYABLE);
  if (!nonBlank(replay.traceHash)) missing.push(REPLAY_MISSING_REASONS.MISSING_TRACE_HASH);
  if (!nonBlank(replay.canonicalInputHash)) missing.push(REPLAY_MISSING_REASONS.MISSING_CANONICAL_INPUT_HASH);
  if (!nonBlank(replay.canonicalOutputHash)) missing.push(REPLAY_MISSING_REASONS.MISSING_CANONICAL_OUTPUT_HASH);
  if (!nonBlank(replay.canonicalizationVersion)) missing.push(REPLAY_MISSING_REASONS.MISSING_CANONICALIZATION_VERSION);
  if (!nonBlank(replay.runtimeToolchainId)) missing.push(REPLAY_MISSING_REASONS.MISSING_RUNTIME_TOOLCHAIN_ID);
  if (!nonBlank(refs.sourceToolchainId)) missing.push(REPLAY_MISSING_REASONS.MISSING_SOURCE_TOOLCHAIN_ID);
  if (!nonBlank(refs.policyVersionRowId)) missing.push(REPLAY_MISSING_REASONS.MISSING_POLICY_VERSION_ROW_ID);
  if (!nonBlank(refs.functionName)) missing.push(REPLAY_MISSING_REASONS.MISSING_FUNCTION_NAME);
  if (!nonBlank(refs.locale)) missing.push(REPLAY_MISSING_REASONS.MISSING_LOCALE);

  const isReplayable = missing.length === 0;

  // reasons：保留后端 reasons + backend_status 追溯；REPLAYABLE 追加 capture-limitation 诊断，
  // NON_REPLAYABLE 追加全部缺项码。去重、稳定序。
  const backendReasons = Array.isArray(replay.replayabilityReasons) ? replay.replayabilityReasons : [];
  const reasonSet = new Set<string>([...backendReasons]);
  if (replay.replayabilityStatus) reasonSet.add(`backend_status=${replay.replayabilityStatus}`);
  if (isReplayable) {
    reasonSet.add(FULL_CAPTURE_PAYLOAD_NOT_CAPTURED_M1);
  } else {
    for (const m of missing) reasonSet.add(m);
  }

  return {
    ...base,
    runtimeToolchainId: replay.runtimeToolchainId ?? null,
    reasonCodes: Array.isArray(replay.reasonCodes) ? replay.reasonCodes : null,
    traceHash: replay.traceHash ?? null,
    canonicalInputHash: replay.canonicalInputHash ?? null,
    canonicalOutputHash: replay.canonicalOutputHash ?? null,
    canonicalizationVersion: replay.canonicalizationVersion ?? null,
    // ★replayCaptureVersion 仍 null（M2 完整 capture 才置——schema 不变量「非空须全 payload」不破坏）。
    replayabilityStatus: isReplayable ? STATUS_REPLAYABLE : STATUS_NON_REPLAYABLE,
    replayabilityReasons: [...reasonSet],
  };
}

type ExecutionSource = InferSelectModel<typeof executions>['source'];
type ExecutionDecision = InferSelectModel<typeof executions>['decision'];

export interface ExecutionLogItem {
  id: string;
  policyId: string;
  policyName: string;
  policyVersion: number | null;
  input: unknown;
  output: unknown;
  error: string | null;
  success: boolean;
  /** 准入决策语义（approved/denied/indeterminate/error）。历史行为 null。 */
  decision: ExecutionDecision;
  durationMs: number;
  source: ExecutionSource;
  metadata: unknown;
  createdAt: Date;
  /** runner-parity 影子校验状态（null=未跑；match|divergent|runner-unavailable|runner-error|authority-failure）。 */
  runnerParityStatus: string | null;
}

export interface ExecutionLogQuery {
  userId: string;
  policyId?: string;
  success?: boolean;
  /** 按准入决策过滤（可选）。 */
  decision?: ExecutionDecision;
  source?: ExecutionSource;
  startDate?: Date;
  endDate?: Date;
  page?: number;
  pageSize?: number;
}

export interface ExecutionLogResult {
  items: ExecutionLogItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ExecutionStats {
  totalExecutions: number;
  successCount: number;
  failureCount: number;
  /** 无决策（值/计算输出，如 greet 返回文本）的执行数——不计入失败。 */
  indeterminateCount: number;
  successRate: number;
  avgDurationMs: number;
  bySource: {
    source: ExecutionSource;
    count: number;
  }[];
  recentTrend: {
    date: string;
    successCount: number;
    failureCount: number;
  }[];
}

/**
 * 查询执行日志（分页）
 */
export async function queryExecutionLogs(query: ExecutionLogQuery): Promise<ExecutionLogResult> {
  const { userId, policyId, success, decision, source, startDate, endDate, page = 1, pageSize = 20 } = query;

  // Build where conditions
  const conditions = [eq(executions.userId, userId)];
  if (policyId) conditions.push(eq(executions.policyId, policyId));
  if (success !== undefined) conditions.push(eq(executions.success, success));
  if (decision) conditions.push(eq(executions.decision, decision));
  if (source) conditions.push(eq(executions.source, source));
  if (startDate) conditions.push(gte(executions.createdAt, startDate));
  if (endDate) conditions.push(lte(executions.createdAt, endDate));

  const whereClause = and(...conditions);

  const [items, totalResult] = await Promise.all([
    db.query.executions.findMany({
      where: whereClause,
      orderBy: [desc(executions.createdAt)],
      offset: (page - 1) * pageSize,
      limit: pageSize,
      with: {
        policy: {
          columns: {
            name: true,
            deletedAt: true,
          },
        },
      },
    }),
    db.select({ count: sql<number>`count(*)::int` })
      .from(executions)
      .where(whereClause),
  ]);

  const total = totalResult[0]?.count || 0;

  // Filter out executions with deleted policies
  const filteredItems = items.filter(item => !item.policy.deletedAt);

  return {
    items: filteredItems.map((item) => ({
      id: item.id,
      policyId: item.policyId,
      policyName: item.policy.name,
      policyVersion: item.policyVersion,
      input: item.input,
      output: item.output,
      error: item.error,
      success: item.success,
      decision: item.decision,
      durationMs: item.durationMs,
      source: item.source,
      metadata: item.metadata,
      createdAt: item.createdAt,
      runnerParityStatus: item.runnerParityStatus ?? null,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

/**
 * 获取单个执行日志详情
 */
export async function getExecutionLogDetail(
  executionId: string,
  userId: string
): Promise<ExecutionLogItem | null> {
  const item = await db.query.executions.findFirst({
    where: and(
      eq(executions.id, executionId),
      eq(executions.userId, userId)
    ),
    with: {
      policy: {
        columns: {
          name: true,
        },
      },
    },
  });

  if (!item) return null;

  return {
    id: item.id,
    policyId: item.policyId,
    policyName: item.policy.name,
    policyVersion: item.policyVersion,
    input: item.input,
    output: item.output,
    error: item.error,
    success: item.success,
    decision: item.decision,
    durationMs: item.durationMs,
    source: item.source,
    metadata: item.metadata,
    createdAt: item.createdAt,
    runnerParityStatus: item.runnerParityStatus ?? null,
  };
}

/**
 * 获取策略执行统计
 */
export async function getExecutionStats(
  userId: string,
  policyId?: string,
  days: number = 30
): Promise<ExecutionStats> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  // Build where conditions
  const conditions = [
    eq(executions.userId, userId),
    gte(executions.createdAt, startDate),
  ];
  if (policyId) conditions.push(eq(executions.policyId, policyId));

  const whereClause = and(...conditions);
  const whereWithSuccess = and(...conditions, eq(executions.success, true));
  // indeterminate（值/计算输出）：执行成功但无 allow/deny 语义，**不应计入失败**。
  const whereIndeterminate = and(...conditions, eq(executions.decision, 'indeterminate'));

  // 基础统计
  const [totalResult, successResult, indeterminateResult, executionsList] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` })
      .from(executions)
      .where(whereClause),
    db.select({ count: sql<number>`count(*)::int` })
      .from(executions)
      .where(whereWithSuccess),
    db.select({ count: sql<number>`count(*)::int` })
      .from(executions)
      .where(whereIndeterminate),
    db.query.executions.findMany({
      where: whereClause,
      columns: {
        success: true,
        decision: true,
        durationMs: true,
        source: true,
        createdAt: true,
      },
      with: {
        policy: {
          columns: {
            deletedAt: true,
          },
        },
      },
    }),
  ]);

  const totalExecutions = totalResult[0]?.count || 0;
  const successCount = successResult[0]?.count || 0;
  const indeterminateCount = indeterminateResult[0]?.count || 0;
  // Filter out executions with deleted policies
  const executionData = executionsList.filter(e => !e.policy.deletedAt);

  // 失败 = 总数 - 通过(approved) - 无决策(indeterminate 值输出)。修复：此前 total-approved
  // 把值输出策略误计入失败。真实拒绝/错误才算失败。successRate 分母排除 indeterminate
  // （值输出不参与"准入通过率"，否则会稀释真实决策的通过率）。
  const failureCount = Math.max(0, totalExecutions - successCount - indeterminateCount);
  const decisionTotal = totalExecutions - indeterminateCount;
  const successRate = decisionTotal > 0 ? (successCount / decisionTotal) * 100 : 0;
  const avgDurationMs =
    executionData.length > 0
      ? executionData.reduce((sum, e) => sum + e.durationMs, 0) / executionData.length
      : 0;

  // 按来源统计
  const sourceStats = new Map<ExecutionSource, number>();
  for (const exec of executionData) {
    sourceStats.set(exec.source, (sourceStats.get(exec.source) || 0) + 1);
  }
  const bySource = Array.from(sourceStats.entries()).map(([source, count]) => ({
    source,
    count,
  }));

  // 最近 7 天趋势
  const trendDays = Math.min(days, 7);
  const trendMap = new Map<string, { successCount: number; failureCount: number }>();

  for (let i = 0; i < trendDays; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().slice(0, 10);
    trendMap.set(dateStr, { successCount: 0, failureCount: 0 });
  }

  for (const exec of executionData) {
    const dateStr = exec.createdAt.toISOString().slice(0, 10);
    if (trendMap.has(dateStr)) {
      const trend = trendMap.get(dateStr)!;
      if (exec.success) {
        trend.successCount++;
      } else if (exec.decision !== 'indeterminate') {
        // 无决策（值输出）不计入失败趋势；真实拒绝/错误才算失败。
        trend.failureCount++;
      }
    }
  }

  const recentTrend = Array.from(trendMap.entries())
    .map(([date, counts]) => ({
      date,
      ...counts,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    totalExecutions,
    successCount,
    failureCount,
    indeterminateCount,
    successRate: Math.round(successRate * 100) / 100,
    avgDurationMs: Math.round(avgDurationMs),
    bySource,
    recentTrend,
  };
}

/**
 * 获取策略的最近执行记录
 */
export async function getRecentExecutions(
  policyId: string,
  userId: string,
  limit: number = 10
): Promise<ExecutionLogItem[]> {
  const items = await db.query.executions.findMany({
    where: and(
      eq(executions.policyId, policyId),
      eq(executions.userId, userId)
    ),
    orderBy: [desc(executions.createdAt)],
    limit,
    with: {
      policy: {
        columns: {
          name: true,
        },
      },
    },
  });

  return items.map((item) => ({
    id: item.id,
    policyId: item.policyId,
    policyName: item.policy.name,
    policyVersion: item.policyVersion,
    input: item.input,
    output: item.output,
    error: item.error,
    success: item.success,
    decision: item.decision,
    durationMs: item.durationMs,
    source: item.source,
    metadata: item.metadata,
    createdAt: item.createdAt,
    runnerParityStatus: item.runnerParityStatus ?? null,
  }));
}

/**
 * 创建执行日志（增强版）
 */
export async function createExecutionLog(data: {
  userId: string;
  policyId: string;
  policyVersion?: number;
  input: unknown;
  output?: unknown;
  error?: string;
  success: boolean;
  durationMs: number;
  source: ExecutionSource;
  metadata?: {
    ipAddress?: string;
    userAgent?: string;
    requestId?: string;
    apiKeyId?: string;
    [key: string]: unknown;
  };
}): Promise<string> {
  const [execution] = await db.insert(executions).values({
    id: crypto.randomUUID(),
    userId: data.userId,
    policyId: data.policyId,
    policyVersion: data.policyVersion ?? null,
    input: data.input as object,
    output: (data.output as object | null) ?? null,
    error: data.error ?? null,
    success: data.success,
    durationMs: data.durationMs,
    source: data.source,
    apiKeyId: (data.metadata?.apiKeyId as string | null) ?? null,
    metadata: (data.metadata as object | null) ?? null,
  }).returning();

  return execution.id;
}

/**
 * ★已删除 `cleanupOldExecutionLogs`（cloud#396）。
 *
 * <p>它自诞生起就**零调用方**——`audit7days`/`audit90days` 只是定价页标签，
 * 没有任何代码执行它，所有档位实际留存都是永久。
 *
 * <p>更要紧的是：它**没有租户过滤、也不看 plan**，
 * 用一个写死的 90 天 cutoff 删**所有租户**的执行日志。
 * 谁要是"顺手"把它接进定时任务，free 档会被按 90 天放宽、
 * enterprise 档会被按 90 天删掉——两头都错。
 *
 * <p>替代者：`lib/retention/execution-retention-gc.ts` 的
 * {@link runExecutionRetentionGc}，按租户 plan 取留存天数、
 * 带 userId 限定、enterprise 显式不限期，
 * 并由 `/api/cron/execution-retention-gc` 每日调用。
 */
