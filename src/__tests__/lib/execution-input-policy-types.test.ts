/**
 * #638 执行前类型提取：与执行同一份词汇、同一 locale 编译；完整编译失败时退回只解析签名；
 * 缓存键含词汇身份。词汇避开只差大小写的组合（aster-lang-ts#243）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleDomainVocabularyFromLinks, type TermLikeRow } from '@/lib/domain-vocabulary-assemble';
import { buildVocabularyNameIndex } from '@/lib/execution-input/mapper';
import { clearPolicyInputTypesCache, extractPolicyInputTypes, stubFunctionBodies } from '@/lib/execution-input/policy-types';
import { canonicalize, compile, lex, TokenKind } from '@aster-cloud/aster-lang-ts/browser';

/** 只取成功时的类型（失败返回 null），便于沿用按类型断言的用例。 */
function extractTypes(...args: Parameters<typeof extractPolicyInputTypes>) {
  const result = extractPolicyInputTypes(...args);
  return result.ok ? result.types : null;
}
import { getLexicon, vocabularyRegistry } from '@/lib/aster-lexicon';

function row(kind: string, canonical: string, localized: string, parent: string | null = null): TermLikeRow {
  return { domainTermId: `${kind}-${canonical}`, domain: 'e2e1029', locale: 'de', kind, canonical, localized, parentCanonical: parent, aliases: [] };
}

function vocab(rows: TermLikeRow[]) {
  return assembleDomainVocabularyFromLinks(rows, { domain: 'e2e1029', locale: 'de-DE' }) as unknown as Record<string, unknown>;
}

const ROWS = [
  row('struct', 'Driver', 'Fahrer'),
  row('struct', 'Level', 'Stufe'),
  row('field', 'age', 'alter', 'Driver'),
  row('field', 'rank', 'niveau', 'Driver'),
  row('enum_value', 'High', 'Hoch', 'Level'),
  row('enum_value', 'Low', 'Niedrig', 'Level'),
];
const VOCAB = vocab(ROWS);
const INDEX = buildVocabularyNameIndex(VOCAB);

const HEAD = `Modul e2e1029.vocab.

Definiere Stufe als eines von Hoch, Niedrig.

Definiere Fahrer hat alter als Ganzzahl, niveau als Stufe.
`;

const CONSTRUCT_EQUALS = `${HEAD}
Regel nachbauen gegeben person als Fahrer liefert Fahrer:
  wenn person.alter mindestens 18:
    gib zurück Fahrer mit alter = person.alter, niveau = Niedrig.
  gib zurück person.

Regel einstufen gegeben person als Fahrer liefert Stufe:
  gib zurück person.niveau.
`;

const withVocab = (source: string, vocabulary = VOCAB, index = INDEX) =>
  ({ source, locale: 'de-DE', aliasSet: null, vocabulary, index });

afterEach(() => {
  vi.restoreAllMocks();
  clearPolicyInputTypesCache();
});

