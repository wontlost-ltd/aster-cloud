// aster-lang-ts 3.8.0（eco-1.0.56）对 cloud 可见的行为变化：随包引擎的接受 / 拒绝集合、cloud 的诊断呈现、
// 排版保存与词汇校验在这里钉住，升级时一眼看出哪条变了。名字转义的编辑器支持（自动转义、快速修复、
// 隐藏定界符、L10b 编译上下文）是 ADR 0064 E5，不在本次升级里；这里只钉住「开关关闭时」的现状。
import { describe, it, expect } from 'vitest';
import { compileAndTypecheck, DE_DE, EN_US, ZH_CN, type Lexicon } from '@aster-cloud/aster-lang-ts/browser';
import { TS_VERSION } from '@aster-cloud/aster-lang-ts/package-check';
import {
  checkPackageLayout,
  parseLayoutStrict,
  toDisplay,
  validatePolicyLayout,
} from '@aster-cloud/aster-lang-ts/layout';
import { collectCompileDiagnostics } from '@/hooks/useAsterCompiler';
import { localizeSyntaxDiagnostic } from '@/lib/syntax-diagnostic-message';
import { prepareLayout } from '@/lib/policy-layout/store';
import { LayoutSaveError } from '@/lib/policy-layout/errors';
import { isLayoutSaveErrorCode } from '@/components/policy/policy-form/layout-error-text';
import { getLexicon } from '@/lib/aster-lexicon';
import { validateDomainVocabulary } from '@/lib/domain-vocabulary-validation';
import { assembleDomainVocabularyFromLinks } from '@/lib/domain-vocabulary-assemble';
import { parseVocabularyValidationMessage } from '@/lib/vocabulary-validation-message';
import { layoutRuleContext } from '@/lib/package-node-check';

interface Diagnostic {
  code?: string;
  message: string;
  severity?: string;
  params?: Record<string, string | number>;
  span?: { start?: { line?: number } };
}

type CompileOut = {
  parseErrors?: Diagnostic[];
  resolutionDiagnostics?: Diagnostic[];
  typeErrors?: Diagnostic[];
};

function compile(source: string, lexicon: Lexicon): CompileOut {
  return compileAndTypecheck(source, { lexicon }) as CompileOut;
}

function run(source: string, lexicon: Lexicon): { codes: string[]; warnings: string[]; all: Diagnostic[] } {
  const r = compile(source, lexicon);
  const resolution = r.resolutionDiagnostics ?? [];
  const errors = [
    ...(r.parseErrors ?? []),
    ...resolution.filter((d) => d.severity !== 'warning'),
    ...(r.typeErrors ?? []).filter((d) => d.severity === 'error'),
  ];
  return {
    codes: errors.map((d) => d.code ?? ''),
    warnings: resolution.filter((d) => d.severity === 'warning').map((d) => d.code ?? ''),
    all: errors,
  };
}

const enRule = (body: string) => `Module m.\n\nRule f given x as Int, produce Int:\n${body}`;
const zhRule = (body: string) => `模块 m。\n\n规则 f 给定 x 作为 整数，产出 整数：\n${body}`;

