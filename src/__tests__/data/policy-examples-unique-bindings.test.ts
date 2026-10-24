import { describe, expect, it } from 'vitest';
import { POLICY_EXAMPLES, type SupportedLocale } from '@/data/policy-examples';

const RULE_START = /^\s*(?:Rule|规则|Regel)\s+[^\s（(,:：]+.*(?:\n|$)/gm;

function ruleBlocks(source: string): string[] {
  const starts = [...source.matchAll(RULE_START)];
  return starts.map((match, index) => {
    const start = match.index ?? 0;
    const nextStart = starts[index + 1]?.index ?? source.length;
    return source.slice(start, nextStart);
  });
}

function letBindings(rule: string): string[] {
  const patterns = [
    /\bLet\s+([A-Za-z_][\w]*)\s+be\b/g,
    /令\s+([^\s]+)\s+定义为/g,
    /\bsei\s+([A-Za-z_][\w]*)\s+gleich\b/g,
  ];

  return patterns.flatMap((pattern) => [...rule.matchAll(pattern)].map((match) => match[1]));
}

describe('内置策略样例的 Let 绑定在同一规则内保持唯一', () => {
  for (const example of POLICY_EXAMPLES) {
    for (const locale of Object.keys(example.sources) as SupportedLocale[]) {
      it(`${example.id} [${locale}] 不重复绑定变量`, () => {
        const duplicates = ruleBlocks(example.sources[locale]).flatMap((rule) => {
          const seen = new Set<string>();
          return letBindings(rule).filter((name) => {
            if (seen.has(name)) return true;
            seen.add(name);
            return false;
          });
        });

        expect(duplicates, `${example.id} [${locale}] 存在重复 Let 绑定`).toEqual([]);
      });
    }
  }
});