describe('extractPolicyInputTypes — 带执行词汇（#638）', () => {
  it('带词汇编译后按词汇还原为策略写法：结构 / 字段 / 枚举 / 参数类型都是作者所写的名字', () => {
    const types = extractTypes(withVocab(`${HEAD}
Regel einstufen gegeben person als Fahrer liefert Stufe:
  gib zurück person.niveau.
`), 'einstufen')!;
    expect(types.params).toEqual([expect.objectContaining({ name: 'person', type: expect.objectContaining({ kind: 'TypeName', name: 'Fahrer' }) })]);
    expect(types.result).toMatchObject({ kind: 'TypeName', name: 'Stufe' });
    expect(types.decls.find((d) => d.kind === 'Enum')).toMatchObject({ name: 'Stufe', variants: ['Hoch', 'Niedrig'] });
    const driver = types.decls.find((d) => d.kind === 'Data');
    expect(driver && 'fields' in driver ? driver.fields.map((f) => f.name) : []).toEqual(['alter', 'niveau']);
  });

  it('函数体用了 TS 解析器不支持的写法（`mit f = v`）：退回只解析签名，所有规则都能取到类型', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = extractTypes(withVocab(CONSTRUCT_EQUALS), 'nachbauen');
    const other = extractTypes(withVocab(CONSTRUCT_EQUALS), 'einstufen');
    expect(broken?.params.map((p) => p.name)).toEqual(['person']);
    expect(broken?.result).toMatchObject({ name: 'Fahrer' });
    expect(other?.result).toMatchObject({ name: 'Stufe' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('signatures only'), expect.anything());
  });

  it('不带词汇时同样退回只解析签名（与带词汇同一管线）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const types = extractTypes({ source: CONSTRUCT_EQUALS, locale: 'de-DE', aliasSet: null }, 'nachbauen');
    expect(types?.params.map((p) => p.name)).toEqual(['person']);
  });

  it('签名本身解析不了：返回 null（调用方据此拒绝执行），并留告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(extractPolicyInputTypes(withVocab('Modul x.\n\nRegel kaputt gegeben'), undefined)).toEqual({ ok: false, reason: 'extraction_failed' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to extract policy types'), expect.anything());
  });

  it('编译完撤销临时注册的词汇，不在全局注册表里留残留', () => {
    const register = vi.spyOn(vocabularyRegistry, 'registerCustom');
    const unregister = vi.spyOn(vocabularyRegistry, 'unregisterCustom');
    extractTypes(withVocab(CONSTRUCT_EQUALS), 'einstufen');
    expect(register).toHaveBeenCalledTimes(1);
    const [tenantId, registered] = register.mock.calls[0]!;
    expect(unregister).toHaveBeenCalledWith(tenantId, registered.id, 'de-DE');
    expect(vocabularyRegistry.getWithCustom(tenantId, registered.id, 'de-DE')).toBeUndefined();
  });

  it('缓存键含词汇身份：同一源码换一份词汇重新编译，同一份词汇命中缓存', () => {
    const register = vi.spyOn(vocabularyRegistry, 'registerCustom');
    const source = `${HEAD}
Regel einstufen gegeben person als Fahrer liefert Stufe:
  gib zurück person.niveau.
`;
    const first = extractTypes(withVocab(source), 'einstufen')!;
    expect(extractTypes(withVocab(source), 'einstufen')!.decls).toBe(first.decls);
    expect(register).toHaveBeenCalledTimes(1);

    const renamed = vocab([...ROWS.filter((r) => r.canonical !== 'rank'), row('field', 'grade', 'niveau', 'Driver')]);
    const second = extractTypes(withVocab(source, renamed, buildVocabularyNameIndex(renamed)), 'einstufen')!;
    expect(register).toHaveBeenCalledTimes(2);
    expect(second.decls).not.toBe(first.decls);
  });
});

/*
 * 签名回退（aster-cloud/aster-lang-ts#244 修复前的临时措施）的可靠性：对每个合法源码，把一条 Rule 的
 * 函数体换成 TS 解析器不认的写法后，只解析签名得到的每条 Rule 的参数 / 返回类型必须与完整编译
 * 一致。覆盖 en-US / de-DE / zh-CN、跨行签名、函数体内嵌套块、字符串里的 Rule 关键词、多条 Rule。
 */
