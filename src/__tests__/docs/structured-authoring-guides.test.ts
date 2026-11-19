/**
 * 结构化编写四篇指南（#795，ADR 0058）：侧栏收录、三语 frontmatter，以及正文里的代码示例
 * 与当前依赖的 aster-lang-ts 行为一致——示例能编译并按文中所说求值，文中写的报错码确实会出现，
 * LayoutMap 示例按包的 validatePolicyLayout 合法、反例给出文中的错误码，规模上限与包常量一致。
 * 引擎行为一变（例如类型别名开始展开），这里先失败，提醒同步改文档。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compileAndTypecheck,
  DE_DE,
  EN_US,
  evaluate,
  ZH_CN,
  type Lexicon,
} from '@aster-cloud/aster-lang-ts/browser';
import type { DomainVocabulary } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
import { LAYOUT_LIMITS, parseLayout, validatePolicyLayout } from '@aster-cloud/aster-lang-ts/layout';
import { docsSidebar } from '@/lib/docs/sidebar';

const GUIDES = join(process.cwd(), 'src/app/[locale]/docs/guides');
const LOCALES = ['en', 'zh', 'de'] as const;
const SLUGS = ['domain-modelling', 'domain-vocabulary', 'display-layouts', 'structured-authoring-admin'] as const;

function read(slug: string, locale: string): string {
  return readFileSync(join(GUIDES, slug, `${locale}.mdx`), 'utf8');
}

function frontmatter(src: string): Record<string, string> {
  const block = src.match(/^---\n([\s\S]*?)\n---\n/);
  if (!block) return {};
  return Object.fromEntries(
    block[1]
      .split('\n')
      .map((line) => line.match(/^(\w+):\s*"?(.*?)"?$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => [m[1], m[2]]),
  );
}

/** 页面里全部围栏代码块（含语言标记），按出现顺序。 */
function codeBlocks(src: string): Array<{ lang: string; body: string }> {
  return [...src.matchAll(/```([a-z]*)\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1]!, body: m[2]! }));
}

/** 按模块关键词判定示例的策略语言。 */
function lexiconOf(source: string): Lexicon | null {
  if (source.startsWith('Module ')) return EN_US;
  if (source.startsWith('Modul ')) return DE_DE;
  if (source.startsWith('模块 ')) return ZH_CN;
  return null;
}

function errorsOf(result: ReturnType<typeof compileAndTypecheck>): string[] {
  const all = [
    ...((result as { resolutionDiagnostics?: Array<{ severity: string; code: string }> }).resolutionDiagnostics ?? []),
    ...(result.typeErrors ?? []),
  ];
  return all.filter((d) => d.severity === 'error').map((d) => d.code as string);
}

describe('structured authoring guides: wiring', () => {
  it('侧栏收录四篇指南', () => {
    const hrefs = docsSidebar.flatMap((s) => s.items.map((i) => i.href as string));
    for (const slug of SLUGS) expect(hrefs).toContain(`guides/${slug}`);
  });

  it.each(SLUGS.flatMap((slug) => LOCALES.map((locale) => [slug, locale] as const)))(
    '%s/%s.mdx 有 title / description，页面包装器存在',
    (slug, locale) => {
      expect(existsSync(join(GUIDES, slug, 'page.tsx'))).toBe(true);
      const fm = frontmatter(read(slug, locale));
      expect(fm.title).toBeTruthy();
      expect(fm.description).toBeTruthy();
    },
  );
});

describe('domain modelling guide', () => {
  it.each(LOCALES)('%s：三种语言的完整示例都能编译，并按文中所说求值', (locale) => {
    const examples = codeBlocks(read('domain-modelling', locale))
      .map((b) => b.body)
      .filter((body) => lexiconOf(body) !== null);
    expect(examples.map((body) => lexiconOf(body))).toEqual([EN_US, DE_DE, ZH_CN]);
    for (const source of examples) {
      const result = compileAndTypecheck(source, { lexicon: lexiconOf(source)! });
      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(errorsOf(result)).toEqual([]);
      const core = result.core!;
      expect(core.decls.map((d) => d.kind)).toEqual(expect.arrayContaining(['Import', 'Data', 'Func']));
      const fn = core.decls.find((d) => d.kind === 'Func')!;
      const param = (fn as unknown as { params: Array<{ name: string }> }).params[0]!.name;
      const data = core.decls.find((d) => d.kind === 'Data') as unknown as { fields: Array<{ name: string }> };
      const scoreField = data.fields[2]!.name;
      const applicant = (score: number) => ({ [param]: { [data.fields[0]!.name]: 'A', [data.fields[1]!.name]: 1.5, [scoreField]: score } });
      expect(evaluate(core, fn.name, applicant(720))).toMatchObject({ success: true, value: true });
      expect(evaluate(core, fn.name, applicant(650))).toMatchObject({ success: true, value: false });
    }
  });

  it.each(LOCALES)('%s：同名的导入别名与类型别名报 E807', (locale) => {
    const clash = codeBlocks(read('domain-modelling', locale)).find((b) => b.body.startsWith('Use aster.lib as Score.'));
    expect(clash).toBeDefined();
    const result = compileAndTypecheck(`Module m.\n\n${clash!.body}\nRule f given x as Int, produce Int:\n  Return x.\n`);
    expect(result.success).toBe(false);
    expect(errorsOf(result)).toContain('E807');
  });

  it('Define … has 与小写 type 均被接受；声明 Int 却返回别名类型报 E003（文中的提示）', () => {
    const has = compileAndTypecheck(
      'Module m.\n\ntype Score as Int.\n\nDefine Applicant has name as Text, income as Float.\n\nRule f given s as Score, produce Score:\n  Return s.\n',
    );
    expect(has.success).toBe(true);
    expect(errorsOf(has)).toEqual([]);
    const mismatch = compileAndTypecheck('Module m.\n\nType Score as Int.\n\nRule f given s as Score, produce Int:\n  Return s.\n');
    expect(errorsOf(mismatch)).toContain('E003');
  });
});

describe('domain vocabulary guide', () => {
  // 与文中列出的三个词条一致
  const vocabulary = {
    id: 'kfz',
    name: 'Kfz',
    locale: 'de-DE',
    version: '1',
    structs: [{ canonical: 'Driver', localized: 'Fahrer', kind: 'struct' }],
    fields: [{ canonical: 'age', localized: 'alter', kind: 'field', parent: 'Driver' }],
    functions: [{ canonical: 'eligible', localized: 'zugelassen', kind: 'function' }],
  } as const;

  it.each(LOCALES)('%s：德语示例按词条解析为 Driver / age / eligible，参数名不被改写', (locale) => {
    const source = codeBlocks(read('domain-vocabulary', locale)).find((b) => b.body.startsWith('Modul '))!.body;
    const result = compileAndTypecheck(source, { lexicon: DE_DE, vocabulary: vocabulary as unknown as DomainVocabulary });
    expect(result.success, JSON.stringify(result)).toBe(true);
    const core = result.core!;
    const data = core.decls.find((d) => d.kind === 'Data') as unknown as { name: string; fields: Array<{ name: string }> };
    expect(data.name).toBe('Driver');
    expect(data.fields.map((f) => f.name)).toEqual(['age']);
    const fn = core.decls.find((d) => d.kind === 'Func') as unknown as { name: string; params: Array<{ name: string }> };
    expect(fn.name).toBe('eligible');
    expect(fn.params.map((p) => p.name)).toEqual(['fahrer']);
    expect(evaluate(core, fn.name, { fahrer: { age: 20 } })).toMatchObject({ success: true, value: true });
  });
});

describe('display layouts guide', () => {
  function example(locale: string) {
    const blocks = codeBlocks(read('display-layouts', locale));
    const layout = parseLayout(blocks.find((b) => b.lang === 'json')!.body.trim());
    // 围栏代码块末尾的换行不属于源码
    const source = blocks.find((b) => b.lang === '' && b.body.startsWith('Module '))!.body.replace(/\n$/, '');
    return { layout, source };
  }

  it.each(LOCALES)('%s：示例 layout 对示例源码通过全部保存校验', (locale) => {
    const { layout, source } = example(locale);
    expect(validatePolicyLayout(layout, source, EN_US)).toEqual({ ok: true });
    expect(compileAndTypecheck(source).success).toBe(true);
  });

  it.each(LOCALES)('%s：把 0.8 标为结构 span 报 layout_structural_hides_value', (locale) => {
    const { source } = example(locale);
    const at = source.indexOf('0.8');
    const hidden = {
      v: 1 as const,
      spans: [
        { text: source.slice(0, at) },
        { canonical: '0.8', display: '20% off' },
        { text: source.slice(at + 3) },
      ],
    };
    expect(validatePolicyLayout(hidden, source, EN_US)).toMatchObject({ ok: false, code: 'layout_structural_hides_value' });
  });

  it.each(LOCALES)('%s：列出全部错误码，规模上限与包的 LAYOUT_LIMITS 一致', (locale) => {
    const src = read('display-layouts', locale);
    for (const code of [
      'layout_invalid_format',
      'layout_too_large',
      'layout_roundtrip_mismatch',
      'layout_structural_hides_value',
      'layout_content_parity',
      'structured_authoring_required',
    ]) {
      expect(src).toContain(`\`${code}\``);
    }
    // 去掉千位分隔符（, . 空格）后比较数字
    const digits = src.replace(/(\d)[,.   ](?=\d{3}\b)/g, '$1');
    for (const value of Object.values(LAYOUT_LIMITS)) {
      expect(digits, String(value)).toMatch(new RegExp(`\\b${value}\\b`));
    }
  });
});

