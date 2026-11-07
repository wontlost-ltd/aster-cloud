// 解析错误（E050–E069）按诊断 code + params 本地化（aster-cloud#660）：不再反查英文消息。
// 句子模板来自 @aster-cloud/ui-messages 的 syntax-diagnostics 目录；params 中 kw.* 按策略词法的关键词、
// token.* 按目录名词、带引号的字面标点按目标词法写法渲染；任一部分缺译文时回退引擎英文消息。
import { describe, it, expect } from 'vitest';
import enCatalog from '@aster-cloud/ui-messages/syntax-diagnostics/en-US.json';
import zhCatalog from '@aster-cloud/ui-messages/syntax-diagnostics/zh-CN.json';
import deCatalog from '@aster-cloud/ui-messages/syntax-diagnostics/de-DE.json';
import hiCatalog from '@aster-cloud/ui-messages/syntax-diagnostics/hi-IN.json';
import { localizeSyntaxDiagnostic, SYNTAX_MESSAGE_KEYS } from '@/lib/syntax-diagnostic-message';
import { collectCompileDiagnostics } from '@/hooks/useAsterCompiler';

const d = (code: string, params: Record<string, string | number>, message: string) => ({ code, params, message });

describe('localizeSyntaxDiagnostic（四种语言各一例）', () => {
  it('en-US：保持引擎英文原文', () => {
    expect(localizeSyntaxDiagnostic(d('E059', { token: "'.'" }, "Expected '.' at end of statement"), 'en-US'))
      .toBe("Expected '.' at end of statement");
  });

  it('zh-CN：kw.* 按中文关键词渲染，引号与汉字间补空格', () => {
    expect(localizeSyntaxDiagnostic(d('E056', { token: 'kw.return', after: 'kw.then' }, "Expected 'Return' after 'then'"), 'zh-CN'))
      .toBe("'那么' 之后应为 '返回'");
  });

  it('de-DE：token.* 按目录名词渲染', () => {
    expect(localizeSyntaxDiagnostic(d('E056', { token: 'token.identifier', after: 'token.dot' }, 'Expected identifier after dot'), 'de-DE'))
      .toBe('Nach Punkt wird Bezeichner erwartet');
  });

  it('hi-IN：字面标点按目标词法写法（. → ।）', () => {
    expect(localizeSyntaxDiagnostic(d('E059', { token: "'.'" }, "Expected '.' at end of statement"), 'hi-IN'))
      .toBe("कथन के अंत में '।' अपेक्षित है");
  });
});

describe('localizeSyntaxDiagnostic 边界', () => {
  it('zh 句末 / 块起始 / 列表分隔标点按 zh 写法', () => {
    expect(localizeSyntaxDiagnostic(d('E055', { token: "','" }, "Expected ','"), 'zh-CN')).toBe("此处应为 '，'");
    expect(localizeSyntaxDiagnostic(d('E056', { token: "':'", after: 'kw.then' }, "Expected ':' after 'then'"), 'zh-CN'))
      .toBe("'那么' 之后应为 '：'");
  });

  it('E064 的固定构造按整句文案', () => {
    expect(localizeSyntaxDiagnostic(d('E064', { construct: 'token.statement' }, 'Unknown statement'), 'zh-CN')).toBe('无法识别的语句');
    expect(localizeSyntaxDiagnostic(d('E064', { construct: 'token.topLevelToken' }, 'Unexpected token at top level'), 'de-DE'))
      .toBe('Unerwartetes Token auf oberster Ebene');
  });

  it('数字参数原样代入；用户文本里的 {占位符} 不二次替换', () => {
    expect(localizeSyntaxDiagnostic(d('E056', { token: "'{after}'", after: "'{token}'" }, 'x'), 'de-DE'))
      .toBe("Nach '{token}' wird '{after}' erwartet");
  });

  it('缺译文回退：名词未收录、码无模板、无 code、未收录语言', () => {
    expect(localizeSyntaxDiagnostic(d('E056', { token: 'token.noSuchNoun', after: 'token.effectClause' }, "Expected no such noun after effect clause"), 'zh-CN'))
      .toBe('Expected no such noun after effect clause');
    // E050–E069 已全部有模板（ui-messages 1.0.30），用码表外的码代表「码无模板」
    expect(localizeSyntaxDiagnostic(d('E099', { name: "'x'" }, 'Some future diagnostic'), 'zh-CN'))
      .toBe('Some future diagnostic');
    // 无码时退回英文句型翻译
    expect(localizeSyntaxDiagnostic({ message: 'Expected identifier' }, 'zh-CN')).toBe('此处应为标识符');
    expect(localizeSyntaxDiagnostic({ message: 'Profile id must match /x/: y' }, 'zh-CN')).toBe('Profile id must match /x/: y');
    expect(localizeSyntaxDiagnostic(d('E055', { token: 'token.identifier' }, 'Expected identifier'), 'fr-FR')).toBe('Expected identifier');
    expect(localizeSyntaxDiagnostic(d('E055', { token: 'token.identifier' }, 'Expected identifier'), undefined)).toBe('Expected identifier');
  });

  it('未知关键词参数回退英文', () => {
    // 按码渲染失败后退回英文句型：引号片段原样保留
    expect(localizeSyntaxDiagnostic(d('E055', { token: 'kw.nosuchword' }, "Expected 'nosuchword'"), 'zh-CN')).toBe("此处应为 'nosuchword'");
    expect(localizeSyntaxDiagnostic(d('E055', { token: 'kw.nosuchword' }, 'Expected nosuchword'), 'zh-CN')).toBe('Expected nosuchword');
  });
});

