// @vitest-environment node
// 孤儿类别表（ADR 0061 §3.4）：与 aster-api `OrphanKind` 逐项一致——顺序、字面量、severity、是否自动解除。
// aster-api 新增或改动 kind 时本测试应失败（有意为之），两侧同步改。
import { describe, it, expect } from 'vitest';
import {
  ORPHAN_KINDS, countsBySeverity, isAutoResolvable, isOrphanKind, isOrphanSeverity, severityOf,
} from '@/lib/guard-reconciliation/kinds';

describe('ORPHAN_KINDS', () => {
  it('恰为 aster-api OrphanKind 的 8 项（同序、同 severity、同 autoResolvable）', () => {
    expect(ORPHAN_KINDS.map((k) => [k.kind, k.severity, k.autoResolvable])).toEqual([
      ['side_effect_without_decision', 'critical', false],
      ['side_effect_unconsumed', 'critical', false],
      ['side_effect_mismatch', 'critical', false],
      ['consumed_without_result', 'warning', true],
      ['allow_unconsumed', 'info', true],
      ['consume_on_non_allow', 'critical', false],
      ['result_without_consume', 'critical', false],
      ['orphan_receipt', 'info', true],
    ]);
  });

  it('autoResolvable 恰为 warning 与两个 info', () => {
    const auto = ORPHAN_KINDS.filter((k) => k.autoResolvable);
    expect(auto.map((k) => k.kind)).toEqual(['consumed_without_result', 'allow_unconsumed', 'orphan_receipt']);
    expect(auto.every((k) => k.severity !== 'critical')).toBe(true);
    expect(ORPHAN_KINDS.filter((k) => k.severity !== 'critical').every((k) => k.autoResolvable)).toBe(true);
  });

  it('severityOf / isAutoResolvable / 守卫函数', () => {
    expect(severityOf('side_effect_mismatch')).toBe('critical');
    expect(severityOf('consumed_without_result')).toBe('warning');
    expect(severityOf('orphan_receipt')).toBe('info');
    expect(() => severityOf('bogus' as never)).toThrow();
    expect(isAutoResolvable('allow_unconsumed')).toBe(true);
    expect(isAutoResolvable('side_effect_mismatch')).toBe(false);
    expect(isOrphanKind('allow_unconsumed')).toBe(true);
    expect(isOrphanKind('ALLOW_UNCONSUMED')).toBe(false);
    expect(isOrphanKind(undefined)).toBe(false);
    expect(isOrphanSeverity('warning')).toBe(true);
    expect(isOrphanSeverity('high')).toBe(false);
  });

  it('countsBySeverity：按 kind 表汇总，未知 kind 与非数值忽略', () => {
    expect(countsBySeverity({ side_effect_mismatch: 2, allow_unconsumed: 5, bogus: 9 } as never))
      .toEqual({ critical: 2, warning: 0, info: 5 });
    expect(countsBySeverity({
      side_effect_without_decision: 1, consume_on_non_allow: 3, consumed_without_result: 4, orphan_receipt: 1,
      allow_unconsumed: 'x',
    } as never)).toEqual({ critical: 4, warning: 4, info: 1 });
    expect(countsBySeverity({})).toEqual({ critical: 0, warning: 0, info: 0 });
  });
});
