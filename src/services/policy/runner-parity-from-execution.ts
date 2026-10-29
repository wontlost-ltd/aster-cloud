/*
 * runner-parity 接线：从一次已完成的 execution 触发影子校验（PR-3/4）。
 *
 * ★诚实边界铁律：纯附加、log-only、绝不 gate 决策、绝不抛进 execute 路径。本函数由 execute 路由在
 *   ctx.waitUntil 后台调用——用户响应早已返回，parity 慢/失败均不影响用户。
 *
 * ★不双评估：execute 路由已算出权威侧 A 的 replayMetadata（executionResult.metadata.replay）。本函数把
 *   它作为 deps.authority 注入 runRunnerParityCheck，**只真跑 side-B（launcher）**——避免为 parity 再打
 *   一次 aster-api evaluate。
 *
 * ★flag 三模式（管理员可配，PR-1）：off=不跑；sampled=按 sample_pct 概率；every=每次；manual=仅显式
 *   verify-parity endpoint（PR-4）触发，此自动路径 skip。env self-gate 叠加：未配 ASTER_RUNNER_LAUNCHER_URL
 *   时 launchRunnerJob 自返 unavailable（双门）。
 */
import { and, eq } from 'drizzle-orm';
import { db, executions } from '@/lib/prisma';
import { getRunnerParityConfig } from '@/lib/platform-settings';
import { runRunnerParityCheck } from './runner-parity';
import type { RunnerParityResult } from './runner-parity';
import type { LaunchReplayMetadata } from './runner-launcher-client';
import type { PolicyReplayMetadata } from './policy-api';

/**
 * HMAC canonical 的 role 值。★这是 cloud→launcher 的**固定服务身份**，非 actor RBAC role（Codex 审）：
 * launcher 只用它验 HMAC（hmac.go 验签后 `_ = role`），**不进 runner Job / 不改 replay 行为**，故不同
 * actor role 不会造 parity divergent 假阳。用固定值使 side-B replay 确定性（与 authority 侧一致）。
 */
export const RUNNER_LAUNCHER_HMAC_ROLE = 'ADMIN';

/** 把 aster-api 权威侧 PolicyReplayMetadata（全可选）投影为 LaunchReplayMetadata 的 5 字段（缺→null）。 */
function normalizeAuthorityReplay(rm: PolicyReplayMetadata | undefined): LaunchReplayMetadata {
  return {
    canonicalInputHash: rm?.canonicalInputHash ?? null,
    canonicalOutputHash: rm?.canonicalOutputHash ?? null,
    canonicalizationVersion: rm?.canonicalizationVersion ?? null,
    replayabilityStatus: rm?.replayabilityStatus ?? null,
    traceHash: rm?.traceHash ?? null,
    runtimeToolchainId: rm?.runtimeToolchainId ?? null,
  };
}

/** execute 路由触发 parity 所需上下文（全部已在路由作用域内）。字段类型对齐 RunnerLaunchParams。 */
export interface ParityFromExecutionCtx {
  executionId: string;
  tenantId: string;
  actorUserId: string;
  source: string;                              // policy 源码（CNL）
  input: Record<string, unknown> | unknown[];  // 已校验的执行输入（对齐 RunnerLaunchParams.input）
  locale: string;                              // 必填（execute 路由 detectCNLLocale 恒有值）
  functionName: string;                        // 必填（无则传空串——launcher 契约允许）
  aliasSet: Record<string, string[]> | null;   // 对齐 RunnerLaunchParams.aliasSet（null 非 undefined）
  /** 版本的领域词汇（与执行同一份，ADR 0051）；无词汇时省略。 */
  vocabulary?: Record<string, unknown>;
  role: string;                                // HMAC canonical 的 role
  /** ★已在手的权威侧 A replayMetadata（不重跑 aster-api）。传 execute 路由的
   *   executionResult.metadata.replay（PolicyReplayMetadata|undefined），内部归一化为 5 字段。 */
  authorityReplay: PolicyReplayMetadata | undefined;
  /** 随机数注入 seam（测试可控采样决策；默认 Math.random）。 */
  rng?: () => number;
}

/**
 * 自动路径（execute 路由 waitUntil 后台）：按 flag 决定是否跑 parity，跑则用已在手的 side-A 只真跑
 * side-B，结果回写 execution 行。**任何失败都吞掉**（log-only，绝不冒泡）。返回实际跑了的结果或 null（skip）。
 */
