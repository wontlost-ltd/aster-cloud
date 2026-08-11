import { describe, it, expect } from 'vitest';
import { compileAndTypecheck, evaluate, EN_US } from '@aster-cloud/aster-lang-ts/browser';
import { repairSource } from '../../../scripts/repair-is-symbol-policies';

/**
 * 存量策略修复脚本的行为验证。
 *
 * <p>★关键：不能只断言「字符串被替换了」——那只证明我的正则跑了，
 * 不证明改写后的源码**真的能编译执行**。这里用真实引擎跑一遍，
 * 断言修复前失败、修复后成功且结果正确。
 */
const BROKEN = `Module finance.loan.

Define Applicant has
  id,
  creditScore,
  income,
  age.

Define Decision has
  approved as Bool,
  reason,
  rate as Int.

Rule evaluateLoan given applicant as Applicant, produce:
  If applicant.age is < 18
    Return Decision with approved set to false, reason set to "Underage applicant", rate set to 0.
  If applicant.creditScore is < 600
    Return Decision with approved set to false, reason set to "Credit score too low", rate set to 0.
  If applicant.creditScore is > 750
    Return Decision with approved set to true, reason set to "Excellent credit", rate set to 350.
  If applicant.creditScore is >= 700
    Return Decision with approved set to true, reason set to "Good credit", rate set to 450.
  Return Decision with approved set to true, reason set to "Standard approval", rate set to 550.
`;

const INPUT = { applicant: { id: 'ID-001', creditScore: 720, income: 85000, age: 35 } };

describe('存量策略修复：is + 符号 → 文字比较词', () => {
  it('★修复前的源码确实编译失败——否则本测试没有被测对象', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = compileAndTypecheck(BROKEN, { lexicon: EN_US as any });
    expect((r.parseErrors ?? []).length, 'is < 18 必须是语法错误').toBeGreaterThan(0);
  });

  it('★修复后必须编译零错误并执行出正确结果', () => {
    const fixed = repairSource(BROKEN);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = compileAndTypecheck(fixed, { lexicon: EN_US as any });
    expect(r.parseErrors ?? [], `修复后仍有解析错误: ${JSON.stringify(r.parseErrors)}`).toEqual([]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = evaluate(r.core as any, 'evaluateLoan', INPUT as any);
    expect(out.success, `执行失败: ${JSON.stringify(out.error ?? out)}`).toBe(true);
    // creditScore=720 → 命中 `is at least 700` 分支
    expect(out.value).toMatchObject({ approved: true, rate: 450, reason: 'Good credit' });
  });

  it('★<= 必须先于 < 匹配，否则 `is <= 18` 会被改成 `is less than = 18`', () => {
    expect(repairSource('If x is <= 18')).toBe('If x is at most 18');
    expect(repairSource('If x is >= 18')).toBe('If x is at least 18');
    expect(repairSource('If x is != 18')).toBe('If x is not equal to 18');
  });

  it('已经合法的源码必须原样不动（幂等）', () => {
    const good = 'If x is less than 18\n  Return true.\n';
    expect(repairSource(good)).toBe(good);
    expect(repairSource(repairSource(BROKEN))).toBe(repairSource(BROKEN));
  });

  it('★裸符号（不带 is）不得被改写——那本来就是合法写法', () => {
    const bare = 'If x < 18\n  Return true.\n';
    expect(repairSource(bare)).toBe(bare);
  });
});
