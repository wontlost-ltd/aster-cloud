/**
 * 策略执行失败的对外脱敏。
 *
 * 引擎执行失败（engineError）时 aster-api 返回的原文形如
 * `CNL 动态执行失败: Polyglot 执行失败: java.lang.RuntimeException: …`：语言固定为中文且暴露
 * 内部实现（Java 异常类、Polyglot）。对用户只给稳定错误码 + 通用说明（前端按码本地化），
 * 原文只写服务端日志。
 */

/** 执行失败的稳定错误码（前端据此显示本地化文案）。 */
export const EXECUTION_FAILED_CODE = 'execution_failed';

/** 无本地化上下文时（API 直读、执行日志）展示的通用说明。 */
export const EXECUTION_FAILED_MESSAGE =
  'Policy execution failed. Check that the input fields match the policy and try again.';

interface EngineResultLike {
  deniedReasons: string[];
  metadata: { engineError?: boolean };
}

/**
 * 引擎执行失败时把对外可见的失败原因替换为通用说明，并把原文记入服务端日志；
 * 非引擎失败（正常决策/拒绝理由）原样返回。不修改入参。
 */
export function sanitizeExecutionResult<T extends EngineResultLike>(
  result: T,
  logContext: Record<string, unknown>,
): T {
  if (!result.metadata.engineError) return result;
  console.error('[policy-execute] engine error', { ...logContext, reasons: result.deniedReasons });
  return { ...result, deniedReasons: [EXECUTION_FAILED_MESSAGE] };
}

/** 执行结果对应的错误码：仅引擎失败时有值。 */
export function executionErrorCode(result: EngineResultLike): string | undefined {
  return result.metadata.engineError ? EXECUTION_FAILED_CODE : undefined;
}
