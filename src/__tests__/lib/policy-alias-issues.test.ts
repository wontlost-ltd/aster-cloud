import { describe, it, expect } from 'vitest';
import {
  formatAliasIssueZh,
  parseAliasInput,
  validateUserAliases,
} from '@/lib/policy-alias-shared';

const reserved = {
  canonicalKeywordsLower: new Set(['times', 'at least']),
  baseAliasesLower: new Set(['multiplied with']),
  vocabularyTermsLower: new Set(['risk score']),
};

describe('validateUserAliases — 结构化问题（#609/#613）', () => {
  it('合法别名集无问题', () => {
    const r = validateUserAliases({ TIMES: ['multiplied by'] }, reserved);
    expect(r).toEqual({ valid: true, errors: [], issues: [] });
  });

  it('跨 kind 重复：问题归属后出现的 kind，并记录先占用的 kind', () => {
    const r = validateUserAliases({ TIMES: ['multiplied by'], MODULO: ['multiplied by'] }, reserved);
    expect(r.valid).toBe(false);
    expect(r.issues).toEqual([
      { code: 'duplicate', kind: 'MODULO', alias: 'multiplied by', otherKind: 'TIMES' },
    ]);
  });

  it('各类问题给出稳定 code 与参数', () => {
    const r = validateUserAliases(
      {
        PLUS: ['triple'],
        TIMES: ['at least'],
        MINUS_WORD: ['multiplied with'],
        DIVIDED_BY: ['risk score'],
        MODULO: ['Mod Of'],
        IF: ['provided that'],
        IMPORT: ['bring in'],
      },
      reserved,
    );
    expect(r.issues).toEqual([
      { code: 'singleWord', kind: 'PLUS', alias: 'triple' },
      { code: 'shadowsKeyword', kind: 'TIMES', alias: 'at least' },
      { code: 'shadowsBaseAlias', kind: 'MINUS_WORD', alias: 'multiplied with' },
      { code: 'collidesVocabulary', kind: 'DIVIDED_BY', alias: 'risk score' },
      { code: 'nonCanonical', kind: 'MODULO', alias: 'Mod Of', normalized: 'mod of' },
      { code: 'structuralNotGranted', kind: 'IF' },
      { code: 'kindNotAllowed', kind: 'IMPORT' },
    ]);
  });

  it('errors 与 issues 一一对应，仍是与 Java 对齐的中文诊断（服务端日志/异常用）', () => {
    const r = validateUserAliases({ PLUS: ['triple'], IF: ['provided that'] }, reserved);
    expect(r.errors).toEqual(r.issues.map(formatAliasIssueZh));
    expect(r.errors[0]).toContain('必须是多词短语');
    expect(r.errors[1]).toContain('结构词 IF');
  });

  it('授权后结构词别名合法', () => {
    expect(validateUserAliases({ IF: ['provided that'] }, reserved, { allowStructural: true }).valid).toBe(true);
  });
});

describe('parseAliasInput', () => {
  it('按逗号切分、归一、去空', () => {
    expect(parseAliasInput('  Multiplied   BY ,, scaled by,')).toEqual(['multiplied by', 'scaled by']);
  });

  it('逐字输入的中间态（末尾空格/逗号）解析结果稳定', () => {
    expect(parseAliasInput('multiplied ')).toEqual(['multiplied']);
    expect(parseAliasInput('multiplied by,')).toEqual(['multiplied by']);
  });
});