describe('collectCompileDiagnostics 按 code + params 本地化解析错误', () => {
  it('★解析错误按 zh-CN 译出并保留引擎码，降级诊断（引擎已按 lexicon 本地化）与类型诊断原样', () => {
    const lowering = { severity: 'error', code: 'E602', message: 'lowerStmt：未处理的语句种类 \'X\'', data: { kind: 'X' } };
    const out = collectCompileDiagnostics({
      parseErrors: [d('E059', { token: "'.'" }, "Expected '.' at end of statement")],
      loweringErrors: ['legacy string must be ignored'],
      loweringDiagnostics: [lowering],
      typeErrors: [{ severity: 'error', code: 'E003', message: 'Undefined variable: x' }],
    } as never, 'zh-CN');
    expect(out.map((x) => x.message)).toEqual(["语句末尾应为 '。'", lowering.message, 'Undefined variable: x']);
    expect(out.map((x) => x.code)).toEqual(['E059', 'E602', 'E003']);
  });

  it('无 code 的解析错误码为 E000、按英文句型翻译', () => {
    const out = collectCompileDiagnostics({ parseErrors: [{ message: 'Expected identifier' }] } as never, 'zh-CN');
    expect(out[0]).toMatchObject({ code: 'E000', message: '此处应为标识符' });
  });
});

describe('syntax-diagnostics 目录（aster-lang-locales 唯一真相源）', () => {
  it.each([
    ['en-US', enCatalog],
    ['zh-CN', zhCatalog],
    ['de-DE', deCatalog],
    ['hi-IN', hiCatalog],
  ])('%s 含按码取用的全部 key', (_locale, catalog) => {
    for (const key of SYNTAX_MESSAGE_KEYS) {
      expect((catalog as Record<string, string>)[key], key).toBeTruthy();
    }
  });
});

// E050–E069 每个码一条代表性诊断（参数与英文原句取自 aster-lang-ts 1.4.0 解析器 / 词法器）
const BY_CODE: ReadonlyArray<readonly [string, Record<string, string | number>, string]> = [
  ['E050', { char: "'§'" }, "Unexpected character '§'"],
  ['E051', {}, 'Unterminated string literal'],
  ['E052', {}, 'Incorrect indentation: one level too deep or inconsistent. Indent with 2 spaces'],
  ['E053', { kind: 'Int', literal: '99999999999' }, 'Int literal 99999999999 is out of range'],
  ['E054', { limit: 64 }, 'Nesting is too deep (limit 64)'],
  ['E055', { token: 'token.identifier' }, 'Expected identifier'],
  ['E056', { token: 'token.identifier', after: 'token.dot' }, 'Expected identifier after dot'],
  ['E057', { token: "'set to'", context: 'token.construction' }, "Expected 'set to' in construction"],
  ['E058', { token: 'kw.then', after: 'kw.if', context: 'token.construction' }, "Expected 'then' after 'if' in construction"],
  ['E059', { token: "'.'" }, "Expected '.' at end of statement"],
  ['E060', { token: "'.'", before: 'token.newline' }, "Expected '.' before newline"],
  ['E061', { token: "')'" }, "Unexpected ')'"],
  ['E062', { token: "')'", expected: 'token.expression' }, "Unexpected ')'; expected expression"],
  ['E063', { token: "'='" }, "Cannot parse the syntax near '='"],
  ['E064', { construct: 'token.statement' }, 'Unknown statement'],
  ['E065', { construct: 'kw.otherwise', position: 'token.lastInBlock' }, 'Otherwise must be the last statement of its block'],
  ['E066', { block: 'token.functionBody', item: 'token.statement' }, 'Expected at least one statement in function body'],
  ['E067', { construct: 'kw.timeout', value: -1, allowed: 'token.nonNegativeInteger' }, 'Timeout value must be non-negative'],
  ['E068', { callee: "'+'", expected: 2, actual: 3 }, "'+' takes exactly 2 argument(s), got 3"],
  ['E069', { kind: 'token.retryDirective', name: "'x'" }, 'Unknown retry directive'],
];

describe('E050–E069 逐码覆盖（zh / de / hi）', () => {
  it.each(BY_CODE)('%s', (code, params, message) => {
    for (const locale of ['zh-CN', 'de-DE', 'hi-IN']) {
      const out = localizeSyntaxDiagnostic({ code, params, message }, locale);
      expect(out, locale).not.toBe(message);
    }
  });
});
