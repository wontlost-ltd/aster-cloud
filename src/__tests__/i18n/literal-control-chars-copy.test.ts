// 字面量宏内容规则的帮助文案须与引擎校验一致：拒绝控制字符（U+0000–U+001F、U+007F，含制表符与换行）。
// 引擎判据见 aster-lang-ts identifiers/types.ts checkCanonical；文案见 DEMO_SUPPLEMENT 的
// domainVocabularies.errors.validation.invalidLiteral 与 policyEditor.embeddedTerms.errors.embedded_vocabulary_invalid。

import { describe, it, expect } from 'vitest';
import {
  IdentifierKind,
  validateVocabulary,
  type DomainVocabulary,
  type IdentifierMapping,
} from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';

const LOCALES = ['en', 'zh', 'de', 'hi'] as const;
/** 各语言文案里指代“控制字符”的词。 */
const CONTROL_WORD = { en: 'control characters', zh: '控制字符', de: 'Steuerzeichen', hi: 'नियंत्रण वर्ण' } as const;

function literalErrors(canonical: string): string[] {
  const literal = { kind: IdentifierKind.LITERAL, canonical, localized: 'gruss' } as IdentifierMapping;
  return validateVocabulary({
    id: 'v', name: 'v', domain: 'd', locale: 'de-DE', version: '1',
    structs: [], fields: [], functions: [], enumValues: [], literals: [literal],
  } as DomainVocabulary).errors;
}

type Messages = { domainVocabularies: { errors: { validation: { invalidLiteral: string } } }; policyEditor: { embeddedTerms: { errors: Record<string, string> } } };
const messagesOf = (loc: (typeof LOCALES)[number]) => DEMO_SUPPLEMENT[loc] as unknown as Messages;

describe('字面量宏内容：引擎拒绝的控制字符范围', () => {
  it.each([
    ['NUL', '\u0000'], ['TAB', '\t'], ['LF', '\n'], ['CR', '\r'], ['ESC', '\u001b'], ['US', '\u001f'], ['DEL', '\u007f'],
  ])('拒绝 %s', (_, ch) => {
    expect(literalErrors(`a${ch}b`)).not.toEqual([]);
  });

  it.each([
    ['空格', ' '], ['U+0080（C1）', '\u0080'], ['NBSP', ' '], ['弯引号', '“'], ['反斜杠', '\\'],
  ])('不拒绝 %s', (_, ch) => {
    expect(literalErrors(`a${ch}b`)).toEqual([]);
  });
});

describe('字面量规则文案提到控制字符（en/zh/de/hi）', () => {
  it.each(LOCALES)('%s：invalidLiteral 与 embedded_vocabulary_invalid', (loc) => {
    const m = messagesOf(loc);
    expect(m.domainVocabularies.errors.validation.invalidLiteral).toContain(CONTROL_WORD[loc]);
    expect(m.policyEditor.embeddedTerms.errors.embedded_vocabulary_invalid).toContain(CONTROL_WORD[loc]);
    // 引擎拒绝 U+007F，两条文案都要点明 DEL
    expect(m.domainVocabularies.errors.validation.invalidLiteral).toContain('DEL');
    expect(m.policyEditor.embeddedTerms.errors.embedded_vocabulary_invalid).toContain('DEL');
  });
});

describe('lowercaseType 文案', () => {
  it('四种语言都提供且互不相同', () => {
    const texts = LOCALES.map((loc) => (messagesOf(loc) as unknown as { policyEditor: { modelTab: Record<string, string> } }).policyEditor.modelTab.lowercaseType);
    for (const t of texts) expect(t).toBeTruthy();
    expect(new Set(texts).size).toBe(4);
  });
});
