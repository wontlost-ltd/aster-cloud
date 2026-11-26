// 模型表单的名字自动转义（ADR 0058 修订 3 E1，ADR 0064 §7）：开关打开时，因关键词、别名、字面量触发词或冠词读不回原名的名字
// 写成 `name`，生成的源码用引擎编译后 IR 名字就是原词；开关关闭时判定与引入转义之前逐字节相同。
import { describe, expect, it } from 'vitest';
import {
  compile,
  DE_DE,
  EN_US,
  HI_IN,
  ZH_CN,
  type DomainVocabulary,
  type Lexicon,
} from '@aster-cloud/aster-lang-ts/browser';
import { irNameStrings } from '@aster-cloud/aster-lang-ts/layout';
import { buildModelOutline } from '@/lib/structured-authoring/outline';
import { SemanticTokenKind, withUserAliases } from '@/lib/aster-lexicon';
import {
  escapeName,
  fieldNameRoundTrips,
  isValidFieldName,
  isValidTypeName,
  nameVerdict,
  structNameRoundTrips,
  typeAliasNameRoundTrips,
  typeReferenceSpelling,
  type NameRole,
  type NameVerdict,
} from '@/lib/structured-authoring/name-validation';
import { buildStructSource, buildTypeAliasSource } from '@/lib/structured-authoring/source-builders';

const ON = { nameEscape: true } as const;
const OFF = { nameEscape: false } as const;

/** 字面量触发词：`思故乡` 展开为字符串 "静夜思"（ADR 0060 §8 的《静夜思》词汇）。 */
const POEM_VOCABULARY = {
  id: 'policy.embedded', name: 'policy', locale: 'zh-CN', version: '1',
  structs: [], fields: [], functions: [], enumValues: [],
  literals: [{ localized: '思故乡', canonical: '静夜思', kind: 'literal' }],
} as unknown as DomainVocabulary;

const ZH_WITH_ALIAS = withUserAliases(ZH_CN, { RETURN: ['低头'] });

/** 按表单的方式生成整段源码（模块头 + 声明），用引擎编译（须成功），返回源码与 IR 里的全部名字。 */
function compiled(lexicon: Lexicon, declarations: string[], vocabulary?: DomainVocabulary): { source: string; names: string[] } {
  const header = `${lexicon.keywords[SemanticTokenKind.MODULE_DECL]} m${lexicon.punctuation.statementEnd}`;
  const source = [header, ...declarations].join('\n\n') + '\n';
  const result = compile(source, { lexicon, ...(vocabulary ? { vocabulary } : {}) });
  expect(result.success, `${source}\n${JSON.stringify(result.parseErrors ?? result.resolutionDiagnostics)}`).toBe(true);
  return { source, names: irNameStrings(result.coreJson!) };
}

const text = (lexicon: Lexicon) => lexicon.keywords[SemanticTokenKind.TEXT];

/** 判定为 escaped 后，把写法放进结构体 / 类型别名 / 字段声明，编译得到原词作名字。 */
function expectEscapedCompiles(lexicon: Lexicon, role: NameRole, word: string, vocabulary?: DomainVocabulary) {
  const verdict = nameVerdict(lexicon, role, word, { nameEscape: true, ...(vocabulary ? { vocabulary } : {}) });
  expect(verdict, `${role} ${word}`).toEqual({ kind: 'escaped', written: `\`${word}\`` });
  const written = (verdict as Extract<NameVerdict, { kind: 'escaped' }>).written;
  const declarations =
    role === 'field'
      ? [buildStructSource(lexicon, { name: 'T', fields: [{ name: written, type: text(lexicon) }] })]
      : role === 'struct'
        ? [
            buildStructSource(lexicon, { name: written, fields: [{ name: 'x', type: text(lexicon) }] }),
            // 作字段类型被引用：类型下拉的写法与声明一致
            buildStructSource(lexicon, { name: 'U', fields: [{ name: 'y', type: typeReferenceSpelling(lexicon, word, ON) }] }),
          ]
        : [buildTypeAliasSource(lexicon, { name: written, target: text(lexicon) })];
  const { source, names } = compiled(lexicon, declarations, vocabulary);
  if (role === 'alias') {
    // 类型别名在 Core IR 里被展开，名字看 AST：声明读回原词
    expect(buildModelOutline(source, lexicon, vocabulary)?.typeAliases.map((a) => a.name)).toEqual([word]);
  } else {
    expect(names).toContain(word);
  }
}

