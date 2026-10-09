/**
 * 信贷试点 Verdict 策略的三语可编译、可执行契约（ADR 0044 §2）。
 *
 * en/zh/de 三语 × 两个阈值（50000/80000）都必须在生产同款浏览器引擎里编译无错误，
 * 且四组试点申请人分别得到 ALLOW / DENY / REQUIRE_APPROVAL / ESCALATE；
 * 阈值放宽到 80000 后，金额 60000 的需审批申请人改判 ALLOW。
 */
import { describe, it, expect } from 'vitest';
import { compile, evaluate, EN_US, ZH_CN, DE_DE } from '@aster-cloud/aster-lang-ts/browser';
import { creditPilotSource, PILOT_APPLICANTS, type PilotLocale } from '@/config/credit-pilot-source';

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

function compileOrFail(loc: PilotLocale, threshold: 50000 | 80000) {
  const result = compile(creditPilotSource(loc, threshold), {
    lexicon: LEXICONS[loc],
  } as Parameters<typeof compile>[1]);
  const diags = ((result as { diagnostics?: { severity?: string }[] }).diagnostics ?? []).filter(
    (d) => d.severity === 'error',
  );
  expect(diags.length, `[${loc}/${threshold}] diagnostics: ${JSON.stringify(diags)}`).toBe(0);
  expect(result.core, `[${loc}/${threshold}] core`).toBeTruthy();
  return result.core!;
}

describe.skipIf(!engineHasVerdict)('credit pilot policy compiles & decides in every language', () => {
  for (const loc of LOCALES) {
    for (const threshold of [50000, 80000] as const) {
      it(`${loc} @ ${threshold}: four applicants map to expected outcomes`, () => {
        const core = compileOrFail(loc, threshold);
        for (const [key, applicant] of Object.entries(PILOT_APPLICANTS)) {
          const ev = evaluate(core, 'decide', { applicant });
          expect(ev.success, `[${loc}/${threshold}] ${key}: ${ev.error ?? ''}`).toBe(true);
          const outcome = (ev.value as { outcome?: string }).outcome;
          expect(outcome, `[${loc}/${threshold}] ${key}`).toBe(
            EXPECTED[threshold][key as keyof typeof PILOT_APPLICANTS],
          );
        }
      });
    }
  }
});
