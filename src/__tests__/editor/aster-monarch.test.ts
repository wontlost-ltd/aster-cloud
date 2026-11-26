/**
 * 策略编辑器的 Monarch 着色（ADR 0064 §6，ADR 0058 修订 3 E5/E7）：用真实 Monaco 的 tokenize 跑 buildAsterMonarchLanguage。
 * - 名字转义 `x` 着色为淡化的定界符 + 转义名，排在关键词规则之前（否则 `如果` 会被当关键词）；
 * - 字符串、注释里的反引号与未闭合的反引号不是转义；
 * - 没有反引号的源码（内置模板、示例）着色与去掉转义规则的旧规则逐 token 相同。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { getLexicon, type Lexicon } from '@/lib/aster-lexicon';
import { buildAsterMonarchLanguage, ESCAPE_DELIMITER_TOKEN, ESCAPED_NAME_TOKEN } from '@/lib/editor/aster-monarch';
import { POLICY_EXAMPLES, type SupportedLocale } from '@/data/policy-examples';

type MonacoApi = typeof import('monaco-editor');
let monaco: MonacoApi;

beforeAll(async () => {
  // jsdom 没有 matchMedia；Monaco 的主题服务启动时会查询高对比度偏好
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  monaco = (await import('monaco-editor/editor/editor.api.js')) as unknown as MonacoApi;
  // 首次加载 Monaco 要转换数百个模块，全量并发跑时远超默认 10 s 的钩子超时
}, 120_000);

let seq = 0;
/** 注册一门临时语言并 tokenize，返回每行的 [文本, token] 序列。 */
function tokens(language: import('monaco-editor').languages.IMonarchLanguage, text: string): Array<Array<[string, string]>> {
  const id = `aster-monarch-test-${seq++}`;
  monaco.languages.register({ id });
  monaco.languages.setMonarchTokensProvider(id, language);
  const lines = text.split('\n');
  return monaco.editor.tokenize(text, id).map((line, i) =>
    line.map((tok, j) => {
      const end = j + 1 < line.length ? line[j + 1].offset : lines[i].length;
      return [lines[i].slice(tok.offset, end), tok.type.replace(/\.aster-monarch-test-\d+$/, '')] as [string, string];
    }),
  );
}

const lang = (locale: string) => buildAsterMonarchLanguage(getLexicon(locale) as Lexicon);

/** 去掉转义规则的同一套规则（引入转义之前的着色）。 */
function withoutEscapeRule(language: import('monaco-editor').languages.IMonarchLanguage) {
  const root = (language.tokenizer.root as unknown[]).filter(
    (rule) => !(Array.isArray(rule) && Array.isArray(rule[1]) && rule[1].includes(ESCAPE_DELIMITER_TOKEN)),
  );
  return { ...language, tokenizer: { ...language.tokenizer, root } } as typeof language;
}

describe('名字转义着色', () => {
  it('zh：`版本` 与 `如果` 是转义名，不是关键词（快照）', () => {
    const src = '定义 软件 包含 `版本` 作为 整数。\n规则 取值 给定 `如果` 作为 整数，产出 整数：\n  返回 `如果`。';
    const result = tokens(lang('zh-CN'), src);
    expect(result[0]).toContainEqual(['版本', ESCAPED_NAME_TOKEN]);
    expect(result[1]).toContainEqual(['如果', ESCAPED_NAME_TOKEN]);
    expect(result[1].filter(([, t]) => t === ESCAPE_DELIMITER_TOKEN).map(([s]) => s)).toEqual(['`', '`']);
    expect(result).toMatchSnapshot();
  });

  it('en / de / hi：转义名紧贴标点与限定名的一段（快照）', () => {
    expect(tokens(lang('en-US'), 'Rule f given `type` as Int, produce Int:\n  Return s.`Given`.')).toMatchSnapshot();
    expect(tokens(lang('de-DE'), 'Definiere Antrag mit `wenn` als Int.')).toMatchSnapshot();
    expect(tokens(lang('hi-IN'), 'परिभाषित Software सहित `अनुमति` रूप में Int।')).toMatchSnapshot();
  });

  it('不带空白也自定界：床前`当`明月光 是三个 token', () => {
    const [line] = tokens(lang('zh-CN'), '床前`当`明月光');
    expect(line).toEqual([
      ['床前', 'identifier'],
      ['`', ESCAPE_DELIMITER_TOKEN],
      ['当', ESCAPED_NAME_TOKEN],
      ['`', ESCAPE_DELIMITER_TOKEN],
      ['明月光', 'identifier'],
    ]);
  });

  it('字符串、注释里的反引号与未闭合 / 含空白的反引号不是转义', () => {
    const src = '返回 「a`b`c」。\n# 注释 `当`\nReturn "x `y` z".\nLet `a b` be 1.\nReturn `open';
    const flat = tokens(lang('zh-CN'), src).flat();
    expect(flat.some(([, t]) => t === ESCAPED_NAME_TOKEN || t === ESCAPE_DELIMITER_TOKEN)).toBe(false);
  });
});

describe('没有反引号的源码：着色与引入转义之前逐 token 相同', () => {
  it.each(['en-US', 'zh-CN', 'de-DE', 'hi-IN'])('%s 的内置示例', (locale) => {
    const language = lang(locale);
    const legacy = withoutEscapeRule(language);
    // 示例没有 hi-IN 版本：hi 的规则跑全部语言的示例（关键词表不同，仍检验转义规则不改变无反引号源码的着色）
    const sources = POLICY_EXAMPLES.flatMap((e) =>
      locale in e.sources ? [e.sources[locale as SupportedLocale]] : Object.values(e.sources),
    ).filter((s) => !s.includes('`'));
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) expect(tokens(language, source)).toEqual(tokens(legacy, source));
  });
});
