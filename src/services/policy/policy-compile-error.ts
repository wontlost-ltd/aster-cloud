/**
 * 源码编译门禁的错误类型与常量。
 *
 * 单独成模块、不依赖 next：resolver 迁移镜像（Dockerfile.resolver-migration，#853）只装运行时闭包，
 * 不装 next；若从 version-manager 取这些类，会顺带加载 policy-access 等依赖 next/server 的模块。
 * version-manager 原样再导出（同一个类），路由与既有测试的导入路径、instanceof 判定都不变。
 */

/** 编译诊断：severity 判「是否有 error」，code/message 用于给出具体拒绝原因。 */
export interface CompileDiagnostic {
  severity: 'error' | 'warning' | 'info' | 'hint';
  code?: string;
  message?: string;
  startLine?: number;
  startColumn?: number;
}

/**
 * 源码存在解析/编译错误——不允许落库。路由 catch 此异常返回 400。
 * 与「别名校验失败」区分：那是别名输入非法，这是源码本身不可编译。
 */
export class PolicyCompileError extends Error {
  /** 有值表示「编译检查暂不可用、可稍后重试」，路由据此返回 503 + Retry-After。 */
  readonly retryAfterSeconds?: number;
  /** 暂不可用时的稳定错误码（缺省 compile_unavailable），界面据此给出不同提示。 */
  readonly unavailableCode?: string;
  readonly diagnostics?: CompileDiagnostic[];

  constructor(
    message = 'Policy source could not be compiled.',
    diagnostics?: CompileDiagnostic[],
  ) {
    super(message);
    this.name = 'PolicyCompileError';
    this.diagnostics = diagnostics;
  }
}

/**
 * 编译检查暂不可用（如 aster-api 限流 429）。仍拒绝落库（fail-closed），
 * 否则限流期间 E705/E706 等阻断性诊断会被放过；但它不是用户源码的错，
 * 路由返回 503 并提示稍后重试，而不是「解析错误」。
 */
export class PolicyCompileUnavailableError extends PolicyCompileError {
  override readonly retryAfterSeconds: number;
  override readonly unavailableCode: string;

  constructor(
    retryAfterSeconds: number,
    message = 'Policy compilation is temporarily unavailable. Try again later.',
    unavailableCode = 'compile_unavailable',
  ) {
    super(message);
    this.name = 'PolicyCompileUnavailableError';
    this.retryAfterSeconds = retryAfterSeconds;
    this.unavailableCode = unavailableCode;
  }
}

/** 作者领域词汇暂时无法加载的稳定错误码（与编译服务不可用区分）。 */
export const VOCABULARY_UNAVAILABLE_CODE = 'vocabulary_unavailable';

/** 编译检查不可用且上游未给出重试时间时的默认重试秒数（aster-api 限流窗口为一分钟）。 */
export const DEFAULT_COMPILE_RETRY_AFTER_SECONDS = 60;
