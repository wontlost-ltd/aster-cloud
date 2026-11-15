/**
 * 内置编辑器模板的**可编译性**契约（aster-cloud#763）。
 *
 * `ASTER_POLICY_TEMPLATES` 是用户在编辑器里首先看到的示例策略。任何一个语言的模板
 * 编译不过，用户在改动之前就会看到报错。本测试用与生产相同的
 * `@aster-cloud/aster-lang-ts/browser` 引擎，对**每个 locale 的每个内置模板**做编译，
 * 并用对应 locale 的 lexicon；新增 locale 却没登记 lexicon、或模板含错误诊断，都会硬失败。
 */
import { describe, it, expect } from 'vitest';
import { compile, compileAndTypecheck, evaluate, EN_US, ZH_CN, DE_DE } from '@aster-cloud/aster-lang-ts/browser';
import { ASTER_POLICY_TEMPLATES, getTemplateForLocale } from '@/config/aster-policy-templates';

type TemplateLocale = keyof typeof ASTER_POLICY_TEMPLATES;

const LEXICONS: Record<TemplateLocale, unknown> = {
  'en-US': EN_US,
  'zh-CN': ZH_CN,
  'de-DE': DE_DE,
};

const LOCALES = Object.keys(ASTER_POLICY_TEMPLATES) as TemplateLocale[];

/** 汇总编译各阶段的错误诊断（compile 不使用通用的 `diagnostics` 字段）。 */
function errorsOf(result: unknown): unknown[] {
  const r = result as {
    parseErrors?: { severity?: string }[];
    loweringDiagnostics?: { severity?: string }[];
    resolutionDiagnostics?: { severity?: string }[];
  };
  const all = [...(r.parseErrors ?? []), ...(r.loweringDiagnostics ?? []), ...(r.resolutionDiagnostics ?? [])];
  return all.filter((d) => d.severity !== 'warning');
}

/** 各 locale 模板的规则名、参数名、信用分字段名与三档期望结果（语义须与 en 模板一致）。 */
const SEMANTICS: Record<TemplateLocale, { rule: string; param: string; score: string; expect: [string, string, string] }> = {
  'en-US': {
    rule: 'evaluateLoan',
    param: 'applicant',
    score: 'creditScore',
    expect: ['Approved with premium rate', 'Approved with standard rate', 'Requires manual review'],
  },
  'zh-CN': {
    rule: '评估贷款',
    param: '申请人',
    score: '信用评分',
    expect: ['批准，优惠利率', '批准，标准利率', '需要人工审核'],
  },
  'de-DE': {
    rule: 'kreditPruefen',
    param: 'antragsteller',
    score: 'bonitaet',
    expect: ['Genehmigt mit Vorzugszins', 'Genehmigt mit Standardzins', 'Erfordert manuelle Prüfung'],
  },
};

describe('built-in editor templates compile in every locale', () => {
  it('每个模板 locale 都登记了 lexicon（新增 locale 必须同步本测试）', () => {
    for (const loc of LOCALES) {
      expect(LEXICONS[loc], `${loc} lexicon`).toBeTruthy();
    }
  });

  for (const loc of LOCALES) {
    it(`${loc}: 模板编译无错误诊断并产出 Core IR`, () => {
      const result = compile(ASTER_POLICY_TEMPLATES[loc], {
        lexicon: LEXICONS[loc],
      } as Parameters<typeof compile>[1]);
      const errors = errorsOf(result);
      expect(errors, `[${loc}] diagnostics: ${JSON.stringify(errors)}`).toEqual([]);
      expect(result.success, `[${loc}] success`).toBe(true);
      expect(result.core, `[${loc}] core`).toBeTruthy();
    });
  }

  for (const loc of LOCALES) {
    it(`${loc}: 模板通过类型检查`, () => {
      const result = compileAndTypecheck(ASTER_POLICY_TEMPLATES[loc], {
        lexicon: LEXICONS[loc],
      } as Parameters<typeof compileAndTypecheck>[1]);
      const errors = (result.typeErrors ?? []).filter((d) => d.severity !== 'warning');
      expect(errors, `[${loc}] type errors: ${JSON.stringify(errors)}`).toEqual([]);
    });
  }

  for (const loc of LOCALES) {
    it(`${loc}: 模板可执行，按 750 / 650 阈值得到与 en 模板一致的决策`, () => {
      const result = compile(ASTER_POLICY_TEMPLATES[loc], {
        lexicon: LEXICONS[loc],
      } as Parameters<typeof compile>[1]);
      const { rule, param, score, expect: expected } = SEMANTICS[loc];
      // 含 750 / 650 两个阈值的两侧，锁定「大于」是严格比较
      const cases: [number, number][] = [
        [800, 0], [751, 0], [750, 1], [700, 1], [651, 1], [650, 2], [600, 2],
      ];
      for (const [value, tier] of cases) {
        const ev = evaluate(result.core!, rule, {
          [param]: { [score]: value },
        });
        expect(ev.success, `[${loc}] score=${value} eval: ${ev.error ?? ''}`).toBe(true);
        expect(String(ev.value), `[${loc}] score=${value}`).toBe(expected[tier]);
      }
    });
  }

  it.each([
    ['en', 'en-US'],
    ['en-GB', 'en-US'],
    ['zh', 'zh-CN'],
    ['zh-TW', 'zh-CN'],
    ['de', 'de-DE'],
    ['de-AT', 'de-DE'],
  ] as const)('getTemplateForLocale(%s) 返回 %s 模板', (input, key) => {
    expect(getTemplateForLocale(input)).toBe(ASTER_POLICY_TEMPLATES[key]);
  });
});