describe('E1 自动转义：四个 locale × 各类关键词', () => {
  it.each([
    // [locale, 角色, 词, 类别, lexicon]
    ['zh-CN', 'field', '如果', '结构关键词', ZH_CN],
    ['zh-CN', 'struct', '如果', '结构关键词', ZH_CN],
    ['zh-CN', 'alias', '规则', '结构关键词', ZH_CN],
    ['zh-CN', 'field', '版本', '非结构关键词（今天静默改名为 version）', ZH_CN],
    ['zh-CN', 'struct', '文本', '非结构关键词（内置类型名）', ZH_CN],
    ['en-US', 'struct', 'Rule', '结构关键词', EN_US],
    ['en-US', 'alias', 'Return', '结构关键词', EN_US],
    ['en-US', 'struct', 'Define', '结构关键词', EN_US],
    ['en-US', 'field', 'true', '字面量关键词', EN_US],
    ['de-DE', 'field', 'wenn', '结构关键词', DE_DE],
    ['de-DE', 'struct', 'Wenn', '结构关键词', DE_DE],
    ['de-DE', 'field', 'der', '冠词', DE_DE],
    ['de-DE', 'field', 'die', '冠词', DE_DE],
    ['de-DE', 'struct', 'Der', '冠词（作类型引用时被删掉）', DE_DE],
    ['hi-IN', 'field', 'यदि', '结构关键词', HI_IN],
    ['hi-IN', 'field', 'अनुमति', '非结构关键词（今天静默改名为 allow）', HI_IN],
    ['hi-IN', 'struct', 'नियम', '结构关键词', HI_IN],
  ] as const)('%s %s「%s」（%s）', (_locale, role, word, _kind, lexicon) => {
    expectEscapedCompiles(lexicon, role, word);
  });

  it('别名：版本 aliasSet 的单词别名 RETURN=低头 作字段名', () => {
    expect(fieldNameRoundTrips(ZH_WITH_ALIAS, '低头')).toBe(false);
    expectEscapedCompiles(ZH_WITH_ALIAS, 'field', '低头');
  });

  it('字面量触发词：词汇的 思故乡 → "静夜思" 作字段名（转义的触发词不展开，ADR 0064 N7a）', () => {
    expect(fieldNameRoundTrips(ZH_CN, '思故乡', { vocabulary: POEM_VOCABULARY })).toBe(false);
    expectEscapedCompiles(ZH_CN, 'field', '思故乡', POEM_VOCABULARY);
    // 开关关闭时词汇不参与判定，与引入转义之前一致：原样写、不提示
    expect(nameVerdict(ZH_CN, 'field', '思故乡', { nameEscape: false, vocabulary: POEM_VOCABULARY }))
      .toEqual({ kind: 'plain', written: '思故乡' });
  });

  it('普通名字照旧原样写，不转义', () => {
    expect(nameVerdict(ZH_CN, 'field', '年龄', ON)).toEqual({ kind: 'plain', written: '年龄' });
    expect(nameVerdict(EN_US, 'struct', 'Person', ON)).toEqual({ kind: 'plain', written: 'Person' });
    expect(nameVerdict(DE_DE, 'alias', 'Punktzahl', ON)).toEqual({ kind: 'plain', written: 'Punktzahl' });
    expect(nameVerdict(HI_IN, 'field', 'नाम', ON)).toEqual({ kind: 'plain', written: 'नाम' });
  });

  it('其他原因读不回的照旧拒绝：非法字符、含空白、拉丁大写字段名、小写类型名', () => {
    expect(nameVerdict(EN_US, 'field', 'my field', ON)).toEqual({ kind: 'invalid' });
    expect(nameVerdict(EN_US, 'field', 'a.b', ON)).toEqual({ kind: 'invalid' });
    expect(nameVerdict(EN_US, 'field', 'a`b', ON)).toEqual({ kind: 'invalid' });
    // 字段名在拉丁语言须小写起首：转义不改变 token 类型（N1），`Name` 仍是 TYPE_IDENT
    expect(nameVerdict(EN_US, 'field', 'Name', ON)).toEqual({ kind: 'invalid' });
    // 小写类型名改大写即可：照旧提示大小写，不转义
    expect(nameVerdict(EN_US, 'struct', 'person', ON)).toEqual({ kind: 'lowercaseType' });
    // 小写冠词作类型名：大写后仍是冠词，转义也躲不开 E055 的小写规则，照旧报保留词
    expect(nameVerdict(DE_DE, 'struct', 'der', ON)).toEqual({ kind: 'reserved' });
  });

  it('类型下拉：内置类型恒原样，与关键词同形的已声明类型写成转义', () => {
    expect(typeReferenceSpelling(ZH_CN, '文本', ON)).toBe('文本');
    expect(typeReferenceSpelling(ZH_CN, '客户', ON)).toBe('客户');
    expect(typeReferenceSpelling(ZH_CN, '如果', ON)).toBe('`如果`');
    expect(typeReferenceSpelling(ZH_CN, '如果', OFF)).toBe('如果');
  });

  it('escapeName 去掉首尾空白', () => {
    expect(escapeName(' 版本 ')).toBe('`版本`');
  });
});

