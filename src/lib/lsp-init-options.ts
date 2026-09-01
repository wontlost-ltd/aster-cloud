/**
 * LSP `initialize` 的 initializationOptions 构造 —— 纯函数，无 WebSocket 依赖。
 *
 * ★为什么单独成模块：这段判断原本内联在 useAsterLSP 的 initializeLSP 里，
 *   而那段代码要跑起来必须先建立 WebSocket 连接。测不到调用方**构造了什么**，
 *   就只能退而去测服务端**会不会用**——那测的是别人的正确性。
 *
 *   aster-lang-ts#162 就栽在这里：只锁了 canonicalizer 契约，
 *   把 LSP 侧的租户参数整个删掉，4 条用例仍然全绿（第16种假绿）。
 *   修法与那次相同：把决策点抽成无副作用的独立模块。
 */

/** 服务端 (aster-lang-ts server.ts:206) 期望的 initializationOptions 形状。 */
export interface LspInitOptions {
  locale: string;
  tenantId?: string;
  domainVocabularies?: readonly unknown[];
}

/**
 * 构造 initializationOptions。
 *
 * ★tenantId 与 domainVocabularies **必须成对下发**：服务端的判断是
 * `initOpts?.tenantId && Array.isArray(initOpts.domainVocabularies)`，
 * 缺任一则整块忽略。故只有其一时不发——发了也不会生效，徒增误导。
 *
 * ★不传的后果不是报错，而是**静默降级**：LSP 照常工作，
 * 但把用户的领域术语当作未知标识符，跳转/补全对这些词全部失效。
 */
export function buildLspInitOptions(
  locale: string,
  tenantId: string | undefined,
  domainVocabularies: readonly unknown[] | undefined,
): LspInitOptions {
  if (tenantId && domainVocabularies?.length) {
    return { locale, tenantId, domainVocabularies };
  }
  return { locale };
}
