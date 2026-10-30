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
 * 输入缺少规则读取的字段（aster-api 400 missing_input_field）：调用方可修正的输入错误，
 * 不是引擎故障。响应带字段路径（如 `applicant.creditScore`），前端按码 + 路径本地化。
 */
export const MISSING_INPUT_FIELD_CODE = 'missing_input_field';

/** 缺字段的英文说明（无本地化上下文时展示）。文案由 cloud 生成，不转述上游原文。 */
export function missingInputFieldMessage(field: string): string {
  return `The input is missing the field "${field}" that the policy reads. Add it to the input and try again.`;
}

/**
 * 缺字段的 400 响应体（dashboard / v1 / evaluate-source 共用），与 ambiguous_input_field 同一字段语义：
 * `field` 为规范名路径（引擎原样，程序据此识别），`policyField` 为策略语言写法（界面展示用，缺省同 field）。
 */
export function missingInputFieldBody(field: string, policyField: string = field) {
  return { error: missingInputFieldMessage(policyField), code: MISSING_INPUT_FIELD_CODE, field, policyField };
}

/**
 * 内部实现痕迹（命中即不可对外展示）：
 * - 全限定 JVM 类/包名（java.、javax.、jdk.、org.graalvm.、com.oracle.、io.aster.、io.quarkus. 等）；
 * - 栈帧（`at a.b.C.m(...)`）与 `Caused by:`；
 * - Polyglot；
 * - 源码/构件路径：Unix 绝对路径、带扩展名的相对路径（src/main/java/Foo.java）、
 *   单独的 .java/.kt/.class/.jar 等文件名、Windows 路径（C:\...）。
 * 裸的异常类名（如诊断里提到 ValidationException）不算：CNL 诊断可能合法地提到它。
 */
const INTERNAL_DETAIL = new RegExp(
  [
    String.raw`\b(?:java|javax|jdk|sun|com\.sun|org\.graalvm|com\.oracle|io\.aster|io\.quarkus|io\.smallrye|io\.vertx|org\.jboss)\.[\w$]+(?:\.[\w$]+)*`,
    String.raw`\bat [\w$]+(?:\.[\w$<>]+)+\(`,
    String.raw`\bCaused by:`,
    String.raw`Polyglot`,
    String.raw`(?:^|[\s(])/[\w.-]+(?:/[\w.-]+)+`,
    String.raw`\b[\w.-]+(?:[/\\][\w.-]+)+\.(?:java|kt|kts|scala|groovy|class|jar|war|ts|js|mjs)\b`,
    String.raw`\b[\w$-]+\.(?:java|kt|kts|scala|groovy|class|jar|war)\b`,
    String.raw`\b[A-Za-z]:\\[^\s:]+`,
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
  inputError?: { code: string };
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

/** 执行结果对应的错误码：输入错误取其错误码（如 missing_input_field），引擎失败为 execution_failed，其余无。 */
export function executionErrorCode(result: EngineResultLike): string | undefined {
  if (result.inputError) return result.inputError.code;
  return result.metadata.engineError ? EXECUTION_FAILED_CODE : undefined;
}
