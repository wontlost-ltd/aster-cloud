// 编辑器模块摘要（ADR 0046 §6）：从浏览器 Core IR 取模块名、函数、类型与治理档案。
import { describe, it, expect } from 'vitest';
import { summarizeCoreModule } from '@/components/policy/core-module-summary';

const core = {
  name: 'credit.pilot',
  decls: [{ kind: 'Func', name: 'decide' }, { kind: 'Data', name: 'Applicant' }, { kind: 'Enum', name: 'Tier' }, { kind: 'Import', name: 'x' }],
};

describe('summarizeCoreModule', () => {
  it('Core IR 带 profile → 摘要带 profile', () => {
    expect(summarizeCoreModule({ success: true, core: { ...core, profile: 'eu-ai-act-high-risk' } })).toEqual({
      name: 'credit.pilot', functions: ['decide'], types: ['Applicant', 'Tier'], profile: 'eu-ai-act-high-risk',
    });
  });

  it('未声明档案或旧版编译器无该字段 → 摘要不含 profile 键', () => {
    const s = summarizeCoreModule({ success: true, core });
    expect(s).toEqual({ name: 'credit.pilot', functions: ['decide'], types: ['Applicant', 'Tier'] });
    expect(s).not.toHaveProperty('profile');
    expect(summarizeCoreModule({ success: true, core: { ...core, profile: null } })).not.toHaveProperty('profile');
  });

  it('编译失败或无模块名 → undefined', () => {
    expect(summarizeCoreModule({ success: false, core })).toBeUndefined();
    expect(summarizeCoreModule({ success: true, core: { decls: [] } })).toBeUndefined();
    expect(summarizeCoreModule(null)).toBeUndefined();
  });
});
