/**
 * #638 执行前类型提取：与执行同一份词汇、同一 locale 编译；完整编译失败时退回只解析签名；
 * 缓存键含词汇身份。词汇避开只差大小写的组合（aster-lang-ts#243）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleDomainVocabularyFromLinks, type TermLikeRow } from '@/lib/domain-vocabulary-assemble';
import { buildVocabularyNameIndex } from '@/lib/execution-input/mapper';
import { clearPolicyInputTypesCache, extractPolicyInputTypes } from '@/lib/execution-input/policy-types';
import { vocabularyRegistry } from '@/lib/aster-lexicon';

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
    const types = extractPolicyInputTypes(withVocab(`${HEAD}
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
    const broken = extractPolicyInputTypes(withVocab(CONSTRUCT_EQUALS), 'nachbauen');
    const other = extractPolicyInputTypes(withVocab(CONSTRUCT_EQUALS), 'einstufen');
    expect(broken?.params.map((p) => p.name)).toEqual(['person']);
    expect(broken?.result).toMatchObject({ name: 'Fahrer' });
    expect(other?.result).toMatchObject({ name: 'Stufe' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('signatures only'), expect.anything());
  });

  it('不带词汇时同样退回只解析签名（与带词汇同一管线）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const types = extractPolicyInputTypes({ source: CONSTRUCT_EQUALS, locale: 'de-DE', aliasSet: null }, 'nachbauen');
    expect(types?.params.map((p) => p.name)).toEqual(['person']);
  });

  it('签名本身解析不了：返回 null（调用方据此拒绝执行），并留告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(extractPolicyInputTypes(withVocab('Modul x.\n\nRegel kaputt gegeben'), undefined)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to extract policy types'), expect.anything());
  });

  it('编译完撤销临时注册的词汇，不在全局注册表里留残留', () => {
    const register = vi.spyOn(vocabularyRegistry, 'registerCustom');
    const unregister = vi.spyOn(vocabularyRegistry, 'unregisterCustom');
    extractPolicyInputTypes(withVocab(CONSTRUCT_EQUALS), 'einstufen');
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
    const first = extractPolicyInputTypes(withVocab(source), 'einstufen')!;
    expect(extractPolicyInputTypes(withVocab(source), 'einstufen')!.decls).toBe(first.decls);
    expect(register).toHaveBeenCalledTimes(1);

    const renamed = vocab([...ROWS.filter((r) => r.canonical !== 'rank'), row('field', 'grade', 'niveau', 'Driver')]);
    const second = extractPolicyInputTypes(withVocab(source, renamed, buildVocabularyNameIndex(renamed)), 'einstufen')!;
    expect(register).toHaveBeenCalledTimes(2);
    expect(second.decls).not.toBe(first.decls);
  });
});
