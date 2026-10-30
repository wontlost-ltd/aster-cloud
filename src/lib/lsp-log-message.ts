/**
 * LSP `window/logMessage` / `window/showMessage` 的控制台输出策略。
 *
 * 服务端日志按 LSP MessageType 携带级别（1=Error 2=Warning 3=Info 4=Log），
 * 浏览器侧按级别映射到对应的 console 方法；Info/Log 是服务端的诊断性输出，
 * 默认不打印，仅在开发环境或 localStorage 调试开关开启时打印。
 */

/** localStorage 调试开关键名：值为 '1' 时打印 Info/Log 级别的服务端消息。 */
export const LSP_DEBUG_STORAGE_KEY = 'aster:lsp-debug';

export interface LspMessageParams {
  type?: number;
  message?: string;
}

/** 控制台落点，便于测试替换。 */
export interface LspConsoleSink {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

/** 是否打印 Info/Log 级别：开发环境，或 localStorage 中 `aster:lsp-debug=1`。 */
export function isLspDebugEnabled(): boolean {
  if (process.env.NODE_ENV === 'development') return true;
  try {
    return globalThis.localStorage?.getItem(LSP_DEBUG_STORAGE_KEY) === '1';
  } catch {
    // 隐私模式或存储被禁用时视为未开启
    return false;
  }
}

/**
 * 把服务端消息按级别输出到控制台。
 * Error/Warning 始终输出；Info/Log（以及未知类型）仅在调试开启时输出。
 */
export function logLspMessage(
  params: LspMessageParams,
  options: { debug?: boolean; sink?: LspConsoleSink } = {},
): void {
  const sink = options.sink ?? console;
  const message = params.message ?? '';
  switch (params.type) {
    case 1:
      sink.error('[LSP Error]', message);
      return;
    case 2:
      sink.warn('[LSP Warning]', message);
      return;
    case 3:
      if (options.debug ?? isLspDebugEnabled()) sink.info('[LSP Info]', message);
      return;
    default:
      if (options.debug ?? isLspDebugEnabled()) sink.debug('[LSP Log]', message);
  }
}
