// 执行日志展开详情面板选择单测（ADR 0041 §4）：按决策分类而非 success 判断，待处置行不显示错误面板。

import { describe, it, expect, vi } from 'vitest';

vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));

import { logDetailPanel } from '@/app/[locale]/(dashboard)/policies/[id]/logs/logs-content';

describe('logDetailPanel', () => {
  it('★require_approval / escalate（success=false）⇒ 输出面板', () => {
    expect(logDetailPanel({ decision: 'require_approval', success: false })).toBe('output');
    expect(logDetailPanel({ decision: 'escalate', success: false })).toBe('output');
  });

  it('indeterminate（值输出）⇒ 输出面板', () => {
    expect(logDetailPanel({ decision: 'indeterminate', success: false })).toBe('output');
  });

  it('通过 ⇒ 输出；拒绝/错误/legacy 失败 ⇒ 错误面板', () => {
    expect(logDetailPanel({ decision: 'approved', success: true })).toBe('output');
    expect(logDetailPanel({ decision: null, success: true })).toBe('output');
    expect(logDetailPanel({ decision: 'denied', success: false })).toBe('error');
    expect(logDetailPanel({ decision: 'error', success: false })).toBe('error');
    expect(logDetailPanel({ decision: null, success: false })).toBe('error');
  });
});
