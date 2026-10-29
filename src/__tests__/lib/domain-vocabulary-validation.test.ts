import { describe, expect, it } from 'vitest';
import {
  assembleDomainVocabularyFromLinks,
  computeDedupKey,
  findTermScopeConflicts,
  findVocabularyScopeConflicts,
  normalizeTermInput,
  validateDomainVocabulary,
} from '@/lib/domain-vocabulary-validation';
import { parseVocabularyValidationMessage } from '@/lib/vocabulary-validation-message';
import { compile, DE_DE } from '@aster-cloud/aster-lang-ts/browser';

/** 德语 de 分组里的一条词条行。 */
function row(kind: string, canonical: string, localized: string, extra: Record<string, unknown> = {}) {
  return { domainTermId: `${kind}-${canonical}-${localized}`, domain: 'grades', locale: 'de', kind, canonical, localized, ...extra };
}

describe('domain-vocabulary-validation', () => {
  describe('normalizeTermInput', () => {
    it('trims surrounding whitespace; canonical/parent norms are lowercase, localized norm keeps case', () => {
      const normalized = normalizeTermInput({
        domain: ' finance.loan ',
        locale: ' en-US ',
        kind: 'field',
        canonical: ' Principal ',
        localized: ' Principal Amount ',
        parentCanonical: ' Loan ',
        aliases: [' Amount ', '', '  '],
      });

      expect(normalized.domain).toBe('finance.loan');
      expect(normalized.locale).toBe('en-US');
      expect(normalized.canonical).toBe('Principal');
      expect(normalized.canonicalNorm).toBe('principal');
      expect(normalized.localizedNorm).toBe('Principal Amount');
      expect(normalized.parentCanonical).toBe('Loan');
      expect(normalized.parentCanonicalNorm).toBe('loan');
      expect(normalized.aliases).toEqual(['Amount']);
    });

    it('returns empty parentCanonicalNorm when parent is omitted', () => {
      const normalized = normalizeTermInput({
        domain: 'finance.loan',
        locale: 'en-US',
        kind: 'struct',
        canonical: 'Loan',
        localized: 'Loan',
      });

      expect(normalized.parentCanonical).toBeUndefined();
      expect(normalized.parentCanonicalNorm).toBe('');
    });
  });

  describe('computeDedupKey', () => {
    it('仅大小写不同的写法得到不同去重键（ADR 0051 §14：两种写法都保留）', () => {
      const base = { domain: 'grades', locale: 'de', kind: 'field' as const, canonical: 'age', parentCanonical: 'Driver' };
      const upper = normalizeTermInput({ ...base, localized: 'Alter' });
      const lower = normalizeTermInput({ ...base, localized: 'alter' });
      expect(upper.localized).toBe('Alter');
      expect(computeDedupKey(upper)).not.toBe(computeDedupKey(lower));
    });

    /* 生产复测（2026-10-30 F）：编辑词条只改别名/描述时，去重键不变 → upsert 命中已有全局词条
     * （onConflictDoNothing）→ 新别名/描述被静默丢弃，响应仍是 200。别名与描述必须进去重键。 */
    describe('别名与描述参与去重键', () => {
      const base = { domain: 'versicherung', locale: 'de', kind: 'field' as const, canonical: 'age', localized: 'alter', parentCanonical: 'Driver' };
      const plain = computeDedupKey(normalizeTermInput(base));

      it('只改别名 → 去重键不同', () => {
        expect(computeDedupKey(normalizeTermInput({ ...base, aliases: ['lebensalter'] }))).not.toBe(plain);
      });

      it('只改描述 → 去重键不同', () => {
        expect(computeDedupKey(normalizeTermInput({ ...base, description: 'Alter des Fahrers' }))).not.toBe(plain);
      });

      it('别名顺序、重复与首尾空白不影响去重键', () => {
        const a = computeDedupKey(normalizeTermInput({ ...base, aliases: ['b', 'a'] }));
        const b = computeDedupKey(normalizeTermInput({ ...base, aliases: [' a ', 'b', 'a'] }));
        expect(a).toBe(b);
      });

      it('空别名、空白描述与不传等价（已有词条的去重键保持不变）', () => {
        expect(computeDedupKey(normalizeTermInput({ ...base, aliases: [], description: '   ' }))).toBe(plain);
      });
    });

    it('NFC 等价写法得到同一去重键', () => {
      const base = { domain: 'grades', locale: 'de', kind: 'struct' as const, canonical: 'Cafe' };
      const composed = normalizeTermInput({ ...base, localized: 'café' });
      const decomposed = normalizeTermInput({ ...base, localized: 'cafe\u0301' });
      expect(decomposed.localized).toBe('café');
      expect(computeDedupKey(composed)).toBe(computeDedupKey(decomposed));
    });


    it('is stable across whitespace-only differences via normalized columns', () => {
      const a = normalizeTermInput({
        domain: 'finance.loan',
        locale: 'en-US',
        kind: 'struct',
        canonical: ' Borrower ',
        localized: ' Borrower ',
      });
      const b = normalizeTermInput({
        domain: 'finance.loan',
        locale: 'en-US',
        kind: 'struct',
        canonical: 'Borrower',
        localized: 'Borrower',
      });

      expect(computeDedupKey(a)).toBe(computeDedupKey(b));
    });

    it('differentiates by kind', () => {
      const base = {
        domain: 'finance.loan',
        locale: 'en-US',
        canonicalNorm: 'amount',
        localizedNorm: 'amount',
        parentCanonicalNorm: '',
      };
      expect(computeDedupKey({ ...base, kind: 'struct' })).not.toBe(
        computeDedupKey({ ...base, kind: 'field' }),
      );
    });

    it('differentiates by parentCanonicalNorm presence', () => {
      const base = {
        domain: 'finance.loan',
        locale: 'en-US',
        kind: 'field',
        canonicalNorm: 'amount',
        localizedNorm: 'amount',
      };
      expect(computeDedupKey({ ...base, parentCanonicalNorm: '' })).not.toBe(
        computeDedupKey({ ...base, parentCanonicalNorm: 'loan' }),
      );
    });
  });

  describe('assembleDomainVocabularyFromLinks', () => {
    it('groups rows by kind and preserves parent/alias metadata', () => {
      const vocab = assembleDomainVocabularyFromLinks([
        {
          domainTermId: 't1',
          domain: 'finance.loan',
          locale: 'en-US',
          kind: 'struct',
          canonical: 'Loan',
          localized: 'Loan',
          aliases: ['Facility'],
        },
        {
          domainTermId: 't2',
          domain: 'finance.loan',
          locale: 'en-US',
          kind: 'field',
          canonical: 'principal',
          localized: 'principal amount',
          parentCanonical: 'Loan',
        },
      ]);

      expect(vocab.id).toBe('finance.loan');
      expect(vocab.locale).toBe('en-US');
      expect(vocab.structs).toHaveLength(1);
      expect(vocab.structs[0].aliases).toEqual(['Facility']);
      expect(vocab.fields).toHaveLength(1);
      expect(vocab.fields[0].parent).toBe('Loan');
    });

    it('uses opts.domain and opts.locale when rows are empty', () => {
      const vocab = assembleDomainVocabularyFromLinks([], {
        domain: 'finance.loan',
        locale: 'en-US',
      });

      expect(vocab.id).toBe('finance.loan');
      expect(vocab.locale).toBe('en-US');
      expect(vocab.structs).toEqual([]);
    });
  });

  describe('validateDomainVocabulary', () => {
    it('accepts a well-formed vocabulary', () => {
      const vocab = assembleDomainVocabularyFromLinks([
        {
          domainTermId: 't1',
          domain: 'finance.loan',
          locale: 'en-US',
          kind: 'struct',
          canonical: 'Loan',
          localized: 'Loan',
        },
      ]);

      const result = validateDomainVocabulary(vocab);
      expect(result.valid).toBe(true);
    });

    it('rejects a vocabulary with an invalid ASCII canonical', () => {
      const vocab = assembleDomainVocabularyFromLinks([
        {
          domainTermId: 't1',
          domain: 'finance.loan',
          locale: 'en-US',
          kind: 'struct',
          canonical: '贷款',
          localized: '贷款',
        },
      ]);

      const result = validateDomainVocabulary(vocab);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('按位置解析的作用域冲突（ADR 0051 §8）', () => {
    it('允许 Stufe（类型）与 stufe（字段）并存：不同角色互不冲突', () => {
      const vocab = assembleDomainVocabularyFromLinks([
        row('struct', 'Level', 'Stufe'),
        row('field', 'level', 'stufe', { parentCanonical: 'Applicant' }),
      ]);
      expect(findVocabularyScopeConflicts(vocab)).toEqual([]);
      expect(validateDomainVocabulary(vocab).valid).toBe(true);
    });

    it('允许仅大小写不同的同角色条目与跨结构同名字段', () => {
      const vocab = assembleDomainVocabularyFromLinks([
        row('struct', 'Level', 'Stufe'),
        row('struct', 'Grade', 'stufe'),
        row('field', 'age', 'alter', { parentCanonical: 'Driver' }),
        row('field', 'age', 'alter', { parentCanonical: 'Car' }),
      ]);
      expect(validateDomainVocabulary(vocab)).toMatchObject({ valid: true, errors: [] });
    });

    it('拒绝同父结构下写法完全相同但规范名不同的两个字段，并给出可本地化的原因码', () => {
      const vocab = assembleDomainVocabularyFromLinks([
        row('field', 'age', 'alter', { parentCanonical: 'Driver' }),
        row('field', 'years', 'alter', { parentCanonical: 'Driver' }),
      ]);
      expect(findVocabularyScopeConflicts(vocab)).toEqual([
        { role: 'fields', parent: 'Driver', written: 'alter', canonicals: ['age', 'years'] },
      ]);
      const result = validateDomainVocabulary(vocab);
      expect(result.valid).toBe(false);
      expect(parseVocabularyValidationMessage(result.errors.join('; '))).toEqual({
        reason: 'scopeConflict',
        values: { name: 'alter' },
      });
    });

    it('同义词与 NFC 组合字符也按写法比较', () => {
      const vocab = assembleDomainVocabularyFromLinks([
        row('function', 'approve', 'genehmigen', { aliases: ['café'] }),
        row('function', 'reject', 'ablehnen', { aliases: ['cafe\u0301'] }),
      ]);
      expect(findVocabularyScopeConflicts(vocab).map((c) => c.written)).toEqual(['café']);
    });

    it('保存单条时只报告与候选写法相关的冲突', () => {
      const existing = [
        row('field', 'age', 'alter', { parentCanonical: 'Driver' }),
        row('struct', 'A', 'x'),
        row('struct', 'B', 'x'),
      ];
      expect(findTermScopeConflicts(existing, row('field', 'level', 'stufe', { parentCanonical: 'Driver' }))).toEqual([]);
      expect(findTermScopeConflicts(existing, row('struct', 'Level', 'Alter'))).toEqual([]);
      expect(
        findTermScopeConflicts(existing, row('field', 'years', 'alter', { parentCanonical: 'Driver' })),
      ).toHaveLength(1);
    });
  });

  describe('仅大小写不同的条目都能解析（ADR 0051 §14 第 2 条）', () => {
    function typeNames(rows: ReturnType<typeof row>[], source: string): string[] {
      const vocabulary = assembleDomainVocabularyFromLinks(rows, { domain: 'grades', locale: 'de-DE' });
      expect(validateDomainVocabulary(vocabulary).valid).toBe(true);
      const result = compile(source, { lexicon: DE_DE, vocabulary });
      expect(result.success, JSON.stringify(result)).toBe(true);
      return result.core!.decls.filter((d) => d.kind === 'Data').map((d) => (d as { name: string }).name);
    }

    it('Fahrer / FAHRER 映射到不同规范名：按精确写法分别解析', () => {
      const rows = [row('struct', 'Driver', 'Fahrer'), row('struct', 'Chauffeur', 'FAHRER')];
      expect(typeNames(rows, 'Definiere Fahrer hat a als Ganzzahl.\nDefiniere FAHRER hat b als Ganzzahl.'))
        .toEqual(['Driver', 'Chauffeur']);
    });

    it('同一规范名的两种大小写写法都解析到该规范名', () => {
      const rows = [row('struct', 'Driver', 'Fahrer'), row('struct', 'Driver', 'FAHRER')];
      expect(typeNames(rows, 'Definiere Fahrer hat a als Ganzzahl.')).toEqual(['Driver']);
      expect(typeNames(rows, 'Definiere FAHRER hat a als Ganzzahl.')).toEqual(['Driver']);
    });
  });
});
