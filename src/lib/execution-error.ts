/**
 * 策略执行失败的对外脱敏。
 *
 * 引擎执行失败（engineError）时 aster-api 返回的原文形如
 * `CNL 动态执行失败: Polyglot 执行失败: java.lang.RuntimeException: …`：语言固定为中文且暴露
 * 内部实现（Java 异常类、Polyglot）。对用户只给稳定错误码 + 通用说明（前端按码本地化），
 * 原文只写服务端日志。诊断（diagnostics）同理：保留稳定 code 与候选项，含内部实现痕迹的
 * message 替换为通用说明。
 */

/** 执行失败的稳定错误码（前端据此显示本地化文案）。 */
export const EXECUTION_FAILED_CODE = 'execution_failed';

/** 无本地化上下文时（API 直读、执行日志）展示的通用说明。 */
export const EXECUTION_FAILED_MESSAGE =
  'Policy execution failed. Check that the input fields match the policy and try again.';

/**
 * 内部实现痕迹：JVM/Graal 包名或异常类、Polyglot、栈帧、源码文件路径。
 * 命中即视为不可对外展示；CNL 语法诊断（行列 + 说明）不含这些痕迹，原样保留。
 */
const INTERNAL_DETAIL = new RegExp(
  [
    String.raw`\b(?:java|javax|jdk|sun|org\.graalvm|com\.oracle|io\.aster|aster)\.[\w$]+\.[\w.$]+`,
    String.raw`\b[A-Z]\w*Exception\b`,
    String.raw`Polyglot`,
    String.raw`\bat [\w.$<>]+\([\w.]*:\d+\)`,
    String.raw`(?:^|[\s(])/[\w.-]+(?:/[\w.-]+)+`,
  ].join('|'),
);

interface DiagnosticLike {
  code: string;
  message: string;
  candidates?: string[];
}

interface EngineResultLike {
  deniedReasons: string[];
  metadata: { engineError?: boolean };
  diagnostics?: DiagnosticLike[];
}

/** 单条诊断是否带内部实现细节。 */
export function hasInternalDetail(text: string | undefined | null): boolean {
  return typeof text === 'string' && INTERNAL_DETAIL.test(text);
}

/** 对外文本：带内部实现细节时换成通用说明，否则原样（如 CNL 语法错误，作者改源码需要它）。 */
export function publicErrorText(text: string): string {
  return hasInternalDetail(text) ? EXECUTION_FAILED_MESSAGE : text;
}

/** 诊断脱敏：保留 code/candidates，内部细节 message 换成通用说明。无需改动时返回原数组。 */
export function sanitizeDiagnostics(diagnostics: DiagnosticLike[] | undefined): DiagnosticLike[] | undefined {
  if (!diagnostics?.some((d) => hasInternalDetail(d.message))) return diagnostics;
  return diagnostics.map((d) =>
    hasInternalDetail(d.message) ? { ...d, message: EXECUTION_FAILED_MESSAGE } : d,
  );
}

/**
 * 对外脱敏执行结果：引擎失败时失败原因换成通用说明；诊断里的内部细节同样替换。
 * 有改动时把原文记入服务端日志；无需改动时原样返回。不修改入参。
 */
export function sanitizeExecutionResult<T extends EngineResultLike>(
  result: T,
  logContext: Record<string, unknown>,
): T {
  const engineError = result.metadata.engineError === true;
  const diagnostics = sanitizeDiagnostics(result.diagnostics);
  if (!engineError && diagnostics === result.diagnostics) return result;
  console.error('[policy-execute] engine error', {
    ...logContext,
    reasons: result.deniedReasons,
    diagnostics: result.diagnostics,
  });
  return {
    ...result,
    deniedReasons: engineError ? [EXECUTION_FAILED_MESSAGE] : result.deniedReasons,
    ...(result.diagnostics ? { diagnostics } : {}),
  };
}

/** 执行结果对应的错误码：仅引擎失败时有值。 */
export function executionErrorCode(result: EngineResultLike): string | undefined {
  return result.metadata.engineError ? EXECUTION_FAILED_CODE : undefined;
}
