// 词汇解析诊断（E800–E806）带出词条与词汇页链接（ADR 0051 §1；2026-10-30 生产复测 A4：
// E804 在编辑器问题面板与服务端 400 响应里都没有指向 /domain-vocabularies 的链接）。
import { describe, it, expect } from 'vitest';
import {
  vocabularyDiagnosticHelp,
  vocabularyPageHref,
  withVocabularyHelp,
} from '@/lib/vocabulary-diagnostic';

const E804_EN = "Name 'Hoch' in MEMBER_REF position is ambiguous between: High (Hoch), high (hoch)";

describe('vocabularyDiagnosticHelp', () => {
  it('★E804（服务端，只有 message）：解析写法与候选词条', () => {
    expect(vocabularyDiagnosticHelp({ code: 'E804', message: E804_EN })).toEqual({
      written: 'Hoch',
      candidates: ['High (Hoch)', 'high (hoch)'],
    });
  });

  it('编辑器诊断带 data 时优先用 data', () => {
    expect(vocabularyDiagnosticHelp({
      code: 'E805',
      message: 'whatever',
      data: { written: 'alter', role: 'FIELD_REF', candidates: 'age (alter), vehicleAge (alter)' },
    })).toEqual({ written: 'alter', candidates: ['age (alter)', 'vehicleAge (alter)'] });
  });

  it.each([
    ['zh', "MEMBER_REF 位置的名称 'Hoch' 存在歧义，候选: High (Hoch), high (hoch)"],
    ['de', "Name 'Hoch' an Position MEMBER_REF ist mehrdeutig zwischen: High (Hoch), high (hoch)"],
    ['hi', "MEMBER_REF स्थान पर नाम 'Hoch' अस्पष्ट है, विकल्प: High (Hoch), high (hoch)"],
  ])('本地化文案（%s）同样能解析', (_locale, message) => {
    expect(vocabularyDiagnosticHelp({ code: 'E804', message })).toEqual({
      written: 'Hoch',
      candidates: ['High (Hoch)', 'high (hoch)'],
    });
  });

  it('未解析类诊断（E801）只有写法，没有候选', () => {
    expect(vocabularyDiagnosticHelp({ code: 'E801', message: "Cannot resolve field 'punkte' in FIELD_REF position" }))
      .toEqual({ written: 'punkte', candidates: [] });
  });

  it('非词汇诊断 → null', () => {
    expect(vocabularyDiagnosticHelp({ code: 'E003', message: "Undefined variable 'x'" })).toBeNull();
    expect(vocabularyDiagnosticHelp({ code: undefined, message: E804_EN })).toBeNull();
  });

  it('取不到写法 → null（不给出无法定位的链接）', () => {
    expect(vocabularyDiagnosticHelp({ code: 'E804', message: 'ambiguous' })).toBeNull();
  });
});

describe('vocabularyPageHref', () => {
  it('带界面语言前缀，并按写法过滤词汇页', () => {
    expect(vocabularyPageHref('de', 'Hoch')).toBe('/de/domain-vocabularies?q=Hoch');
    expect(vocabularyPageHref('zh', '年 龄')).toBe('/zh/domain-vocabularies?q=%E5%B9%B4%20%E9%BE%84');
  });
});

describe('withVocabularyHelp（服务端 compile_error 响应）', () => {
  it('★词汇诊断附 vocabulary 字段，其余原样', () => {
    const out = withVocabularyHelp([
      { severity: 'error', code: 'E804', message: E804_EN, startLine: 9, startColumn: 14 },
      { severity: 'error', code: 'E003', message: 'x', startLine: 1, startColumn: 1 },
    ]);
    expect(out[0]).toMatchObject({
      code: 'E804',
      vocabulary: {
        written: 'Hoch',
        candidates: ['High (Hoch)', 'high (hoch)'],
        href: '/domain-vocabularies?q=Hoch',
      },
    });
    expect(out[1]).not.toHaveProperty('vocabulary');
  });
});
