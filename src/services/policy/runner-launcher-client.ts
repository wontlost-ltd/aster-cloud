import { signRunnerLauncherHeaders } from '@/lib/api-signing';

/** runner endpoint 收的请求（= RunnerRequest schema ②，与 runner main 逐字对齐）。 */
export interface RunnerLaunchParams {
  tenantId: string;
  source: string;
  input: Record<string, unknown> | unknown[];
  locale: string;
  functionName: string;
  aliasSet: Record<string, string[]> | null;
  /** 版本的领域词汇（DomainVocabulary JSON，ADR 0051）：名称按位置解析所需，两侧须用同一份。 */
  vocabulary?: Record<string, unknown>;
  role: string;
}

/** launcher 回传的 ReplayMetadata（5 个 replay-critical 字段 + 可选 runtimeToolchainId 诊断）。 */
export interface LaunchReplayMetadata {
  canonicalInputHash: string | null;
  canonicalOutputHash: string | null;
  canonicalizationVersion: string | null;
  replayabilityStatus: string | null;
  traceHash: string | null;
  runtimeToolchainId?: string | null; // 仅诊断，不进 parity 比对
}

/** launchRunnerJob 结果：成功 / runner 业务错 / 不可达。★按 outcome 分类，非 HTTP status。 */
export type RunnerLaunchOutcome =
  | { ok: true; replayMetadata: LaunchReplayMetadata }
  | { ok: false; kind: 'runner-error'; errorCode: string; message: string; phase: string }
  | { ok: false; kind: 'unavailable'; reason: string };

const LAUNCH_PATH = '/api/v1/runner/launch';

/** ★不会二次抛出的错误消息提取（e.message getter/Symbol.toPrimitive 可能抛——Codex 抓）。 */
function safeErrorMessage(e: unknown): string {
  try {
    if (e instanceof Error) return e.message;
    return String(e);
  } catch {
    return 'unknown error';   // e.message getter 或 toString/toPrimitive 抛时兜底
  }
}

/**
 * 调 runner-launcher endpoint 跑一次 replay，收 ReplayMetadata。★首版 endpoint 由
 * ASTER_RUNNER_LAUNCHER_URL 配（Slice-2a 指 stub/local，Slice-2b 切真 launcher）。
 * 独立 HMAC key（signRunnerLauncherHeaders）。任何失败归 unavailable/runner-error，不抛。
 */
export async function launchRunnerJob(params: RunnerLaunchParams): Promise<RunnerLaunchOutcome> {
  // ★整个函数体裹在单一 try——「任何失败均归 unavailable、绝不 reject」的绝对契约：
  //   AbortController/setTimeout 构造、JSON.stringify、签名、fetch、json() 全在 try 内；
  //   catch 用 safeErrorMessage（不会二次抛）。finally 清 timer（timer 声明在 try 外以便 finally 访问，
  //   但仅 `let timer` 声明不会抛）。
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const baseUrl = process.env.ASTER_RUNNER_LAUNCHER_URL;
    if (!baseUrl) return { ok: false, kind: 'unavailable', reason: 'ASTER_RUNNER_LAUNCHER_URL 未配置' };
    const timeoutMs = Number(process.env.ASTER_RUNNER_LAUNCHER_TIMEOUT ?? '30000');

    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);

    // input 含循环引用等 JSON.stringify 会抛 TypeError；签名缺 key/WebCrypto 会抛——全在 try 内归 unavailable。
    const body = JSON.stringify({
      tenantId: params.tenantId, source: params.source, input: params.input,
      locale: params.locale, functionName: params.functionName, aliasSet: params.aliasSet,
      ...(params.vocabulary ? { vocabulary: params.vocabulary } : {}),
    });
    const headers = await signRunnerLauncherHeaders('POST', LAUNCH_PATH, body, params.tenantId, params.role);
    (headers as Record<string, string>)['Content-Type'] = 'application/json';
    const resp = await fetch(`${baseUrl}${LAUNCH_PATH}`, {
      method: 'POST', headers, body, signal: controller.signal,
    });
    if (!resp.ok) return { ok: false, kind: 'unavailable', reason: `HTTP ${resp.status}` };
    const env = await resp.json() as {
      outcome: string; replayMetadata?: LaunchReplayMetadata;
      errorCode?: string; message?: string; phase?: string;
    };
    if (env.outcome === 'SUCCESS' && env.replayMetadata) {
      return { ok: true, replayMetadata: env.replayMetadata };
    }
    // ★runner 业务错是 outcome:"ERROR" 的 200——按 outcome 分类，非 HTTP status。
    return { ok: false, kind: 'runner-error',
      errorCode: env.errorCode ?? 'UNKNOWN', message: env.message ?? '', phase: env.phase ?? '' };
  } catch (e) {
    // 网络/超时（AbortError）/序列化/签名/任何抛 → 不可达。★绝不抛（safeErrorMessage 不会二次抛）。
    return { ok: false, kind: 'unavailable', reason: safeErrorMessage(e) };
  } finally {
    // ★clearTimeout 也裹 try——finally 里抛出会覆盖已算好的返回值（绝对不 reject 契约的最后一环，Codex）。
    try { if (timer !== undefined) clearTimeout(timer); } catch { /* 忽略——不可让 cleanup 破坏返回契约 */ }
  }
}
