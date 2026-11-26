// 模型标签页的源码生成（ADR 0058 §8.3）：表单经 lexicon 生成本地化源码，编译成功且大纲读回同名声明。
import { describe, it, expect } from 'vitest';
import { compile, EN_US, DE_DE, ZH_CN, HI_IN, type Lexicon } from '@aster-cloud/aster-lang-ts/browser';
import { TS_VERSION } from '@aster-cloud/aster-lang-ts/package-check';
import { SemanticTokenKind } from '@aster-cloud/aster-lang-ts/lexicons';
import {
  buildFieldClause,
  buildStructSource,
  buildTypeAliasSource,
  builtinTypeNames,
} from '@/lib/structured-authoring/source-builders';
import { buildModelOutline } from '@/lib/structured-authoring/outline';

/** 模块头 + 生成的声明，作为一份完整策略源码。 */
function moduleSource(lexicon: Lexicon, decls: string[]): string {
  const header = `${lexicon.keywords[SemanticTokenKind.MODULE_DECL]} demo${lexicon.punctuation.statementEnd}`;
  return [header, ...decls].join('\n\n') + '\n';
}

interface Case {
  lexicon: Lexicon;
  struct: string;
  fields: [string, string];
  alias: string;
}

/**
 * 每种语言两组名字。变音字母只在 de-DE 词法里是标识符字符，中文只在 zh-CN 里是——
 * 各语言的词法器对其余脚本报「Unexpected character」，故含变音 / 中文的名字放在对应语言里。
 * 字段类型用本地化内置类型。
 */
function cases(): Case[] {
  return [
    { lexicon: EN_US, struct: 'Applicant', fields: ['name', 'age'], alias: 'Score' },
    { lexicon: EN_US, struct: 'LoanRequest', fields: ['monthlyIncome', 'creditScore'], alias: 'RiskBand' },
    { lexicon: DE_DE, struct: 'Antragsteller', fields: ['name', 'alter'], alias: 'Punktzahl' },
    { lexicon: DE_DE, struct: 'Größe', fields: ['höhe', 'übermaß'], alias: 'Maß' },
    { lexicon: ZH_CN, struct: '申请人', fields: ['姓名', '年龄'], alias: '分数' },
    { lexicon: ZH_CN, struct: '贷款申请', fields: ['月收入', '信用评分'], alias: '风险等级' },
    { lexicon: HI_IN, struct: 'ग्राहक', fields: ['नाम', 'उम्र'], alias: 'अंक' },
  ];
}

describe('source-builders 往返（编译 + 大纲读回）', () => {
  for (const c of cases()) {
    it(`${c.lexicon.id}：${c.struct} 两个字段 + 类型别名`, () => {
      const [text, int] = [c.lexicon.keywords[SemanticTokenKind.TEXT], c.lexicon.keywords[SemanticTokenKind.INT_TYPE]];
      const struct = buildStructSource(c.lexicon, {
        name: c.struct,
        fields: [
          { name: c.fields[0], type: text },
          { name: c.fields[1], type: int },
        ],
      });
      const alias = buildTypeAliasSource(c.lexicon, { name: c.alias, target: c.struct });
      const source = moduleSource(c.lexicon, [struct, alias]);

      const result = compile(source, { lexicon: c.lexicon, includeIntermediates: true });
      expect(result.parseErrors ?? []).toEqual([]);
      expect(result.success).toBe(true);

      const outline = buildModelOutline(source, c.lexicon);
      expect(outline).not.toBeNull();
      expect(outline!.structs.map((s) => s.name)).toEqual([c.struct]);
      expect(outline!.structs[0].fields.map((f) => [f.name, f.type])).toEqual([
        [c.fields[0], text],
        [c.fields[1], int],
      ]);
      expect(outline!.typeAliases.map((a) => [a.name, a.target])).toEqual([[c.alias, c.struct]]);
    });
  }
});

