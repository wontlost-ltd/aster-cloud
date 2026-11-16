// 模型标签页的源码生成（ADR 0058 §8.3）：表单经 lexicon 生成本地化源码，编译成功且大纲读回同名声明。
import { describe, it, expect } from 'vitest';
import { compile, EN_US, DE_DE, ZH_CN, type Lexicon } from '@aster-cloud/aster-lang-ts/browser';
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
    expect(buildTypeAliasSource(DE_DE, { name: 'Punktzahl', target: 'Ganzzahl' })).toBe('Type Punktzahl als Ganzzahl.');
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
