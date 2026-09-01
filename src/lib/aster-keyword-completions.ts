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
      /* ★必须 filter：上面的 `as` 断言绕过了类型检查，而 aliasSet 有一条
       *   **无形态校验**的入口——policies/[id]/edit/page.tsx 直接
       *   `JSON.parse(...) as Record<string, string[]>`（对比
       *   execute-policy-content.tsx 那条路径做了完整的 Array.isArray 校验）。
       *   实测：传 `{ MODULE_IS: undefined }` 时 .flat() 会把字面量 undefined
       *   混进结果，Monaco 遂收到 `label: undefined` 的补全项。
       *   同仓 aster-lexicon.ts 处理同一份数据时用的是 Partial<Record<...>>
       *   并写了 `?? []` 防御——这里对齐那个更严格的口径。 */
      ...(aliases
        ? Object.values(aliases)
            .flat()
            .filter((s): s is string => typeof s === 'string')
        : []),
    ]),
  ];
}

/** Monaco 补全项（只取本模块关心的字段，避免把 monaco 类型拖进单测）。 */
export interface KeywordSuggestion {
  label: string;
  kind: number;
  insertText: string;
  range: unknown;
}

/**
 * 构造关键词补全结果 —— provider 回调里「非 Use 行」分支的**全部逻辑**。
 *
 * ★为什么连这层也要抽出来：只抽 collectKeywordLabels 是**不够的**。
 *   实测变异证明——把组件里的 `collectKeywordLabels(lexiconRef.current)`
 *   整个换成 `[]`，12 条针对纯函数的用例**全部照绿**。
 *   纯函数测得再好，也证明不了调用方真的用了它。
 *
 *   这正是 aster-lang-ts#162 栽过的坑（第16种假绿）在同一天的复发：
 *   我又一次「抽了纯函数、测了纯函数，却没测调用点」。
 *   把「provider 返回什么」也做成无副作用函数，调用点才真正被锁住。
 *
 * @param keywordKind monaco.languages.CompletionItemKind.Keyword，由调用方传入，
 *                    使本模块无需 import monaco。
 */
export function buildKeywordSuggestions(
  lexicon: Lexicon | undefined,
  keywordKind: number,
  range: unknown,
): { suggestions: KeywordSuggestion[] } {
  return {
    suggestions: collectKeywordLabels(lexicon).map((keyword) => ({
      label: keyword,
      kind: keywordKind,
      insertText: keyword,
      range,
    })),
  };
}
