/**
 * CNL 关键词补全项的构造 —— 纯函数，无 Monaco 依赖。
 *
 * ★为什么单独成模块：这段逻辑原本内联在 `monaco-policy-editor.tsx`（1100 行的
 *   组件）里，而那个组件在测试环境里要挂载整个 Monaco + next-intl + session。
 *   把决策点抽出来，才能对「给哪些词」直接断言。
 *
 *   同类教训见 aster-lang-ts 的 `canonicalize-options.ts`：当时把判断留在
 *   不可 import 的模块里，退而测下游契约，结果**真实变异存活**——
 *   契约证明的是下游会用，证明不了调用方传对了。
 */
import type { Lexicon } from './aster-lexicon';

/**
 * 从 lexicon 取出全部可补全的关键词（规范拼写 + 别名，去重）。
 *
 * ★必须按**当前 locale** 取词，不能硬编码英文：写 zh 的用户要敲的是
 * 「模块/规则/返回」，给他 `module/rule/return` 等于每一条都是错的
 * （选中即解析失败）。这与 aster-lang-ts#160 修的 LSP 侧是同一类缺陷。
 *
 * ★别名一并纳入：识别侧本就多对一接受别名（ADR 0022 的 buildKeywordIndex），
 * 补全若只给规范拼写，用户就发现不了自己可以写更自然的别名。
 */
export function collectKeywordLabels(lexicon: Lexicon | undefined): string[] {
  if (!lexicon) return [];
  const aliases = (lexicon as { aliases?: Record<string, readonly string[]> }).aliases;
  return [
    ...new Set([
      ...Object.values(lexicon.keywords as Record<string, string>),
      ...(aliases ? Object.values(aliases).flat() : []),
    ]),
  ];
}
