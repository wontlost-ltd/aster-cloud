// 防回归：内置模板的规则参数必须带类型，编辑器里 `参数.` 之后才有字段补全。
//
// 历史 bug：模板写 `given driver,`（无类型），参数被推断为 Text，
// `driver.` 之后没有任何字段候选（aster-lang-ts#257 审查确认）。
//
// 成员补全入口 memberCompletions（aster-lang-ts 1.2.1 起，lsp/member-completion.js）未出现在包的
// exports 里，只能按相对路径引用 dist（导出跟进见 aster-lang-ts#260）；它与 LSP 服务端走同一份实现。

import { describe, it, expect } from 'vitest';
import { EN_US, ZH_CN, DE_DE } from '@aster-cloud/aster-lang-ts/browser';
import type { Lexicon } from '@aster-cloud/aster-lang-ts/lexicons/types';
import { POLICY_EXAMPLES, type SupportedLocale } from '@/data/policy-examples';
import { memberCompletions } from '../../../node_modules/@aster-cloud/aster-lang-ts/dist/src/lsp/member-completion.js';
import { parseDocumentText } from '../../../node_modules/@aster-cloud/aster-lang-ts/dist/src/lsp/parse-document.js';

const LEXICONS: Record<SupportedLocale, Lexicon> = { 'en-US': EN_US, 'zh-CN': ZH_CN, 'de-DE': DE_DE };

const RETURN: Record<SupportedLocale, string> = { 'en-US': 'Return', 'zh-CN': '返回', 'de-DE': 'gib zurueck' };

/** 每个语种的「参数 作为/as/als 类型」写法（与源码 Rule 头一致）。 */
const TYPED_PARAM = /(?:given|给定|gegeben)\s+([^\n]*?)(?:,|，)\s*(?:produce|产出|liefert)/;
const AS_SPLIT = /\s+(?:as|作为|als)\s+/;

function parseParams(src: string): { name: string; type: string | undefined }[] {
  const m = TYPED_PARAM.exec(src);
  if (!m) return [];
  return m[1].split(/[,，]/).map((x) => {
    const [name, type] = x.trim().split(AS_SPLIT);
    return { name, type };
  });
}

/** 结构体字段名：Define 块里缩进的首个标识符。 */
function structFields(src: string, typeName: string): string[] {
  const re = new RegExp(`^(?:Define|定义|Definiere)\\s+${typeName}\\s+(?:has|包含|hat)\\s*\\n([\\s\\S]*?)[.。]\\s*$`, 'm');
  const m = re.exec(src);
  if (!m) return [];
  return m[1]
    .split(/[,，]\s*\n/)
    .map((l) => l.trim().split(/\s+/)[0])
    .filter(Boolean);
}

describe('内置模板规则参数带类型', () => {
  for (const example of POLICY_EXAMPLES) {
    for (const locale of Object.keys(example.sources) as SupportedLocale[]) {
      const src = example.sources[locale];

      it(`${example.id} [${locale}] 每条规则的每个参数都显式声明了类型`, () => {
        const headers = src.match(/^(?:Rule|规则|Regel)\s+.*$/gm) ?? [];
        expect(headers.length).toBeGreaterThan(0);
        for (const h of headers) {
          const params = parseParams(h);
          expect(params.length, `${h} 解析不出参数`).toBeGreaterThan(0);
          for (const p of params) {
            expect(p.type, `${example.id} [${locale}] 参数 ${p.name} 缺类型：${h}`).toBeTruthy();
          }
        }
      });

      it(`${example.id} [${locale}] 参数后输入点号能补出该结构体全部字段`, () => {
        const headers = src.match(/^(?:Rule|规则|Regel)\s+.*$/gm) ?? [];
        const entry = headers[0] as string;
        const first = parseParams(entry)[0] as { name: string; type: string };
        const expected = structFields(src, first.type);
        expect(expected.length, `找不到 ${first.type} 的字段定义`).toBeGreaterThan(0);

        // 在入口规则体首行插入 `返回 参数.`：句点既是点号也是语句结束，文档语法完整，
        // 接收者是独立的值位置名字，R2 才会给出它的类型；光标放在句点之后。
        const probe = `  ${RETURN[locale]} ${first.name}.`;
        const headerEnd = src.indexOf('\n', src.indexOf(entry)) + 1;
        const text = src.slice(0, headerEnd) + probe + '\n' + src.slice(headerEnd);
        const line = src.slice(0, headerEnd).split('\n').length - 1;
        const character = probe.length;

        const doc = parseDocumentText(text, LEXICONS[locale], undefined, undefined);
        const items = memberCompletions({ ...doc, text }, { line, character }, LEXICONS[locale]);
        expect(items, `${example.id} [${locale}] 点号后无字段补全`).not.toBeNull();
        const labels = (items as { label: string }[]).map((i) => i.label);
        for (const f of expected) expect(labels, `缺字段 ${f}`).toContain(f);
      });
    }
  }
});
