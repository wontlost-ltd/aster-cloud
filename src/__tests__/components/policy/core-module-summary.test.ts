// 编辑器模块摘要（ADR 0046 §6）：从浏览器 Core IR 取模块名、函数、类型与治理档案。
import { describe, it, expect } from 'vitest';
import { compileAndTypecheck, EN_US } from '@aster-cloud/aster-lang-ts/browser';
import { summarizeCoreModule } from '@/components/policy/core-module-summary';
import { creditPilotSource, creditPilotSugarSource } from '@/config/credit-pilot-source';

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

  it('Func 带 inputRefs 数组 → 摘要按函数名给出，原样保留（含空数组）', () => {
    const decls = [
      { kind: 'Func', name: 'decide', inputRefs: ['applicant.creditScore'] },
      { kind: 'Func', name: 'helper' },
      { kind: 'Func', name: 'constant', inputRefs: [] },
      { kind: 'Data', name: 'Applicant' },
    ];
    expect(summarizeCoreModule({ success: true, core: { name: 'm', profile: 'eu-ai-act-high-risk', decls } })?.inputRefs).toEqual({
      decide: ['applicant.creditScore'], constant: [],
    });
  });

  it('没有任何 Func 带 inputRefs 数组 → 摘要不含 inputRefs 键', () => {
    expect(summarizeCoreModule({ success: true, core })).not.toHaveProperty('inputRefs');
    const bad = { ...core, decls: [{ kind: 'Func', name: 'decide', inputRefs: 'x' }] };
    expect(summarizeCoreModule({ success: true, core: bad })).not.toHaveProperty('inputRefs');
  });
});

// 端到端：编辑器同款浏览器调用（compileAndTypecheck）对信贷试点 v3（声明 eu-ai-act-high-risk）产出 Func.inputRefs，
// 摘要据此列出 decide 读取的五个字段。引擎路径相对规则的第一个参数（applicant），故不带参数名前缀；
// 未声明档案的 v1 不出现 inputRefs。
describe('summarizeCoreModule × 已安装 aster-lang-ts', () => {
  it('★信贷试点 v3 → decide 读取 applicant 的五个字段', () => {
    const s = summarizeCoreModule(compileAndTypecheck(creditPilotSugarSource('en'), { lexicon: EN_US } as never));
    expect(s?.profile).toBe('eu-ai-act-high-risk');
    expect(s?.inputRefs).toEqual({
      decide: ['activeDefaults', 'creditScore', 'monthlyDebt', 'monthlyIncome', 'requestedAmount'],
    });
  });

  it('未声明档案的信贷试点 v1 → 摘要不含 inputRefs', () => {
    const s = summarizeCoreModule(compileAndTypecheck(creditPilotSource('en', 50000), { lexicon: EN_US } as never));
    expect(s?.name).toBeTruthy();
    expect(s).not.toHaveProperty('inputRefs');
  });
});
