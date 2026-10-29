import { launchRunnerJob, type RunnerLaunchParams, type LaunchReplayMetadata, type RunnerLaunchOutcome } from './runner-launcher-client';
import { createPolicyApiClient } from './policy-api';

/**
 * parity 验证结果：5 变体判别联合。★字段名逐字对齐 spec 锁定契约（`status`/`divergentFields`，
 * 非 kind/fields）。★不喂 signability gate，仅返回 + 结构化 log。
 */
export type RunnerParityResult =
  | { status: 'match' }
  | { status: 'divergent'; divergentFields: Array<'canonicalInputHash'|'canonicalOutputHash'|'canonicalizationVersion'|'replayabilityStatus'|'traceHash'> }
  | { status: 'runner-unavailable'; reason: string }    // B 不可达/超时/HMAC 拒
  | { status: 'runner-error'; errorCode: string; phase: string; message: string } // B 返 outcome:ERROR
  | { status: 'authority-failure'; reason: string };    // 权威侧自身失败 / 缺 metadata（parity 不可判）

export interface RunnerParityParams extends RunnerLaunchParams {
  actorUserId: string;
}

/** parity 比对的 5 字段（排除 runtimeToolchainId）。 */
const PARITY_FIELDS = [
  'canonicalInputHash', 'canonicalOutputHash', 'canonicalizationVersion',
  'replayabilityStatus', 'traceHash',
] as const;

type ParityField = (typeof PARITY_FIELDS)[number];

/**
 * 权威侧 A：aster-api 生产 evaluateSource(replayCapture=true) 产 ReplayMetadata。
 * ★包一层便于测试桩；不改生产 evaluateForCapture 本体。
 */
export async function callAuthorityForParity(params: RunnerParityParams): Promise<LaunchReplayMetadata> {
  const client = createPolicyApiClient(params.tenantId, params.actorUserId);
  const resp = await client.evaluateSource(params.source, params.input, {
    locale: params.locale, functionName: params.functionName, aliasSet: params.aliasSet,
    ...(params.vocabulary ? { vocabulary: params.vocabulary } : {}),
    replayCapture: true,
  });
  const rm = resp.replayMetadata;
  return {
    canonicalInputHash: rm?.canonicalInputHash ?? null,
    canonicalOutputHash: rm?.canonicalOutputHash ?? null,
    canonicalizationVersion: rm?.canonicalizationVersion ?? null,
    replayabilityStatus: rm?.replayabilityStatus ?? null,
    traceHash: rm?.traceHash ?? null,
    runtimeToolchainId: rm?.runtimeToolchainId ?? null,
  };
}

/**
 * 独立 parity 验证入口（internal service 非 route）：并行发权威侧 A + runner 侧 B，
 * per-field 比对 5 字段（排除 runtimeToolchainId）。★失败隔离：runner 失败绝不影响权威侧；
 * 权威侧失败归 authority-failure（parity 不可判）。不喂 signability gate。
 */
export async function runRunnerParityCheck(
  params: RunnerParityParams,
  // ★ESM 可注入 seam（Codex 抓——不能 spy 同模块词法绑定；把权威侧作依赖注入便于测试桩）。
  //   默认用真实 callAuthorityForParity；测试传入桩。
  deps: { authority?: (p: RunnerParityParams) => Promise<LaunchReplayMetadata>;
          launch?: typeof launchRunnerJob } = {},
): Promise<RunnerParityResult> {
  const authorityFn = deps.authority ?? callAuthorityForParity;
  const launchFn = deps.launch ?? launchRunnerJob;

  // 并行两路。★权威侧独立 catch（其失败 = authority-failure）；runner 侧 launchFn 契约保证不抛，
  //   但 parity 层仍加防御性 catch（防未来 launch 实现 regress 抛出——Codex 抓的 promise rejection 防御）。
  const [authoritySettled, runnerOutcome] = await Promise.all([
    authorityFn(params).then(
      (rm) => ({ ok: true as const, rm }),
      (e) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }),
    ),
    launchFn(params).catch(
      (e): RunnerLaunchOutcome => ({ ok: false, kind: 'unavailable', reason: e instanceof Error ? e.message : String(e) }),
    ),
  ]);

  const result = resolveParity(authoritySettled, runnerOutcome);
  // ★结构化 log（spec 要求「返回 + 结构化 log」）——parity 结果记日志供审计/诊断，不喂 gate。
  console.log(JSON.stringify({ event: 'runner_parity_check', tenantId: params.tenantId,
    functionName: params.functionName, locale: params.locale, ...result }));
  return result;
}

/** 纯函数：由两路结果推导 RunnerParityResult（便于单测直接验判别逻辑）。 */
function resolveParity(
  authority: { ok: true; rm: LaunchReplayMetadata } | { ok: false; reason: string },
  runner: RunnerLaunchOutcome,
): RunnerParityResult {
  if (!authority.ok) return { status: 'authority-failure', reason: authority.reason };
  // ★权威侧 200 但缺任一 replay-critical metadata 字段 → parity 不可判 = authority-failure（非 match）。
  //   检查全 5 字段（不只 input/output）：任一为 null 则权威侧未产完整 metadata，比对无意义。
  const missing = PARITY_FIELDS.filter((f: ParityField) => authority.rm[f] == null);
  if (missing.length > 0) {
    return { status: 'authority-failure', reason: `权威侧缺 metadata 字段: ${missing.join(',')}（parity 不可判）` };
  }
  if (!runner.ok) {
    return runner.kind === 'unavailable'
      ? { status: 'runner-unavailable', reason: runner.reason }
      : { status: 'runner-error', errorCode: runner.errorCode, phase: runner.phase, message: runner.message };
  }
  // 两路都成功 → per-field 比 5 字段值（非字面 envelope 字节）。
  const A = authority.rm, B = runner.replayMetadata;
  const diverged = PARITY_FIELDS.filter((f: ParityField) => A[f] !== B[f]);
  return diverged.length === 0
    ? { status: 'match' }
    : { status: 'divergent', divergentFields: [...diverged] };
}