describe('签名回退：函数体定位（#638 复审）', () => {
  interface Case {
    readonly locale: string;
    readonly valid: string;
    /** 把 valid 里的 BROKEN_MARKER 行替换为解析器不认的语句。 */
    readonly broken: string;
    readonly rules: readonly string[];
  }

  const signatureOf = (types: ReturnType<typeof extractTypes>) =>
    types && { params: types.params.map((p) => ({ name: p.name, type: p.type })), result: types.result };

  const assertFallbackMatches = ({ locale, valid, broken, rules }: Case) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const full = (rule: string) => signatureOf(extractTypes({ source: valid, locale, aliasSet: null }, rule));
    const fallback = (rule: string) => signatureOf(extractTypes({ source: broken, locale, aliasSet: null }, rule));
    // 前提：合法源码完整编译成功、改坏的源码完整编译失败（否则测不到回退）。
    expect(compile(valid, { lexicon: getLexicon(locale) } as Parameters<typeof compile>[1]).success, 'valid compiles').toBe(true);
    expect(compile(broken, { lexicon: getLexicon(locale) } as Parameters<typeof compile>[1]).success, 'broken fails').toBe(false);
    for (const rule of rules) {
      expect(full(rule), rule).not.toBeNull();
      expect(fallback(rule), rule).toEqual(full(rule));
    }
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('signatures only'), expect.anything());
  };

  const EN_HEAD = 'Module m.\n\nDefine Person has age as Int, name as Text.\n';

  it('en-US：多条 Rule、If / Match 嵌套块、函数体字符串里含 Rule 头', () => {
    const body = (last: string) => `${EN_HEAD}
Rule check given p as Person, produce Text:
  If p.age at least 18:
    Match p.age:
      When 18, Return "Rule check given q as Person, produce Int:".
      When 19,
        Return "Rule".
  ${last}

Rule other given p as Person, n as Int, produce Int:
  Return n.
`;
    assertFallbackMatches({
      locale: 'en-US',
      valid: body('Return p.name.'),
      broken: body('Return Person with age = 1.'),
      rules: ['check', 'other'],
    });
  });

  it('en-US：跨行签名，函数体与续行同一缩进 / 比续行更深', () => {
    const sameIndent = (last: string) => `${EN_HEAD}
Rule check given
  p as Person,
  n as Int, produce Int:
  If n at least 1:
    Return n.
  ${last}

Rule other given p as Person, produce Int:
  Return p.age.
`;
    assertFallbackMatches({ locale: 'en-US', valid: sameIndent('Return p.age.'), broken: sameIndent('Return (.'), rules: ['check', 'other'] });
  });

  it('de-DE：嵌套 wenn、函数体字符串里含「Regel」、`mit f = v` 写法', () => {
    const body = (last: string) => `Modul m.

Definiere Fahrer hat alter als Ganzzahl, name als Text.

Regel bauen gegeben person als Fahrer liefert Fahrer:
  wenn person.alter mindestens 18:
    gib zurück person.
  ${last}

Regel nennen gegeben person als Fahrer liefert Text:
  gib zurück "Regel nennen gegeben x als Fahrer liefert Ganzzahl:".
`;
    assertFallbackMatches({
      locale: 'de-DE',
      valid: body('gib zurück Fahrer mit alter setze auf 1 und name setze auf "x".'),
      broken: body('gib zurück Fahrer mit alter = 1, name = "x".'),
      rules: ['bauen', 'nennen'],
    });
  });

  it('zh-CN：嵌套「如果」、函数体字符串里含「规则」、多条规则', () => {
    const body = (last: string) => `模块 m。

定义 Person 包含 age 作为 整数。

规则 check 给定 p 作为 Person 产出 整数：
  如果 p.age 至少 18：
    返回 1。
  ${last}

规则 other 给定 p 作为 Person 产出 文本：
  返回 "规则 x 给定 q 作为 Person 产出 整数："。
`;
    assertFallbackMatches({ locale: 'zh-CN', valid: body('返回 p.age。'), broken: body('返回 (。'), rules: ['check', 'other'] });
  });

  it('词法层面：字符串里的 Rule 是 STRING token，不会被当成 Rule 头；每条 Rule 只替换一次函数体', () => {
    const lexicon = getLexicon('en-US');
    const source = `${EN_HEAD}
Rule a given p as Person, produce Text:
  Return "Rule b given p as Person, produce Text:".

Rule b given p as Person, produce Int:
  If p.age at least 1:
    Return 1.
  Return 0.
`;
    const tokens = lex(canonicalize(source, lexicon), lexicon) as unknown as Parameters<typeof stubFunctionBodies>[0];
    const stubbed = stubFunctionBodies(tokens);
    const strings = stubbed.filter((t) => t.kind === TokenKind.STRING);
    expect(strings).toEqual([]);
    const stubs = stubbed.filter((t) => t.kind === TokenKind.INT && t.value === 0);
    expect(stubs).toHaveLength(2);
    const depth = stubbed.reduce((d, t) => d + (t.kind === TokenKind.INDENT ? 1 : t.kind === TokenKind.DEDENT ? -1 : 0), 0);
    expect(depth).toBe(0);
  });
});

describe('未指定 Rule 时的入口（与执行端 EntryPointSelector 同一规则，#638 复审）', () => {
  const head = 'Module m.\n\nDefine Person has age as Int.\n';
  const one = `${head}\nRule only given p as Person, produce Int:\n  Return p.age.\n`;
  const two = `${head}\nRule first given p as Person, produce Int:\n  Return p.age.\n\nRule second given n as Int, produce Int:\n  Return n.\n`;
  const withEntry = `${head}\nRule first given p as Person, produce Int:\n  Return p.age.\n\n@entry\nRule second given n as Int, produce Int:\n  Return n.\n`;
  const input = (source: string) => ({ source, locale: 'en-US', aliasSet: null });

  it('只有一条 Rule：取它', () => {
    expect(extractTypes(input(one), undefined)?.params.map((p) => p.name)).toEqual(['p']);
  });

  it('多条 Rule、无 @entry：无法确定入口，返回可选 Rule 而不是按空参数映射', () => {
    expect(extractPolicyInputTypes(input(two), undefined)).toEqual({ ok: false, reason: 'entry_ambiguous', rules: ['first', 'second'] });
  });

  it('多条 Rule、有 @entry：取 @entry 那条', () => {
    expect(extractTypes(input(withEntry), undefined)?.params.map((p) => p.name)).toEqual(['n']);
  });

  it('指定了 Rule：按名取，多条 Rule 也不报歧义', () => {
    expect(extractTypes(input(two), 'second')?.params.map((p) => p.name)).toEqual(['n']);
  });
});
