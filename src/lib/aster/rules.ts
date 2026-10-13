export interface RuleSymbolRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface RuleSymbol {
  name: string;
  isEntry: boolean;
  range: RuleSymbolRange;
}

const RULE_DECLARATION_RE = /(?:^|\s)(Rule|规则|Regel)\s+([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff.]*)/i;
const COMMENT_LINE_RE = /^\s*(?:\/\/|#)/;
const ENTRY_RE = /(?:^|\s)@entry(?:\s|$)/i;

// 仅含注解（@name / @name(...)）的行——用于独立行 @entry 识别
const ANNOTATION_ONLY_LINE_RE = /^\s*@[A-Za-z_][\w]*(?:\([^)]*\))?\s*$/;

export function extractRuleSymbols(source: string): RuleSymbol[] {
  const rules: RuleSymbol[] = [];
  const lines = source.split(/\r\n|\r|\n/);
  // 前置独立注解行里是否出现 @entry（grammar 支持 @entry 与 Rule 同行或独立成行）
  let pendingEntry = false;

  lines.forEach((line, index) => {
    if (COMMENT_LINE_RE.test(line)) {
      return;
    }

    const match = RULE_DECLARATION_RE.exec(line);
    if (!match || match.index === undefined) {
      // 非 Rule 行：若是纯注解行，累积 @entry 标志；空行不重置；其它内容行重置
      if (ANNOTATION_ONLY_LINE_RE.test(line)) {
        if (ENTRY_RE.test(line)) {
          pendingEntry = true;
        }
      } else if (line.trim() !== '') {
        pendingEntry = false;
      }
      return;
    }

    const keyword = match[1];
    const name = match[2];
    const ruleStartOffset = match.index + match[0].lastIndexOf(keyword);
    const nameStartOffset = ruleStartOffset + keyword.length + match[0].slice(match[0].lastIndexOf(keyword) + keyword.length).indexOf(name);
    // 同行前缀有 @entry，或前置独立注解行累积了 @entry
    const sameLineEntry = ENTRY_RE.test(line.slice(0, ruleStartOffset));

    rules.push({
      name,
      isEntry: sameLineEntry || pendingEntry,
      range: {
        startLineNumber: index + 1,
        startColumn: nameStartOffset + 1,
        endLineNumber: index + 1,
        endColumn: nameStartOffset + name.length + 1,
      },
    });
    pendingEntry = false;
  });

  return rules;
}

export function chooseDefaultRule(rules: Pick<RuleSymbol, 'name' | 'isEntry'>[]): string | null {
  const entryRules = rules.filter((rule) => rule.isEntry);

  if (entryRules.length === 1) {
    return entryRules[0].name;
  }

  if (rules.length === 1) {
    return rules[0].name;
  }

  return null;
}

/**
 * 规则列表变化后应选中的规则。
 *
 * <p>用户已选的规则仍在新列表里时保留它，否则回落到 {@link chooseDefaultRule}。
 * 执行页在规则列表变化时会重新计算一次所选规则；若无条件重置为默认值，
 * 页面刚加载、这次重算尚未执行时用户切换的规则会被覆盖回默认值。
 */
export function reconcileSelectedRule(
  current: string | null,
  rules: Pick<RuleSymbol, 'name' | 'isEntry'>[],
): string | null {
  if (current !== null && rules.some((rule) => rule.name === current)) return current;
  return chooseDefaultRule(rules);
}