describe('source-builders 关键词取自 lexicon', () => {
  it('zh-CN 结构体用「定义 … 包含 … 并且 …。」', () => {
    expect(
      buildStructSource(ZH_CN, {
        name: '申请人',
        fields: [
          { name: '姓名', type: '文本' },
          { name: '年龄', type: '整数' },
        ],
      }),
    ).toBe('定义 申请人 包含 姓名 作为 文本 并且 年龄 作为 整数。');
  });

  it('de-DE 字段子句与类型别名', () => {
    expect(buildFieldClause(DE_DE, { name: 'alter', type: 'Ganzzahl' })).toBe('alter als Ganzzahl');
    expect(buildTypeAliasSource(DE_DE, { name: 'Punktzahl', target: 'Ganzzahl' })).toBe('Typ Punktzahl als Ganzzahl.');
  });

  it('en-US 结构体', () => {
    expect(buildStructSource(EN_US, { name: 'A', fields: [{ name: 'x', type: 'Int' }] })).toBe('Define A with x as Int.');
  });

  it('名字与类型两端空白被去掉', () => {
    expect(buildFieldClause(EN_US, { name: '  x ', type: ' Int ' })).toBe('x as Int');
  });

  it('内置类型按 lexicon 本地化', () => {
    expect(builtinTypeNames(EN_US)).toEqual(['Text', 'Int', 'Float', 'Bool']);
    expect(builtinTypeNames(DE_DE)).toEqual(['Text', 'Ganzzahl', 'Dezimal', 'Boolesch']);
    expect(builtinTypeNames(ZH_CN)).toEqual(['文本', '整数', '小数', '布尔']);
  });
});

/**
 * ADR 0058 修订 2：类型别名引导词取 lexicon 的 TYPE_ALIAS（aster-lang-ts 3.6.0 起），四种语言各自的拼写；
 * 英文 `Type` 在所有语言里仍被接受（T2），所以存量源码无需迁移。
 */
describe('类型别名引导词本地化（ADR 0058 修订 2）', () => {
  const LOCALES = [
    { lexicon: EN_US, keyword: 'Type', name: 'Score', target: 'Int', expected: 'Type Score as Int.' },
    { lexicon: ZH_CN, keyword: '类型', name: '分数', target: '整数', expected: '类型 分数 作为 整数。' },
    { lexicon: DE_DE, keyword: 'Typ', name: 'Punktzahl', target: 'Ganzzahl', expected: 'Typ Punktzahl als Ganzzahl.' },
    { lexicon: HI_IN, keyword: 'प्रकार', name: 'अंक', target: 'पूर्णांक', expected: 'प्रकार अंक रूप में पूर्णांक।' },
  ];

  it('随包 aster-lang-ts 为 3.8.2', () => {
    expect(TS_VERSION).toBe('3.8.2');
  });

  for (const c of LOCALES) {
    it(`${c.lexicon.id}：生成「${c.keyword}」并以 ts 3.8.2 编译、大纲读回`, () => {
      expect(c.lexicon.keywords[SemanticTokenKind.TYPE_ALIAS]).toBe(c.keyword);
      const alias = buildTypeAliasSource(c.lexicon, { name: c.name, target: c.target });
      expect(alias).toBe(c.expected);

      const source = moduleSource(c.lexicon, [alias]);
      const result = compile(source, { lexicon: c.lexicon });
      expect(result.parseErrors ?? []).toEqual([]);
      expect(result.success).toBe(true);
      expect(buildModelOutline(source, c.lexicon)!.typeAliases.map((a) => [a.name, a.target])).toEqual([[c.name, c.target]]);
    });

    it(`${c.lexicon.id}：存量的英文「Type」照常编译，大纲与本地化写法相同（无需迁移）`, () => {
      const localized = moduleSource(c.lexicon, [buildTypeAliasSource(c.lexicon, { name: c.name, target: c.target })]);
      const legacy = localized.replace(c.keyword, 'Type');
      expect(legacy).toContain(`Type ${c.name}`);

      const result = compile(legacy, { lexicon: c.lexicon });
      expect(result.parseErrors ?? []).toEqual([]);
      expect(result.success).toBe(true);
      const aliases = (src: string) => buildModelOutline(src, c.lexicon)!.typeAliases.map((a) => [a.name, a.target]);
      expect(aliases(legacy)).toEqual(aliases(localized));
    });
  }
});
