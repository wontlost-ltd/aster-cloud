/**
 * 用户自定义别名 TS 实现测试（ADR 0022 方案 D）。
 *
 * envelope 的 Java↔TS 逐字节 parity 由共享向量钉住（source-envelope.test.ts，ADR 0051 §7 的 5 段格式）；
 * 这里只保留与引擎无关的独立锚点与分帧性质。
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalAliasJson,
  computeSourceEnvelope,
  validateUserAliases,
} from '@/lib/policy-alias';

describe('policy-alias — envelope 分帧', () => {
  it('独立锚点：帧 "1:a|0:|0:|0:|0:|" 的 SHA-256（openssl 验证，非 Java 生成）', () => {
    // 防"Java/TS 一起错"：printf '1:a|0:|0:|0:|0:|' | openssl dgst -sha256
    expect(computeSourceEnvelope('a', null, '', '', '')).toBe(
      '4ab3b7ab9c842ae349bbf83e973daeb8dfde25549c4265c2de57f284e1c5a45e',
    );
  });

  it('null≡空串字段，别名变则 envelope 变', () => {
    expect(computeSourceEnvelope('c', null, 'en-US', 't', null)).toBe(
      computeSourceEnvelope('c', '', 'en-US', 't', ''),
    );
    expect(computeSourceEnvelope('c', '{"TIMES":["a b"]}', 'en-US', 't', '')).not.toBe(
      computeSourceEnvelope('c', '{"TIMES":["c d"]}', 'en-US', 't', ''),
    );
  });
});

describe('policy-alias — canonicalJson 确定性', () => {
  it('输入顺序无关，键有序、别名归一排序', () => {
    const a = canonicalAliasJson({ TIMES: ['multiplied by'], PLUS: ['added to'] });
    const b = canonicalAliasJson({ PLUS: ['added to'], TIMES: ['multiplied by'] });
    expect(a).toBe(b);
    expect(a!.indexOf('PLUS')).toBeLessThan(a!.indexOf('TIMES'));
  });

  it('空/null → null', () => {
    expect(canonicalAliasJson(null)).toBeNull();
    expect(canonicalAliasJson({})).toBeNull();
  });

  it('与 Java canonicalJson 格式对齐（紧凑无空格）', () => {
    expect(canonicalAliasJson({ TIMES: ['multiplied by'] })).toBe('{"TIMES":["multiplied by"]}');
  });
});

describe('policy-alias — validateUserAliases (H3)', () => {
  const canon = new Set(['plus', 'times', 'divided by', 'if', 'return']);

  it('低风险多词运算符别名通过', () => {
    expect(validateUserAliases({ TIMES: ['multiplied by'] }, canon).valid).toBe(true);
  });
  it('敏感 kind（RETURN）别名拒绝', () => {
    const r = validateUserAliases({ RETURN: ['approve as'] }, canon);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('不允许为'))).toBe(true);
  });
  it('单词别名拒绝（占标识符命名空间）', () => {
    expect(validateUserAliases({ TIMES: ['scaled'] }, canon).valid).toBe(false);
  });
  it('遮蔽规范拼写拒绝', () => {
    expect(validateUserAliases({ TIMES: ['divided by'] }, canon).valid).toBe(false);
  });
  it('非规范空白/大小写拒绝', () => {
    expect(validateUserAliases({ TIMES: ['scaled  by'] }, canon).valid).toBe(false);
    expect(validateUserAliases({ TIMES: ['Scaled By'] }, canon).valid).toBe(false);
  });
  it('null/空 → 合法', () => {
    expect(validateUserAliases(null, canon).valid).toBe(true);
    expect(validateUserAliases({}, canon).valid).toBe(true);
  });

  it('遮蔽 base 已有官方别名拒绝（对齐 Java reserved 含 base aliases）', () => {
    const r = validateUserAliases(
      { TIMES: ['scaled by'] },
      { canonicalKeywordsLower: canon, baseAliasesLower: new Set(['scaled by']) },
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('官方别名'))).toBe(true);
  });

  it('撞领域词汇标识符拒绝（H3 标识符碰撞）', () => {
    const r = validateUserAliases(
      { TIMES: ['monthly fee'] },
      { canonicalKeywordsLower: canon, vocabularyTermsLower: new Set(['monthly fee']) },
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('领域词汇'))).toBe(true);
  });
});

describe('policy-alias — 结构词别名授权闸（ADR 0022 结构词扩展）', () => {
  const canon = new Set(['plus', 'times', 'divided by', 'if', 'return']);

  it('未授权（默认）时结构词别名拒绝', () => {
    const r = validateUserAliases({ FUNC_TO: ['the rule for'] }, canon);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('结构词'))).toBe(true);
  });

  it('授权（allowStructural=true）时多词结构词别名通过', () => {
    const r = validateUserAliases(
      { FUNC_TO: ['the rule for'], IF: ['in the case that'], RETURN: ['the answer is'] },
      canon,
      { allowStructural: true },
    );
    expect(r.valid).toBe(true);
  });

  it('即便授权，结构词别名仍须多词', () => {
    const r = validateUserAliases({ FUNC_TO: ['rulefor'] }, canon, { allowStructural: true });
    expect(r.valid).toBe(false);
  });

  it('高危 kind（AND/IMPORT 等）任何授权都拒', () => {
    expect(validateUserAliases({ AND: ['together with'] }, canon, { allowStructural: true }).valid)
      .toBe(false);
  });
});

describe('policy-alias — W2 DoS 上界', () => {
  const canon = new Set(['plus', 'times', 'divided by', 'if', 'return']);

  it('kind 总数超上限拒绝', () => {
    const big: Record<string, string[]> = {};
    for (let i = 0; i < 33; i++) big[`K${i}`] = ['a b'];
    const r = validateUserAliases(big, canon);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('kind 数量'))).toBe(true);
  });

  it('单 kind 别名数超上限拒绝', () => {
    const many = Array.from({ length: 9 }, (_, i) => `alias number ${i}`);
    const r = validateUserAliases({ TIMES: many }, canon);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('别名数量'))).toBe(true);
  });

  it('单条别名超长拒绝（且不做正则）', () => {
    const long = 'a ' + 'x'.repeat(200);
    const r = validateUserAliases({ TIMES: [long] }, canon);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('别名长度'))).toBe(true);
  });

  it('恰在上界内的输入合法', () => {
    const eight = Array.from({ length: 8 }, (_, i) => `alias phrase ${i}`);
    expect(validateUserAliases({ TIMES: eight }, canon).valid).toBe(true);
  });
});
