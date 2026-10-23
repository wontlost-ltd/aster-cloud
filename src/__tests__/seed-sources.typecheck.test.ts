/**
 * 种子策略源码的编译 + 类型检查门禁（服务端类型检查接入后，种子不能再是唯一绕过检查的入口）。
 * 覆盖：信贷试点三语两阈值 + 语法糖版、可用性测试租户的中文模板、以及门禁本身对坏源码的拒绝。
 */
import { describe, it, expect } from 'vitest';
import { seedCompileProblems, assertSeedCompiles } from '@/lib/seed-compile-gate';
import { creditPilotSource, creditPilotSugarSource, type PilotLocale } from '@/config/credit-pilot-source';
import { TEMPLATES } from '@/scripts/usability-templates';

const PILOT: Record<PilotLocale, 'en-US' | 'zh-CN' | 'de-DE'> = { en: 'en-US', zh: 'zh-CN', de: 'de-DE' };

describe('种子策略源码必须通过编译与类型检查', () => {
  for (const locale of ['en', 'zh', 'de'] as PilotLocale[]) {
    for (const threshold of [50000, 80000] as const) {
      it(`信贷试点 ${locale} / ${threshold}`, async () => {
        expect(await seedCompileProblems(creditPilotSource(locale, threshold), PILOT[locale])).toEqual([]);
      });
    }
    it(`信贷试点语法糖版 ${locale}`, async () => {
      expect(await seedCompileProblems(creditPilotSugarSource(locale), PILOT[locale])).toEqual([]);
    });
  }

  for (const tpl of TEMPLATES) {
    it(`可用性模板 ${tpl.id}`, async () => {
      expect(await seedCompileProblems(tpl.content, 'zh-CN')).toEqual([]);
    });
  }

  it('未标类型字段被赋枚举值的源码被拒绝（E012）', async () => {
    const bad = 'Module m.\nDefine S as one of A, B.\nDefine D has status, reason.\nRule r given x as Int, produce D:\n  Return D with status set to A, reason set to "x".\n';
    expect((await seedCompileProblems(bad, 'en-US')).map((p) => p.code)).toContain('E012');
    await expect(assertSeedCompiles(bad, 'en-US', 'bad')).rejects.toThrow(/E012/);
  });

  // 已安装引擎是否把无类型字段的成员访问当动态值（aster-lang-ts#227，1.0.36 起）：
  // 旧引擎下 guard 形态仍是 E011，依赖升级后本用例自动生效。
  const guard = 'Module g.\nDefine GuardRequest has principal_id, action, context, agent_model.\n@id("G-1")\nRule decide given req as GuardRequest, produce Verdict:\n  Let large be req.context.amount at least 10000.\n  If large:\n    Return Verdict.escalate("large").\n  Return Verdict.allow().\n';
  it('guard 形态（无类型 context 的点访问）在含 #227 的引擎下通过', async (ctx) => {
    const probe = await seedCompileProblems('Module p.\nDefine R has context.\nRule r given req as R, produce Int:\n  Return req.context.n.\n', 'en-US');
    if (probe.length > 0) ctx.skip();
    expect(await seedCompileProblems(guard, 'en-US')).toEqual([]);
  });
});
