/**
 * 信贷试点 Verdict 策略的三语可编译、可执行契约（ADR 0044 §2）。
 *
 * en/zh/de 三语 × 两个阈值（50000/80000）都必须在生产同款浏览器引擎里编译无错误，
 * 且四组试点申请人分别得到 ALLOW / DENY / REQUIRE_APPROVAL / ESCALATE；
 * 阈值放宽到 80000 后，金额 60000 的需审批申请人改判 ALLOW。
 * v3（ADR 0046 §6）以 When/Otherwise 语法糖书写并声明档案，三语结论须与阈值 50000 的 v1 相同。
 */
import { describe, it, expect } from 'vitest';
import { compile, evaluate, EN_US, ZH_CN, DE_DE } from '@aster-cloud/aster-lang-ts/browser';
import {
  CREDIT_PILOT,
  creditPilotSource,
  creditPilotSugarSource,
  PILOT_APPLICANTS,
  type PilotLocale,
} from '@/config/credit-pilot-source';

const LEXICONS: Record<PilotLocale, unknown> = { en: EN_US, zh: ZH_CN, de: DE_DE };
const LOCALES: PilotLocale[] = ['en', 'zh', 'de'];

// 探测已安装引擎是否带 Verdict 内置：旧引擎把 Verdict 当类型变量，能编译出 core 但执行报未定义函数，
// 所以必须编译后再执行一次（ADR 0044 §10：依赖升级前整组 skip，升级后自动恢复）。
function detectVerdictSupport(): boolean {
  const probe = compile('Module probe.\n\nRule main produce Verdict:\n  Return Verdict.allow().\n', {
    lexicon: EN_US,
  } as Parameters<typeof compile>[1]);
  const errors = ((probe as { diagnostics?: { severity?: string }[] }).diagnostics ?? []).filter(
    (d) => d.severity === 'error',
  );
  if (!probe.core || errors.length > 0) return false;
  const ev = evaluate(probe.core, 'main', {});
  return ev.success && (ev.value as { outcome?: string } | null)?.outcome === 'ALLOW';
}

const engineHasVerdict = detectVerdictSupport();
if (!engineHasVerdict) {
  console.warn(
    '[credit-pilot-source.compile] skipped — ADR 0044 §10: installed @aster-cloud/aster-lang-ts lacks Verdict builtins; test runs once the dependency is bumped',
  );
}

const EXPECTED: Record<50000 | 80000, Record<keyof typeof PILOT_APPLICANTS, string>> = {
  50000: { allow: 'ALLOW', deny: 'DENY', requireApproval: 'REQUIRE_APPROVAL', escalate: 'ESCALATE' },
  80000: { allow: 'ALLOW', deny: 'DENY', requireApproval: 'ALLOW', escalate: 'ESCALATE' },
};

// 探测已安装引擎是否支持档案声明与 When/Otherwise 语法糖（ADR 0046）：旧引擎解析即报错，或丢失 profile
function detectSugarSupport(): boolean {
  if (!engineHasVerdict) return false;
  const probe = compile('Module probe.\nProfile "governed".\n\nRule main produce Verdict:\n  Otherwise allow.\n', {
    lexicon: EN_US,
  } as Parameters<typeof compile>[1]);
  const errors = ((probe as { diagnostics?: { severity?: string }[] }).diagnostics ?? []).filter(
    (d) => d.severity === 'error',
  );
  return !!probe.core && errors.length === 0 && (probe.core as { profile?: string }).profile === 'governed';
}

const engineHasSugar = detectSugarSupport();
if (engineHasVerdict && !engineHasSugar) {
  console.warn(
    '[credit-pilot-source.compile] v3 skipped — ADR 0046 §5: installed @aster-cloud/aster-lang-ts lacks Profile / When-Otherwise sugar; runs once the dependency is bumped',
  );
}

function compileSource(source: string, loc: PilotLocale, label: string) {
  const result = compile(source, {
    lexicon: LEXICONS[loc],
  } as Parameters<typeof compile>[1]);
  const diags = ((result as { diagnostics?: { severity?: string }[] }).diagnostics ?? []).filter(
    (d) => d.severity === 'error',
  );
  expect(diags.length, `[${label}] diagnostics: ${JSON.stringify(diags)}`).toBe(0);
  expect(result.core, `[${label}] core`).toBeTruthy();
  return result.core!;
}

function compileOrFail(loc: PilotLocale, threshold: 50000 | 80000) {
  return compileSource(creditPilotSource(loc, threshold), loc, `${loc}/${threshold}`);
}

function expectOutcomes(core: ReturnType<typeof compileOrFail>, label: string, threshold: 50000 | 80000) {
  for (const [key, applicant] of Object.entries(PILOT_APPLICANTS)) {
    const ev = evaluate(core, 'decide', { applicant });
    expect(ev.success, `[${label}] ${key}: ${ev.error ?? ''}`).toBe(true);
    const outcome = (ev.value as { outcome?: string }).outcome;
    expect(outcome, `[${label}] ${key}`).toBe(EXPECTED[threshold][key as keyof typeof PILOT_APPLICANTS]);
  }
}

describe.skipIf(!engineHasVerdict)('credit pilot policy compiles & decides in every language', () => {
  for (const loc of LOCALES) {
    for (const threshold of [50000, 80000] as const) {
      it(`${loc} @ ${threshold}: four applicants map to expected outcomes`, () => {
        expectOutcomes(compileOrFail(loc, threshold), `${loc}/${threshold}`, threshold);
      });
    }
  }
});

describe.skipIf(!engineHasSugar)('credit pilot v3 (sugar + profile) decides like v1 in every language', () => {
  for (const loc of LOCALES) {
    it(`${loc} v3: declares the profile and matches v1 @ 50000`, () => {
      const core = compileSource(creditPilotSugarSource(loc), loc, `${loc}/v3`);
      expect((core as { profile?: string }).profile).toBe(CREDIT_PILOT.profile);
      expectOutcomes(core, `${loc}/v3`, 50000);
    });
  }
});