describe('structured authoring admin guide', () => {
  it.each(LOCALES)('%s：说明管理页路径与审计事件', (locale) => {
    const src = read('structured-authoring-admin', locale);
    expect(src).toContain('/admin/capabilities/structured-authoring');
    for (const action of ['capability.grant', 'capability.revoke', 'capability.allotment.update', 'platform_setting.update']) {
      expect(src).toContain(`\`${action}\``);
    }
  });
});

describe('structured authoring guides: cross-page anchors', () => {
  /** 与 mdx-in-page-anchors.test.ts 相同的 github-slugger 规则 */
  function slug(heading: string): string {
    return heading
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
      .replace(/ /g, '-');
  }

  function headingIds(src: string): Set<string> {
    const body = src.replace(/```[\s\S]*?```/g, '');
    return new Set([...body.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slug(m[1]!)));
  }

  it.each(LOCALES)('%s：指向四篇指南的 #锚点都落在同语言目标页的真实标题上', (locale) => {
    const broken: string[] = [];
    for (const from of SLUGS) {
      for (const m of read(from, locale).matchAll(/\]\(\/docs\/guides\/([a-z-]+)#([^)\s]+)\)/g)) {
        const [, target, anchor] = m;
        if (!(SLUGS as readonly string[]).includes(target!)) continue;
        if (!headingIds(read(target!, locale)).has(decodeURIComponent(anchor!))) broken.push(`${from} → ${target}#${anchor}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
