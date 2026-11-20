/**
 * 关键词别名 UI 的 kind 元数据（ADR 0022，Phase A）。
 *
 * <p>列 server 白名单允许用户自定义的 11 个**低风险运算符/比较词**，以及需授权的
 * 8 个结构词（Module/Rule/produce/If/Otherwise/Match/When/Return，ADR 0060 §5.1）。
 *
 * <p>面板按「算术」「比较」两组展示，每 kind 显示其在当前 lexicon 的规范拼写 + 用户别名输入（多词短语，zh 下也可为汉字单词）。
 */
import type { SemanticTokenKind } from '@aster-cloud/aster-lang-ts/token-kind';

/** 别名 kind 分组。 */
export type AliasKindGroup = 'arithmetic' | 'comparison' | 'structural';

export interface AliasKindMeta {
  /** SemanticTokenKind 名（进 aliasSet 的 key，与 server ALLOWED_KINDS 一致）。 */
  readonly kind: string;
  /** 分组（UI 折叠/分区）。 */
  readonly group: AliasKindGroup;
  /** 数学符号（UI 辅助显示，非功能性）。 */
  readonly symbol: string;
  /** i18n 短标签 key（在 policies.form.aliases.kinds.* 下）。 */
  readonly labelKey: string;
}

/**
 * 11 个可别名 kind（顺序即 UI 展示顺序）。kind 名与 policy-alias-shared.ALLOWED_KINDS 逐一对应。
 */
export const USER_ALIAS_KINDS: readonly AliasKindMeta[] = [
  { kind: 'PLUS', group: 'arithmetic', symbol: '+', labelKey: 'plus' },
  { kind: 'MINUS_WORD', group: 'arithmetic', symbol: '−', labelKey: 'minus' },
  { kind: 'TIMES', group: 'arithmetic', symbol: '×', labelKey: 'times' },
  { kind: 'DIVIDED_BY', group: 'arithmetic', symbol: '÷', labelKey: 'dividedBy' },
  { kind: 'INTEGER_DIVIDED_BY', group: 'arithmetic', symbol: '÷ᵢ', labelKey: 'integerDividedBy' },
  { kind: 'MODULO', group: 'arithmetic', symbol: 'mod', labelKey: 'modulo' },
  { kind: 'LESS_THAN', group: 'comparison', symbol: '<', labelKey: 'lessThan' },
  { kind: 'GREATER_THAN', group: 'comparison', symbol: '>', labelKey: 'greaterThan' },
  { kind: 'EQUALS_TO', group: 'comparison', symbol: '=', labelKey: 'equalsTo' },
  { kind: 'AT_LEAST', group: 'comparison', symbol: '≥', labelKey: 'atLeast' },
  { kind: 'AT_MOST', group: 'comparison', symbol: '≤', labelKey: 'atMost' },
] as const;

/** 需 per-user 授权后才可自定义的结构词 kind（顺序即 UI 展示顺序）。 */
export const STRUCTURAL_ALIAS_KINDS: readonly AliasKindMeta[] = [
  { kind: 'MODULE_DECL', group: 'structural', symbol: 'Module', labelKey: 'module' },
  { kind: 'FUNC_TO', group: 'structural', symbol: 'Rule', labelKey: 'rule' },
  { kind: 'FUNC_PRODUCE', group: 'structural', symbol: 'produce', labelKey: 'produce' },
  { kind: 'IF', group: 'structural', symbol: 'If', labelKey: 'if' },
  { kind: 'OTHERWISE', group: 'structural', symbol: 'Otherwise', labelKey: 'otherwise' },
  { kind: 'MATCH', group: 'structural', symbol: 'Match', labelKey: 'match' },
  { kind: 'WHEN', group: 'structural', symbol: 'When', labelKey: 'when' },
  { kind: 'RETURN', group: 'structural', symbol: 'Return', labelKey: 'return' },
] as const;

/** 所有 UI 可展示 kind；结构词是否可编辑由 allowStructural 单独控制。 */
export const ALL_ALIAS_KINDS: readonly AliasKindMeta[] = [
  ...USER_ALIAS_KINDS,
  ...STRUCTURAL_ALIAS_KINDS,
] as const;

/** kind → SemanticTokenKind（用于从 lexicon.keywords 取该 kind 的规范拼写）。 */
export function kindToSemanticToken(kind: string): SemanticTokenKind {
  return kind as unknown as SemanticTokenKind;
}

/** 分组顺序（UI 分区渲染）。 */
export const ALIAS_KIND_GROUPS: readonly { group: AliasKindGroup; labelKey: string }[] = [
  { group: 'arithmetic', labelKey: 'groupArithmetic' },
  { group: 'comparison', labelKey: 'groupComparison' },
  { group: 'structural', labelKey: 'groupStructural' },
];
