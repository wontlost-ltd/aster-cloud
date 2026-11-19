/**
 * 结构词别名门控测试（ADR 0022 扩展）：OPERATOR 恒允 / STRUCTURAL 需 allowStructural / 高危恒拒。
 *
 * <p>安全边界（红队 H3）：结构词别名仅在管理员授权（allowStructural=true）时放开；高危 kind
 * （IMPORT/effects/AND/OR/NOT/布尔）任何授权都拒。server 权威判定，前端预校验只是 UX。
 */
import { describe, expect, it } from 'vitest';
import {
  validateUserAliases,
  OPERATOR_KINDS,
  STRUCTURAL_KINDS,
  type ReservedSets,
} from '@/lib/policy-alias-shared';

// 空占用集（不触发遮蔽错误，聚焦门控逻辑）。
const RESERVED: ReservedSets = { canonicalKeywordsLower: new Set(), baseAliasesLower: new Set(), vocabularyTermsLower: new Set() };

describe('结构词别名门控（allowStructural）', () => {
  it('OPERATOR kind（TIMES）恒允许，无需 allowStructural', () => {
    const r = validateUserAliases({ TIMES: ['multiplied by'] }, RESERVED);
    expect(r.valid).toBe(true);
  });

  it('STRUCTURAL kind（MODULE_DECL）默认（未授权）→ 拒绝', () => {
    const r = validateUserAliases({ MODULE_DECL: ['the policy of'] }, RESERVED);
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toContain('结构词');
  });

  it('STRUCTURAL kind + allowStructural=true → 允许（多词）', () => {
    for (const kind of STRUCTURAL_KINDS) {
      const r = validateUserAliases({ [kind]: ['the phrase here'] }, RESERVED, { allowStructural: true });
      expect(r.valid, `${kind} 授权后应允许多词别名: ${r.errors.join()}`).toBe(true);
    }
  });

  it('STRUCTURAL kind + allowStructural=true 但**单词** → 仍拒（护栏①多词，铁律2）', () => {
    const r = validateUserAliases({ RETURN: ['answer'] }, RESERVED, { allowStructural: true });
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toContain('多词');
    // zh 策略里拉丁单词仍拒，只放开 2–8 个汉字的单词（ADR 0060 §5.2）
    expect(validateUserAliases({ RETURN: ['answer'] }, RESERVED, { allowStructural: true, locale: 'zh-CN' }).valid).toBe(false);
    expect(validateUserAliases({ RETURN: ['低头'] }, RESERVED, { allowStructural: true, locale: 'zh-CN' }).valid).toBe(true);
  });

  it('高危 kind（IMPORT/AND/OR/IO）即使 allowStructural=true 也拒（不在两档白名单）', () => {
    for (const kind of ['IMPORT', 'AND', 'OR', 'NOT', 'IO', 'AWAIT', 'TRUE']) {
      const r = validateUserAliases({ [kind]: ['some phrase'] }, RESERVED, { allowStructural: true });
      expect(r.valid, `高危 ${kind} 必须拒`).toBe(false);
    }
  });

  it('混合：授权下 operator + structural 都过；高危仍拒', () => {
    const r = validateUserAliases(
      { TIMES: ['multiplied by'], IF: ['in the case that'], AND: ['together with'] },
      RESERVED,
      { allowStructural: true },
    );
    expect(r.valid).toBe(false); // AND 高危 → 整体 invalid
    expect(r.errors.length).toBe(1); // 只有 AND 一条错
    expect(r.errors[0]).toContain('AND');
  });

  it('两档白名单不重叠且覆盖预期', () => {
    // OPERATOR 与 STRUCTURAL 无交集
    for (const k of OPERATOR_KINDS) expect(STRUCTURAL_KINDS.has(k)).toBe(false);
    // STRUCTURAL 含 8 个结构词（ADR 0060 §5.1 加入 FUNC_PRODUCE）
    expect(STRUCTURAL_KINDS.size).toBe(8);
    for (const k of ['MODULE_DECL', 'FUNC_TO', 'FUNC_PRODUCE', 'IF', 'OTHERWISE', 'MATCH', 'WHEN', 'RETURN']) {
      expect(STRUCTURAL_KINDS.has(k)).toBe(true);
    }
  });
});
