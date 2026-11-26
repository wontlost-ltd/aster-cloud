// 解析错误（E050–E069）按诊断 code + params 本地化（aster-cloud#660）：不再反查英文消息。
// 句子模板来自 @aster-cloud/ui-messages 的 syntax-diagnostics 目录；params 中 kw.* 按策略词法的关键词、
// token.* 按目录名词、带引号的字面标点按目标词法写法渲染；任一部分缺译文时回退引擎英文消息。
import { describe, it, expect } from 'vitest';
import enCatalog from '@aster-cloud/ui-messages/syntax-diagnostics/en-US.json';
import zhCatalog from '@aster-cloud/ui-messages/syntax-diagnostics/zh-CN.json';
import deCatalog from '@aster-cloud/ui-messages/syntax-diagnostics/de-DE.json';
import hiCatalog from '@aster-cloud/ui-messages/syntax-diagnostics/hi-IN.json';
import { compileAndTypecheck, DE_DE, HI_IN, ZH_CN, type Lexicon } from '@aster-cloud/aster-lang-ts/browser';
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

  it('ADR 0055 注解诊断：E900 参数重复、E067 参数值类型非法', () => {
    expect(localizeSyntaxDiagnostic(d('E900', { annotation: 'id', name: 'name' }, 'Annotation @id repeats the argument name'), 'zh-CN'))
      .toBe('注解 @id 重复给出了参数 name');
    expect(localizeSyntaxDiagnostic(
      d('E067', { construct: 'token.annotationArgumentValue', value: '1.5', allowed: 'string, Int or Bool' }, 'x'), 'zh-CN'))
      .toBe('无效的注解参数值 1.5；允许的取值：string, Int or Bool');
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

// E901 / E902 的参数形状取自 aster-lang-ts 3.8.0：E901 `{ keyword: 'kw.<槽位>', kind: '<SemanticTokenKind>' }`
// （parse-issue keywordAsNameIssue）；E902 `{ reason }`，invalid_char 另带 `char: "'<源码字符>'"`（diagnostics invalidEscape）
describe('E901 关键词作名字（ADR 0056 修订 A6 K1）', () => {
  const e901 = d('E901', { keyword: 'kw.return', kind: 'RETURN' },
    "'Return' is the keyword RETURN and cannot be used as a name; write it in backticks to use it as a name");

  it.each([
    ['en-US', e901.message],
    ['zh-CN', "'返回' 是关键词 RETURN，不能用作名字；写成反引号形式即可用作名字"],
    ['de-DE', "'gib zurueck' ist das Schlüsselwort RETURN und kann nicht als Name verwendet werden; schreiben Sie ihn in Backticks, um ihn als Namen zu verwenden"],
    ['hi-IN', "'लौटाएं' कीवर्ड RETURN है और नाम के रूप में उपयोग नहीं किया जा सकता; इसे नाम के रूप में उपयोग करने के लिए बैकटिक में लिखें"],
  ])('%s', (locale, expected) => {
    expect(localizeSyntaxDiagnostic(e901, locale)).toBe(expected);
  });

  it('8 个结构关键词槽位都能按目标词法渲染（不回退英文）', () => {
    const slots = ['define', 'if', 'let', 'match', 'otherwise', 'return', 'rule', 'when'];
    for (const locale of ['zh-CN', 'de-DE', 'hi-IN']) {
      for (const slot of slots) {
        const message = `'${slot}' is the keyword X and cannot be used as a name`;
        expect(localizeSyntaxDiagnostic(d('E901', { keyword: `kw.${slot}`, kind: 'X' }, message), locale), `${locale} ${slot}`)
          .not.toBe(message);
      }
    }
  });
});

describe('E902 名字转义格式错误（ADR 0064 N1a）', () => {
  const unterminated = d('E902', { reason: 'unterminated' }, 'Invalid name escape: the closing backtick is missing');
  const empty = d('E902', { reason: 'empty' }, 'Invalid name escape: nothing is written between the backticks');
  const invalidChar = d('E902', { reason: 'invalid_char', char: "'.'" }, "Invalid name escape: '.' cannot be part of a name");

  it.each([
    ['en-US', unterminated, unterminated.message],
    ['en-US', empty, empty.message],
    ['en-US', invalidChar, invalidChar.message],
    ['zh-CN', unterminated, '名字转义无效：缺少闭合的反引号'],
    ['zh-CN', empty, '名字转义无效：两个反引号之间没有内容'],
    // 非法字符是源码原文：'.' 不换成 zh 句号 '。'
    ['zh-CN', invalidChar, "名字转义无效：'.' 不能出现在名字里"],
    ['de-DE', unterminated, 'Ungültiges Namens-Escape: der schließende Backtick fehlt'],
    ['de-DE', empty, 'Ungültiges Namens-Escape: zwischen den Backticks steht nichts'],
    ['de-DE', invalidChar, "Ungültiges Namens-Escape: '.' darf nicht in einem Namen vorkommen"],
    ['hi-IN', unterminated, 'अमान्य नाम एस्केप: समापन बैकटिक नहीं है'],
    ['hi-IN', empty, 'अमान्य नाम एस्केप: बैकटिक के बीच कुछ नहीं लिखा है'],
    ['hi-IN', invalidChar, "अमान्य नाम एस्केप: '.' नाम का हिस्सा नहीं हो सकता"],
  ])('%s %#', (locale, diagnostic, expected) => {
    expect(localizeSyntaxDiagnostic(diagnostic, locale)).toBe(expected);
  });

  it('名词句的占位符不二次替换、不换标点；汉字字符照常补空格', () => {
    expect(localizeSyntaxDiagnostic(d('E902', { reason: 'invalid_char', char: "'{reason}'" }, 'x'), 'de-DE'))
      .toBe("Ungültiges Namens-Escape: '{reason}' darf nicht in einem Namen vorkommen");
    expect(localizeSyntaxDiagnostic(d('E902', { reason: 'invalid_char', char: "'，'" }, 'x'), 'zh-CN'))
      .toBe("名字转义无效：'，' 不能出现在名字里");
  });

  it('未收录的 reason、invalid_char 缺 char 时退回引擎英文消息', () => {
    for (const locale of ['zh-CN', 'de-DE', 'hi-IN']) {
      expect(localizeSyntaxDiagnostic(d('E902', { reason: 'multiline' }, 'Invalid name escape: future'), locale))
        .toBe('Invalid name escape: future');
      expect(localizeSyntaxDiagnostic(d('E902', { reason: 'toString' }, 'Invalid name escape: proto'), locale))
        .toBe('Invalid name escape: proto');
      expect(localizeSyntaxDiagnostic(d('E902', { reason: 'invalid_char' }, 'Invalid name escape: no char'), locale))
        .toBe('Invalid name escape: no char');
      expect(localizeSyntaxDiagnostic(d('E902', {}, 'Invalid name escape: no reason'), locale))
        .toBe('Invalid name escape: no reason');
    }
  });
});

describe('W802 关键词被改名为名字（ADR 0056 修订 A6 K3）：引擎 overlay 已本地化，与目录 keywordRenamedAsName 一致', () => {
  const catalogs: Record<string, Record<string, string>> = { 'zh-CN': zhCatalog, 'de-DE': deCatalog, 'hi-IN': hiCatalog };
  it.each([
    ['zh-CN', ZH_CN, '模块 m。\n\n定义 软件 包含 版本 作为 整数。\n', "'版本' 被读作关键词 IMPORT_VERSION：名字变为 'version'"],
    ['de-DE', DE_DE, 'Modul m.\n\nDefiniere Software mit erlauben als Ganzzahl.\n', "'erlauben' wird als Schlüsselwort ALLOW gelesen: Der Name wird zu 'allow'"],
    ['hi-IN', HI_IN, 'मॉड्यूल m।\n\nपरिभाषित Applicant रखता है अनुमति रूप में पूर्णांक।\n', "'अनुमति' को कीवर्ड ALLOW के रूप में पढ़ा जाता है: नाम 'allow' हो जाता है"],
  ] as const)('%s', (locale, lexicon: Lexicon, source, expected) => {
    const result = compileAndTypecheck(source, { lexicon });
    const [w802] = collectCompileDiagnostics(result as Parameters<typeof collectCompileDiagnostics>[0], locale);
    expect(w802).toMatchObject({ severity: 'warning', code: 'W802', message: expected });
    // 引擎 overlay 与 locales 目录是同一份文案：用目录模板按诊断 data 填出来逐字相同
    const data = (result.resolutionDiagnostics![0] as { data: Record<string, string> }).data;
    expect(catalogs[locale]!.keywordRenamedAsName!.replace(/\{(\w+)\}/g, (_w, name: string) => data[name]!)).toBe(expected);
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
  // ADR 0055：注解参数值只允许字符串 / Int / Bool（E067），同名参数重复（E900）；取自 aster-lang-ts 2.0.0
  ['E067', { construct: 'token.annotationArgumentValue', value: '1.5', allowed: 'string, Int or Bool' }, 'Annotation argument value must be a string, Int or Bool: 1.5'],
  ['E900', { annotation: 'id', name: 'name' }, 'Annotation @id repeats the argument name'],
  // ADR 0056 修订 A6 K1 / ADR 0064 N1a；取自 aster-lang-ts 3.8.0
  ['E901', { keyword: 'kw.if', kind: 'IF' }, "'If' is the keyword IF and cannot be used as a name; write it in backticks to use it as a name"],
  ['E902', { reason: 'unterminated' }, 'Invalid name escape: the closing backtick is missing'],
  ['E902', { reason: 'empty' }, 'Invalid name escape: nothing is written between the backticks'],
  ['E902', { reason: 'invalid_char', char: "'.'" }, "Invalid name escape: '.' cannot be part of a name"],
];

describe('E050–E069 与 E900–E902 逐码覆盖（zh / de / hi）', () => {
  it.each(BY_CODE)('%s', (code, params, message) => {
    for (const locale of ['zh-CN', 'de-DE', 'hi-IN']) {
      const out = localizeSyntaxDiagnostic({ code, params, message }, locale);
      expect(out, locale).not.toBe(message);
    }
  });
});