describe('aster-lang-ts 3.8.0 行为变化', () => {
  it('随包 aster-lang-ts 为 3.8.2', () => {
    expect(TS_VERSION).toBe('3.8.2');
  });

  describe('名字转义 `x`（ADR 0064）：纯新增语法', () => {
    it('反引号包住的词永远是名字（含软关键词与汉字名）', () => {
      expect(run('Module m.\n\nRule f given `if` as Int, produce Int:\n  Return `if`.\n', EN_US).codes).toEqual([]);
      expect(run('模块 m。\n\n规则 f 给定 `金额` 作为 整数，产出 整数：\n  返回 `金额`。\n', ZH_CN).codes).toEqual([]);
    });

    it('E902：未闭合、为空、含非法字符', () => {
      for (const body of ['  Return `x.\n', '  Return ``.\n', '  Return `a.b`.\n']) {
        const { codes, all } = run(enRule(body), EN_US);
        expect(codes).toEqual(['E902']);
        expect(all[0]!.params).toHaveProperty('reason');
      }
    });

    it('全角反引号 ｀ 不是转义，照旧 E050，且 zh 按码渲染', () => {
      const { codes, all } = run(zhRule('  返回 ｀x｀。\n'), ZH_CN);
      expect(codes).toEqual(['E050']);
      expect(localizeSyntaxDiagnostic(all[0]!, 'zh-CN')).toContain('｀');
      expect(localizeSyntaxDiagnostic(all[0]!, 'zh-CN')).not.toMatch(/Unexpected/);
    });
  });

  describe('关键词当名字（ADR 0056 修订 A6 K1–K3）', () => {
    it('E901：结构关键词（含本地化拼写）作名字被拒；此前类型名处静默接受', () => {
      expect(run('Module m.\n\nDefine Return with x as Int.\n', EN_US).codes).toEqual(['E901']);
      expect(run('模块 m。\n\n定义 软件 包含 返回 作为 整数。\n', ZH_CN).codes).toEqual(['E901']);
      expect(run('Modul m.\n\nDefiniere Software mit wenn als Ganzzahl.\n', DE_DE).codes).toEqual(['E901']);
      // 英文小写写法照旧是名字
      expect(run('Module m.\n\nRule f given return as Int, produce Int:\n  Return return.\n', EN_US).codes).toEqual([]);
    });

    it('W802：zh 字段 版本 照旧取名 version 并编译通过，只多一条警告', () => {
      const source = '模块 m。\n\n定义 软件 包含 版本 作为 整数。\n\n规则 取值 给定 s 作为 软件，产出 整数：\n  返回 s.版本。\n';
      const { codes, warnings } = run(source, ZH_CN);
      expect(codes).toEqual([]);
      expect(warnings).toEqual(['W802', 'W802']);
    });

    it('cloud 编辑器的诊断汇总：E901 / E902 按码译成 zh（ui-messages 1.0.32，aster-cloud#858），W802 原样透传为警告', () => {
      const e901 = compile('模块 m。\n\n定义 软件 包含 返回 作为 整数。\n', ZH_CN);
      const [d] = collectCompileDiagnostics(e901 as Parameters<typeof collectCompileDiagnostics>[0], 'zh-CN');
      expect(d).toMatchObject({
        severity: 'error',
        code: 'E901',
        message: "'返回' 是关键词 RETURN，不能用作名字；写成反引号形式即可用作名字",
      });

      const e902 = compile(zhRule('  返回 `a.b`。\n'), ZH_CN);
      const [escape] = collectCompileDiagnostics(e902 as Parameters<typeof collectCompileDiagnostics>[0], 'zh-CN');
      expect(escape).toMatchObject({ severity: 'error', code: 'E902', message: "名字转义无效：'.' 不能出现在名字里" });

      const w802 = compile('模块 m。\n\n定义 软件 包含 版本 作为 整数。\n', ZH_CN);
      const all = collectCompileDiagnostics(w802 as Parameters<typeof collectCompileDiagnostics>[0], 'zh-CN');
      expect(all.map((x) => [x.severity, x.code])).toEqual([['warning', 'W802']]);
    });
  });

  describe('D6 放宽与 #389 诊断码', () => {
    it('`if` 紧跟 . , ) 时是名字；大写开头的 Let 名可编译', () => {
      expect(run('Module m.\n\nRule f given if as Int, produce Int:\n  Return if.\n', EN_US).codes).toEqual([]);
      expect(run(enRule('  Let Foo be x.\n  Return Foo.\n'), EN_US).codes).toEqual([]);
      // 结构关键词的规范拼写作 Let 名仍报 E901
      expect(run(enRule('  Let Return be x.\n  Return x.\n'), EN_US).codes).toEqual(['E901']);
    });

    it('`of` 之后换行报 E062；句点后的 `It` 之后换行报 E055，接别的词报 E060', () => {
      expect(run('Module m.\n\nRule f given x as List of\n  Int, produce Int:\n  Return 1.\n', EN_US).codes)
        .toEqual(['E062']);
      expect(run('Module m.\n\nRule f given x as Int, produce Int. It\n  performs io:\n  Return 1.\n', EN_US).codes)
        .toEqual(['E055']);
      expect(run('Module m.\n\nRule f given x as Int, produce Int. It does io:\n  Return 1.\n', EN_US).codes)
        .toEqual(['E060']);
    });
  });

  describe('显示排版的隐藏转义（ADR 0059 修订 5 L10）：不带编译上下文时失败封闭（带上下文的判定见 policy-layout-hidden-escape）', () => {
    const source = 'Module probe.sample.\n\nRule f given `count` as Int, produce Int:\n  Return `count`.\n';
    const hidden = (s: string) => [{ canonical: '`', display: '' }, { text: s }, { canonical: '`', display: '' }];
    const layout = {
      v: 1,
      spans: [
        { text: 'Module probe.sample.\n\nRule f given ' }, ...hidden('count'),
        { text: ' as Int, produce Int:\n  Return ' }, ...hidden('count'), { text: '.\n' },
      ],
    };

    it('不带 compileContext 的 validatePolicyLayout 拒绝含隐藏三元组的排版（L10b 即便本可通过）', () => {
      const result = validatePolicyLayout(layout as never, source, getLexicon('en-US'));
      expect(result).toMatchObject({ ok: false, code: 'layout_hidden_escape_changes_program' });
    });

    it('保存接口在调用方给不出编译上下文（LayoutContext.compile 缺省）时同样以 400 拒绝；反引号照原样显示的排版照常通过', () => {
      let error: unknown;
      try {
        prepareLayout(layout, { source, locale: 'en-US', aliasSet: null });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(LayoutSaveError);
      expect(error).toMatchObject({ code: 'layout_hidden_escape_changes_program', status: 400 });
      // 排版标签页的错误码表认这两个码（ADR 0058 修订 3 E8），按码显示本地化文案
      expect(isLayoutSaveErrorCode('layout_hidden_escape_changes_program')).toBe(true);
      expect(isLayoutSaveErrorCode('layout_escape_delimiter_invalid')).toBe(true);

      expect(() => prepareLayout({ v: 1, spans: [{ text: source }] }, { source, locale: 'en-US', aliasSet: null }))
        .not.toThrow();
    });
    it('Node 导出复核（package-node-check 的 checkPackageLayout 调用形态，不给 l10b）同样以 L10b 拒绝', () => {
      const layoutBytes = new TextEncoder().encode(JSON.stringify(layout));
      const check = (bytes: Uint8Array) => checkPackageLayout({
        layoutBytes: bytes,
        displayBytes: new TextEncoder().encode(toDisplay(parseLayoutStrict(bytes))),
        source,
        layoutVersion: 1,
        ...layoutRuleContext({ source, locale: 'en-US', aliasSet: null }),
      });
      expect(() => check(layoutBytes)).toThrow(/L10b/);
      expect(() => check(new TextEncoder().encode(JSON.stringify({ v: 1, spans: [{ text: source }] })))).not.toThrow();
    });
  });

  it('领域词汇的写法含反引号被引擎拒绝（ADR 0060 修订 2 X2），界面识别为 containsBacktick', () => {
    const vocab = assembleDomainVocabularyFromLinks(
      [{ domainTermId: 't1', domain: 'd', locale: 'de', kind: 'struct', canonical: 'Driver', localized: '`Fahrer`', aliases: [] }],
      { domain: 'd', locale: 'de' },
    );
    const result = validateDomainVocabulary(vocab);
    expect(result.valid).toBe(false);
    const message = result.errors.join('; ');
    expect(message).toContain('反引号');
    expect(parseVocabularyValidationMessage(message)).toEqual({ reason: 'containsBacktick', values: { name: '`Fahrer`' } });
  });
});
