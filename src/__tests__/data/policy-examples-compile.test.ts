// 防回归：所有内置策略样例（en-US / zh-CN / de-DE）必须编译零错误。
//
// 历史 bug：zh-CN loan 等样例用了单字布尔字面量 `真`/`假`，而 CNL zh-CN 的
// Bool 字面量是 `真值`/`假值`（2 字，故意避免与业务标识符冲突）。typechecker
// 把 `真`/`假` 当未定义变量 → Monaco editor 显示「Undefined variable: 真/假」
// 编译错误（用户反馈：内置模版样例编译有错）。
//
// 本测试遍历每个样例 × 每个 locale，断言 parseErrors / typeErrors 均为空。

import { describe, it, expect } from 'vitest';
import { compileAndTypecheck, evaluate, EN_US, ZH_CN, DE_DE } from '@aster-cloud/aster-lang-ts/browser';
import { POLICY_EXAMPLES, type SupportedLocale } from '@/data/policy-examples';

const LEXICONS: Record<SupportedLocale, unknown> = {
  'en-US': EN_US,
  'zh-CN': ZH_CN,
  'de-DE': DE_DE,
};

// 全部内置样例（en-US / zh-CN / de-DE）现已编译零错误，无 known-failing。
// 历史失败已根治：
// - zh 样例错误关键词（令...为→定义为、非→不是、单字 乘/加→乘以/加上）
// - healthcare 三语 price/patientCost 数字字段缺/错类型（统一 Float）
// - creditcard 三语 typechecker 函数返回类型推断局限（算术/字段访问返回 Unknown），
//   已在 aster-lang-ts 0.2.2 修复（inferStaticType 支持算术 Call + dotted Name）。
const KNOWN_FAILING = new Set<string>();

describe('内置策略样例编译验证（防 Undefined variable / 语法错误）', () => {
  for (const example of POLICY_EXAMPLES) {
    for (const locale of Object.keys(example.sources) as SupportedLocale[]) {
      if (KNOWN_FAILING.has(`${example.id}:${locale}`)) {
        it.todo(`${example.id} [${locale}] 编译零错误（known failing — 见样例治理 issue）`);
        continue;
      }
      it(`${example.id} [${locale}] 编译零错误`, () => {
        const src = example.sources[locale];
        expect(src, `${example.id} 缺少 ${locale} 源`).toBeTruthy();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = compileAndTypecheck(src, { lexicon: LEXICONS[locale] as any });

        const parseErrors = (r.parseErrors ?? []).map((e) =>
          typeof e === 'object' && e !== null && 'message' in e
            ? (e as { message: string }).message
            : String(e)
        );
        const typeErrors = (r.typeErrors ?? []).map((e) => e.message);

        expect(parseErrors, `${example.id} [${locale}] parseErrors`).toEqual([]);
        expect(typeErrors, `${example.id} [${locale}] typeErrors`).toEqual([]);
      });
    }
  }
});

/**
 * ★执行验证：编译通过 ≠ 能跑（本轮真实事故）。
 *
 * <p>上面的编译用例 15/15 全绿，但把每个样例连同它自带的 defaultInput
 * 真正**执行**一遍时，5 示例 × zh/de 共 <b>10 例全部失败</b>：
 * 样例只有一份英文键的 defaultInput，而规则参数名与 Define 字段名都是
 * 本地化的（en `driver.age` / zh `驾驶员.年龄` / de `fahrer.alter`），
 * 参数按键名映射、字段按成员名访问，于是非英文样例一执行就炸。
 *
 * <p>用户看到的是 `HostObject 不支持成员访问` 之类的引擎级报错，
 * 排查方向被带向 HostAccess 配置，而真因只是键名对不上。
 *
 * <p>教训：**只测编译的用例挡不住只在执行期暴露的缺陷**。
 */
describe('内置策略样例执行验证（防「编译过但跑不了」）', () => {
  /** 从各语种源码里取首个规则名作为入口函数。 */
  function entryFn(src: string): string {
    const m = /^\s*(?:Rule|规则|Regel)\s+([^\s（(,:]+)/m.exec(src);
    return m ? m[1] : '';
  }

  for (const example of POLICY_EXAMPLES) {
    for (const locale of Object.keys(example.sources) as SupportedLocale[]) {
      it(`${example.id} [${locale}] 用自带 defaultInput 执行成功`, () => {
        const src = example.sources[locale];
        const input = example.defaultInputs?.[locale];
        expect(input, `${example.id} 缺少 ${locale} 的 defaultInputs`).toBeTruthy();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = compileAndTypecheck(src, { lexicon: LEXICONS[locale] as any });
        expect(c.core, `${example.id} [${locale}] 未产出 Core IR`).toBeTruthy();

        const fn = entryFn(src);
        expect(fn, `${example.id} [${locale}] 找不到入口规则名`).toBeTruthy();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = evaluate(c.core as any, fn, input as any);
        expect(
          r.success,
          `${example.id} [${locale}] 执行失败：${JSON.stringify(r.error ?? r)}`,
        ).toBe(true);
      });
    }
  }

  /**
   * ★键名必须与该语种的规则参数名一致——直接钉住根因。
   * 只断言「能跑」的话，将来有人把 defaultInputs 改回共用英文键，
   * 报错会是含糊的执行失败；这条让失败信息直接指出键名不匹配。
   */
  for (const example of POLICY_EXAMPLES) {
    for (const locale of Object.keys(example.sources) as SupportedLocale[]) {
      it(`${example.id} [${locale}] defaultInput 顶层键 = 规则参数名`, () => {
        const src = example.sources[locale];
        const m =
          /^\s*(?:Rule|规则|Regel)\s+\S+\s+(?:given|给定|gegeben)\s+([\s\S]*?)(?:,|，)\s*(?:produce|产出|liefert)/m.exec(
            src,
          );
        expect(m, `${example.id} [${locale}] 解析不出参数列表`).toBeTruthy();
        const params = (m as RegExpExecArray)[1]
          .split(/[,，]/)
          .map((x) => x.trim())
          .filter(Boolean);
        const keys = Object.keys(example.defaultInputs[locale]);
        expect(keys, `${example.id} [${locale}] 键名与参数名不一致`).toEqual(params);
      });
    }
  }
});

