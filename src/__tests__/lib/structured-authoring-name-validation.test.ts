// 模型标签页名字校验（ADR 0058 §8.3）：词法预检与词法器同口径；往返校验以编译器为准，防止表单产出无法编译的源码。
import { describe, it, expect } from 'vitest';
import { DE_DE, EN_US, HI_IN, ZH_CN } from '@aster-cloud/aster-lang-ts/browser';
import {
  fieldNameRoundTrips,
  isValidFieldName,
  isValidTypeName,
  structNameRoundTrips,
  typeAliasNameRoundTrips,
} from '@/lib/structured-authoring/name-validation';

describe('isValidTypeName', () => {
  it('接受各语言的单个标识符（大小写均可）', () => {
    expect(isValidTypeName(EN_US, 'Person')).toBe(true);
    expect(isValidTypeName(EN_US, 'score')).toBe(true);
    expect(isValidTypeName(ZH_CN, '客户')).toBe(true);
    expect(isValidTypeName(DE_DE, 'Fahrer')).toBe(true);
    expect(isValidTypeName(HI_IN, 'ग्राहक')).toBe(true);
  });

  it('拒绝空白、含空格、标点与数字开头', () => {
    for (const bad of ['', '   ', 'my struct', 'a.b', 'x. Rule', '1a', '_x', 'a,b', '"s"']) {
      expect(isValidTypeName(EN_US, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('首尾空白被忽略', () => {
    expect(isValidTypeName(EN_US, '  Person ')).toBe(true);
  });
});

describe('isValidFieldName', () => {
  it('字段名在拉丁语言须是小写起首标识符（解析器只认 IDENT）', () => {
    expect(isValidFieldName(EN_US, 'income')).toBe(true);
    expect(isValidFieldName(EN_US, 'Name')).toBe(false);
    expect(isValidFieldName(ZH_CN, '姓名')).toBe(true);
    expect(isValidFieldName(HI_IN, 'नाम')).toBe(true);
  });

  it('拒绝含空格或标点', () => {
    expect(isValidFieldName(EN_US, 'my field')).toBe(false);
    expect(isValidFieldName(EN_US, 'a.b')).toBe(false);
  });
});

// 往返校验：关键词、冠词是否生效取决于声明上下文，只能由编译器判断（ADR 0058 §8.3，#805 审查 I1）。
const LEXICONS = { 'en-US': EN_US, 'de-DE': DE_DE, 'zh-CN': ZH_CN, 'hi-IN': HI_IN } as const;

/** 各语言里合法的名字：[结构体名, 类型别名名, 字段名…] */
const GOOD = {
  'en-US': ['Person', 'Score', 'name', 'age'],
  'de-DE': ['Kunde', 'Punktzahl', 'name', 'alter'],
  'zh-CN': ['客户', '分数', '姓名', '年龄'],
  'hi-IN': ['ग्राहक', 'अंक', 'नाम', 'उम्र'],
} as const;

describe('往返校验：合法名字读回一致', () => {
  it.each(Object.entries(LEXICONS))('%s', (locale, lexicon) => {
    const [struct, alias, ...fields] = GOOD[locale as keyof typeof GOOD];
    expect(structNameRoundTrips(lexicon, struct)).toBe(true);
    expect(typeAliasNameRoundTrips(lexicon, alias)).toBe(true);
    expect(structNameRoundTrips(lexicon, alias)).toBe(true);
    for (const field of fields) expect(fieldNameRoundTrips(lexicon, field), field).toBe(true);
  });

  it.each(Object.entries(LEXICONS))('%s：与占位名同名不误拦', (_, lexicon) => {
    for (const name of ['T', 'U', 'V', 'W']) {
      expect(structNameRoundTrips(lexicon, name), name).toBe(true);
      expect(typeAliasNameRoundTrips(lexicon, name), name).toBe(true);
    }
    for (const name of ['x', 'y', 'z']) expect(fieldNameRoundTrips(lexicon, name), name).toBe(true);
  });

  it('首尾空白被忽略', () => {
    expect(structNameRoundTrips(EN_US, ' Person ')).toBe(true);
    expect(fieldNameRoundTrips(ZH_CN, ' 姓名 ')).toBe(true);
  });
});

describe('往返校验：上下文里会变成关键词或冠词的名字被拒', () => {
  it('de-DE：冠词 der / die 作结构体名、类型别名名、字段名均被拒', () => {
    for (const article of ['der', 'die']) {
      // 结构体名能声明，但作类型引用（`x als der und …`、`Type V als der.`）时被当冠词删掉
      expect(structNameRoundTrips(DE_DE, article), `Struktur ${article}`).toBe(false);
      expect(typeAliasNameRoundTrips(DE_DE, article), `Typ ${article}`).toBe(false);
      expect(fieldNameRoundTrips(DE_DE, article), `Feld ${article}`).toBe(false);
    }
  });

  it('zh-CN：关键词作字段名被拒，作类型名也被拒（读回成规范名 Define / Text）', () => {
    for (const keyword of ['定义', '规则', '文本', '整数', '返回']) {
      expect(fieldNameRoundTrips(ZH_CN, keyword), keyword).toBe(false);
    }
    expect(structNameRoundTrips(ZH_CN, '定义')).toBe(false);
    expect(structNameRoundTrips(ZH_CN, '文本')).toBe(false);
  });

  it('hi-IN：关键词作字段名被拒', () => {
    for (const keyword of ['परिभाषित', 'नियम', 'पाठ']) {
      expect(fieldNameRoundTrips(HI_IN, keyword), keyword).toBe(false);
    }
  });

  it('en-US：编译器说了算——小写关键词拼写作字段名能编译，不误拦；作类型名不能引用则被拒', () => {
    for (const name of ['with', 'and', 'as', 'rule']) expect(fieldNameRoundTrips(EN_US, name), name).toBe(true);
    expect(structNameRoundTrips(EN_US, 'with')).toBe(false);
  });

  it('名字夹带声明不能读回', () => {
    expect(structNameRoundTrips(EN_US, 'A. Rule r')).toBe(false);
    expect(typeAliasNameRoundTrips(EN_US, 'A as Text. Type B')).toBe(false);
    expect(fieldNameRoundTrips(EN_US, 'a as Text and b')).toBe(false);
  });
});