/**
 * 引入转义之前 model-tab 的判定（逐行照抄被替换的 typeNameProblem / fieldNameProblem，不含重名检查）：
 * 开关关闭时新判定必须与它对任意输入一致。
 */
function legacyVerdict(lexicon: Lexicon, role: NameRole, name: string): NameVerdict {
  if (role === 'field') {
    if (!isValidFieldName(lexicon, name)) return { kind: 'invalid' };
    if (!fieldNameRoundTrips(lexicon, name)) return { kind: 'reserved' };
    return { kind: 'plain', written: name.trim() };
  }
  const roundTrips = role === 'struct' ? structNameRoundTrips : typeAliasNameRoundTrips;
  if (!isValidTypeName(lexicon, name)) return { kind: 'invalid' };
  if (!roundTrips(lexicon, name)) {
    const trimmed = name.trim();
    const upper = /^\p{Ll}/u.test(trimmed) ? trimmed.replace(/^./u, (c) => c.toUpperCase()) : null;
    return upper !== null && roundTrips(lexicon, upper) ? { kind: 'lowercaseType' } : { kind: 'reserved' };
  }
  return { kind: 'plain', written: name.trim() };
}

describe('开关关闭：判定与引入转义之前逐字节相同', () => {
  const CORPUS: Array<[string, Lexicon, string[]]> = [
    ['en-US', EN_US, ['Person', 'name', 'if', 'If', 'Rule', 'return', 'Return', 'with', 'type', 'true', 'none', 'person', 'Name', 'my field', 'a.b', '`x`', ' Score ']],
    ['zh-CN', ZH_CN, ['客户', '姓名', '如果', '返回', '版本', '定义', '文本', '整数', '规则', '类型', '当', '`当`', '思故乡']],
    ['de-DE', DE_DE, ['Kunde', 'name', 'wenn', 'Wenn', 'der', 'die', 'Der', 'gib', 'Text', 'groesse']],
    ['hi-IN', HI_IN, ['ग्राहक', 'नाम', 'यदि', 'अनुमति', 'परिभाषित', 'नियम', 'पाठ']],
    ['zh-CN + aliasSet', ZH_WITH_ALIAS, ['低头', '姓名']],
  ];
  it.each(CORPUS)('%s', (_locale, lexicon, words) => {
    for (const word of words) {
      for (const role of ['struct', 'alias', 'field'] as const) {
        const verdict = nameVerdict(lexicon, role, word, OFF);
        expect(verdict, `${role} ${JSON.stringify(word)}`).toEqual(legacyVerdict(lexicon, role, word));
        expect(verdict.kind).not.toBe('escaped');
      }
    }
  });

  it('开关关闭时类型下拉恒原样', () => {
    for (const name of ['如果', '客户', '文本', 'Rule']) expect(typeReferenceSpelling(ZH_CN, name, OFF)).toBe(name);
  });
});
