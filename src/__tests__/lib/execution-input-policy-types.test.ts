/**
 * #638 / ADR 0051 执行前类型提取：复用引擎 resolvePolicyTypes（与执行同一份词汇、同一 locale、
 * 同一份关键词别名），按位置解析；失败时带引擎诊断码；缓存键含词汇作用域身份。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as engine from '@aster-cloud/aster-lang-ts/browser';
import { assembleDomainVocabularyFromLinks, type TermLikeRow } from '@/lib/domain-vocabulary-assemble';
import { buildExecutionVocabulary, type ExecutionVocabulary } from '@/lib/execution-input/mapper';
import { clearPolicyInputTypesCache, extractPolicyInputTypes } from '@/lib/execution-input/policy-types';

vi.mock('@aster-cloud/aster-lang-ts/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aster-cloud/aster-lang-ts/browser')>();
  return { ...actual, resolvePolicyTypes: vi.fn(actual.resolvePolicyTypes) };
});

function row(kind: string, canonical: string, localized: string, parent: string | null = null): TermLikeRow {
  return { domainTermId: `${kind}-${canonical}`, domain: 'e2e1029', locale: 'de', kind, canonical, localized, parentCanonical: parent, aliases: [] };
}

function execVocab(rows: TermLikeRow[]): ExecutionVocabulary {
  return buildExecutionVocabulary(assembleDomainVocabularyFromLinks(rows, { domain: 'e2e1029', locale: 'de-DE' }))!;
}

// ADR 0051 §1：类型 Stufe（Level）与字段 stufe（level）只差大小写，规则 bewerten 与参数 fahrer / 类型 Fahrer 同词。
const ROWS = [
  row('struct', 'Driver', 'Fahrer'),
  row('struct', 'Level', 'Stufe'),
  row('field', 'age', 'alter', 'Driver'),
  row('field', 'level', 'stufe', 'Driver'),
  row('enum_value', 'High', 'Hoch', 'Level'),
  row('enum_value', 'Low', 'Niedrig', 'Level'),
  row('function', 'evaluate', 'bewerten'),
];
const VOCAB = execVocab(ROWS);

const SOURCE = `Modul e2e1029.vocab.

Definiere Stufe als eines von Hoch, Niedrig.

Definiere Fahrer hat alter als Ganzzahl, stufe als Stufe.

Regel bewerten gegeben fahrer als Fahrer liefert Stufe:
  gib zurück fahrer.stufe.
`;

const withVocab = (source: string, vocabulary: ExecutionVocabulary | null = VOCAB) =>
  ({ source, locale: 'de-DE', aliasSet: null, vocabulary });

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(engine.resolvePolicyTypes).mockClear();
  clearPolicyInputTypesCache();
});

describe('extractPolicyInputTypes — 引擎按位置解析（ADR 0051）', () => {
  it('Stufe / stufe 并存：参数、返回类型、结构与枚举都是规范名，参数名保持源码写法', () => {
    const result = extractPolicyInputTypes(withVocab(SOURCE), 'bewerten');
    expect(result).toMatchObject({ ok: true, functionName: 'evaluate' });
    if (!result.ok) return;
    expect(result.types.params).toEqual([{ name: 'fahrer', type: { kind: 'TypeName', name: 'Driver' } }]);
    expect(result.types.result).toEqual({ kind: 'TypeName', name: 'Level' });
    expect(result.types.enums).toEqual([{
      canonical: 'Level', written: 'Stufe',
      members: [{ canonical: 'High', written: 'Hoch' }, { canonical: 'Low', written: 'Niedrig' }],
    }]);
    expect(result.types.structs[0]!.fields.map((f) => [f.written, f.canonical])).toEqual([['alter', 'age'], ['stufe', 'level']]);
  });

  it('函数名按词汇解析：作者写法、规范名、大小写折叠都命中规范名；未知名原样', () => {
    const name = (fn: string) => {
      const r = extractPolicyInputTypes(withVocab(SOURCE), fn);
      return r.ok ? r.functionName : null;
    };
    expect(name('bewerten')).toBe('evaluate');
    expect(name('evaluate')).toBe('evaluate');
    expect(name('BEWERTEN')).toBe('evaluate');
    expect(name('fehlt')).toBe('fehlt');
    const missing = extractPolicyInputTypes(withVocab(SOURCE), 'fehlt');
    expect(missing.ok && missing.types.params).toEqual([]);
  });

  it('源码解析失败：返回 extraction_failed 并带引擎诊断码、留告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = extractPolicyInputTypes(withVocab('Modul x.\n\nRegel kaputt gegeben'), undefined);
    expect(result).toMatchObject({ ok: false, reason: 'extraction_failed' });
    expect(result.ok ? [] : 'diagnostics' in result ? result.diagnostics : []).toEqual(['P005']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to extract policy types'), expect.anything());
  });

  it('TS 解析器尚不支持的函数体写法（`mit f = v`）不再按签名回退：如实失败并给出诊断码', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const source = `${SOURCE}
Regel nachbauen gegeben fahrer als Fahrer liefert Fahrer:
  gib zurück Fahrer mit alter = fahrer.alter, stufe = Niedrig.
`;
    expect(extractPolicyInputTypes(withVocab(source), 'bewerten')).toMatchObject({ ok: false, reason: 'extraction_failed', diagnostics: ['P005'] });
  });

  it('缓存键含词汇作用域：同一份词汇命中缓存，换一份词汇重新解析', () => {
    const first = extractPolicyInputTypes(withVocab(SOURCE), 'bewerten');
    const again = extractPolicyInputTypes(withVocab(SOURCE), 'bewerten');
    expect(again.ok && first.ok && again.types.structs).toBe(first.ok && first.types.structs);
    expect(engine.resolvePolicyTypes).toHaveBeenCalledTimes(1);

    const renamed = execVocab([...ROWS.filter((r) => r.canonical !== 'level'), row('field', 'grade', 'stufe', 'Driver')]);
    const second = extractPolicyInputTypes(withVocab(SOURCE, renamed), 'bewerten');
    expect(engine.resolvePolicyTypes).toHaveBeenCalledTimes(2);
    expect(second.ok && second.types.structs[0]!.fields[1]!.canonical).toBe('grade');
  });

  it('关键词别名只用于解析源码', () => {
    const aliased = SOURCE.replaceAll('gib zurück', 'ergebnis lautet');
    const result = extractPolicyInputTypes({ ...withVocab(aliased), aliasSet: { RETURN: ['ergebnis lautet'] } }, 'bewerten');
    expect(result.ok && result.types.params.map((p) => p.name)).toEqual(['fahrer']);
  });
});

describe('未指定 Rule 时的入口（与执行端 EntryPointSelector 同一规则，#638 复审）', () => {
  const head = 'Module m.\n\nDefine Person has age as Int.\n';
  const one = `${head}\nRule only given p as Person, produce Int:\n  Return p.age.\n`;
  const two = `${head}\nRule first given p as Person, produce Int:\n  Return p.age.\n\nRule second given n as Int, produce Int:\n  Return n.\n`;
  const withEntry = `${head}\nRule first given p as Person, produce Int:\n  Return p.age.\n\n@entry\nRule second given n as Int, produce Int:\n  Return n.\n`;
  const input = (source: string) => ({ source, locale: 'en-US', aliasSet: null, vocabulary: null });
  const params = (source: string, fn?: string) => {
    const r = extractPolicyInputTypes(input(source), fn);
    return r.ok ? r.types.params.map((p) => p.name) : null;
  };

  it('只有一条 Rule：取它', () => {
    expect(params(one)).toEqual(['p']);
  });

  it('多条 Rule、无 @entry：无法确定入口，返回可选 Rule（作者写法）', () => {
    expect(extractPolicyInputTypes(input(two), undefined)).toEqual({ ok: false, reason: 'entry_ambiguous', rules: ['first', 'second'] });
  });

  it('多条 Rule、有 @entry：取 @entry 那条', () => {
    expect(params(withEntry)).toEqual(['n']);
  });

  it('指定了 Rule：按名取，多条 Rule 也不报歧义', () => {
    expect(params(two, 'second')).toEqual(['n']);
  });
});