export async function maybeRunParityForExecution(
  ctx: ParityFromExecutionCtx,
): Promise<RunnerParityResult | null> {
  try {
    const { mode, samplePct } = await getRunnerParityConfig();
    // manual 只由显式 endpoint 触发；自动路径不跑。
    if (mode === 'off' || mode === 'manual') return null;
    if (mode === 'sampled') {
      const rng = ctx.rng ?? Math.random;
      if (rng() * 100 >= samplePct) return null; // 未命中采样
    }
    // every 或命中采样 → 跑。
    const result = await runParityAndPersist(ctx);
    return result;
  } catch (err) {
    // 铁律：parity 任何失败绝不影响 execute（已返回）。仅结构化 log。
    console.error(JSON.stringify({
      event: 'runner_parity_wiring_error', executionId: ctx.executionId,
      error: err instanceof Error ? err.message : String(err),
    }));
    return null;
  }
}

/**
 * 显式路径（manual verify-parity endpoint，PR-4）：无视 flag 直接跑一次并回写。同样只真跑 side-B。
 * ★返回结果 + persisted（Codex 抓：manual 路径持久化失败须让调用方可见，非静默吞——否则 endpoint
 *   返 200 但徽章不更新，误导管理员以为成功）。
 */
export async function runParityForExecutionNow(
  ctx: ParityFromExecutionCtx,
): Promise<{ result: RunnerParityResult; persisted: boolean }> {
  const result = await runParity(ctx);
  const persisted = await persistParityResult(ctx.executionId, result);
  return { result, persisted };
}

/** 共享核心：注入已在手 side-A → 只真跑 side-B → 结果回写 execution 行（回写失败吞，用于 auto 路径）。 */
async function runParityAndPersist(ctx: ParityFromExecutionCtx): Promise<RunnerParityResult> {
  const result = await runParity(ctx);
  await persistParityResult(ctx.executionId, result); // auto 路径：回写失败吞（log-only）
  return result;
}

/** 只跑 parity（注入 side-A，只真跑 side-B），不回写。 */
async function runParity(ctx: ParityFromExecutionCtx): Promise<RunnerParityResult> {
  return runRunnerParityCheck(
    {
      tenantId: ctx.tenantId,
      actorUserId: ctx.actorUserId,
      source: ctx.source,
      input: ctx.input,
      locale: ctx.locale,
      functionName: ctx.functionName,
      aliasSet: ctx.aliasSet,
      ...(ctx.vocabulary ? { vocabulary: ctx.vocabulary } : {}),
      role: ctx.role,
    },
    // ★注入已在手的权威侧 A（归一化）——runRunnerParityCheck 不重跑 callAuthorityForParity（不双评估 aster-api）。
    { authority: async () => normalizeAuthorityReplay(ctx.authorityReplay) },
  );
}

/** 把 RunnerParityResult 映射到 execution 的 parity 列并 UPDATE。返回是否**真的更新了该行**（失败/0 行仍 log，不抛）。 */
async function persistParityResult(executionId: string, result: RunnerParityResult): Promise<boolean> {
  const divergentFields = result.status === 'divergent' ? result.divergentFields : null;
  try {
    // ★.returning 拿受影响行（Codex 抓：并发删/GC 下 UPDATE 匹配 0 行不抛→须查 affected-rows，
    //   否则误报 persisted:true）。0 行=该 execution 已不存在→persisted:false。
    const updated = await db.update(executions)
      .set({
        runnerParityStatus: result.status,
        runnerParityDivergentFields: divergentFields as object | null,
        runnerParityCheckedAt: new Date(),
      })
      .where(and(eq(executions.id, executionId)))
      .returning({ id: executions.id });
    if (updated.length === 0) {
      console.error(JSON.stringify({
        event: 'runner_parity_persist_norow', executionId, status: result.status,
        reason: 'execution 行不存在（并发删/GC）→ 0 行更新',
      }));
      return false;
    }
    return true;
  } catch (err) {
    console.error(JSON.stringify({
      event: 'runner_parity_persist_error', executionId,
      status: result.status, error: err instanceof Error ? err.message : String(err),
    }));
    return false;
  }
}
