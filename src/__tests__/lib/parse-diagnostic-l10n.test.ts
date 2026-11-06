// E000（解析错误兜底）按策略 lexicon 语言本地化（第 4 轮生产复测：中文源码的语法错误仍是英文）。
// 解析器只在关键词槽位用作者语言（如 '返回'），句子骨架恒为英文；这里按句型翻译骨架与常见名词，
// 引号内的符号 / 关键词原样保留。文案来自 aster-lang-locales 的 syntax-diagnostics 目录（随
// @aster-cloud/ui-messages 分发，与服务端 aster-api 同一份，wontlost-ltd/aster-api#423）。
import { describe, it, expect } from 'vitest';
import enCatalog from '@aster-cloud/ui-messages/syntax-diagnostics/en-US.json';
import zhCatalog from '@aster-cloud/ui-messages/syntax-diagnostics/zh-CN.json';
import deCatalog from '@aster-cloud/ui-messages/syntax-diagnostics/de-DE.json';
import hiCatalog from '@aster-cloud/ui-messages/syntax-diagnostics/hi-IN.json';
import { localizeParseMessage, PARSE_MESSAGE_KEYS } from '@/lib/parse-diagnostic-l10n';
import { collectCompileDiagnostics } from '@/hooks/useAsterCompiler';

describe('localizeParseMessage', () => {
  it.each([
    ["Expected '.' at end of statement", "语句末尾应为 '。'", "Am Ende der Anweisung wird '.' erwartet", "कथन के अंत में '।' अपेक्षित है"],
    ["Expected '.' or ':' after return type", "返回类型之后应为 '。' 或 '：'", "Nach Rückgabetyp wird '.' oder ':' erwartet", "रिटर्न प्रकार के बाद '।' या ':' अपेक्षित है"],
    ["Expected '返回' after '那么'", "'那么' 之后应为 '返回'", "Nach '那么' wird '返回' erwartet", "'那么' के बाद '返回' अपेक्षित है"],
    ["Expected 'set to' in construction", "构造中应为 'set to'", "In Konstruktion wird 'set to' erwartet", "निर्माण में 'set to' अपेक्षित है"],
    ['Expected identifier', '此处应为标识符', 'Bezeichner erwartet', 'पहचानकर्ता अपेक्षित है'],
    ['Expected identifier after dot', '点之后应为标识符', 'Nach Punkt wird Bezeichner erwartet', 'बिंदु के बाद पहचानकर्ता अपेक्षित है'],
    ['Expected type', '此处应为类型', 'Typ erwartet', 'प्रकार अपेक्षित है'],
    ['Unknown statement', '无法识别的语句', 'Unbekannte Anweisung', 'अज्ञात कथन'],
    ['Unexpected token at top level', '顶层出现意外的记号', 'Unerwartetes Token auf oberster Ebene', 'शीर्ष स्तर पर अप्रत्याशित टोकन'],
    ['Unexpected expression', '意外的表达式', 'Unerwarteter Ausdruck', 'अप्रत्याशित व्यंजक'],
    ["Unexpected ')'", "意外的 ')'", "Unerwartet: ')'", "अप्रत्याशित ')'"],
    ["Expected ','", "此处应为 '，'", "',' erwartet", "',' अपेक्षित है"],
    ["Expected ':' after '那么'", "'那么' 之后应为 '：'", "Nach '那么' wird ':' erwartet", "'那么' के बाद ':' अपेक्षित है"],
  ])('%s', (en, zh, de, hi) => {
    expect(localizeParseMessage(en, 'zh-CN')).toBe(zh);
    expect(localizeParseMessage(en, 'de-DE')).toBe(de);
    expect(localizeParseMessage(en, 'hi-IN')).toBe(hi);
  });

  it('★zh 词法下引号里的标点按 zh 实际写法显示（句末 。、块起始 ：、列表分隔 ，），多字符引号片段与括号不动', () => {
    expect(localizeParseMessage("Expected '.' at end of statement", 'zh-CN')).toBe("语句末尾应为 '。'");
    expect(localizeParseMessage("Expected ')' after expression", 'zh-CN')).toBe("表达式之后应为 ')'");
    expect(localizeParseMessage("Expected '定义为' after '令'", 'zh-CN')).toBe("'令' 之后应为 '定义为'");
    expect(localizeParseMessage("Expected '..' after '.'", 'zh-CN')).toBe("'。' 之后应为 '..'");
  });

  it('de / en 的标点不受 zh 映射影响', () => {
    expect(localizeParseMessage("Expected '.' or ':' after return type", 'de-DE')).toBe("Nach Rückgabetyp wird '.' oder ':' erwartet");
    expect(localizeParseMessage("Expected ','", 'en-US')).toBe("Expected ','");
  });

  it('三槽句型切错时回退到两槽句型（引号里含 " in "）', () => {
    expect(localizeParseMessage("Expected 'x' after 'y in z'", 'zh-CN')).toBe("'y in z' 之后应为 'x'");
  });

  it('全角标点与引号相邻时不加空格', () => {
    expect(localizeParseMessage("Expected 'then' after 'if' in construction", 'zh-CN')).toBe("构造中，'if' 之后应为 'then'");
  });

  it('en-US 与未收录的语言原样返回', () => {
    expect(localizeParseMessage("Expected '.' at end of statement", 'en-US')).toBe("Expected '.' at end of statement");
    expect(localizeParseMessage("Expected '.' at end of statement", 'fr-FR')).toBe("Expected '.' at end of statement");
    expect(localizeParseMessage("Expected '.' at end of statement", undefined)).toBe("Expected '.' at end of statement");
  });

  it('★hi 有编辑器文案（此前只有 zh/de，hi 策略在编辑器里是英文、服务端却是印地语）', () => {
    expect(localizeParseMessage("Expected '.' at end of statement", 'hi-IN')).toBe("कथन के अंत में '।' अपेक्षित है");
  });

  it('用户文本里的 {占位符} 不会被二次替换', () => {
    expect(localizeParseMessage("Expected '{after}' after '{token}'", 'de-DE')).toBe("Nach '{token}' wird '{after}' erwartet");
  });

  it('不认识的句型原样返回（不产生半中半英的拼接）', () => {
    expect(localizeParseMessage('Profile id must match /x/: y', 'zh-CN')).toBe('Profile id must match /x/: y');
  });

  it('句型认识但名词未收录时也原样返回', () => {
    expect(localizeParseMessage('Expected flux capacitor after warp', 'de-DE')).toBe('Expected flux capacitor after warp');
  });

  it('已是中文的消息（解析器本就本地化的少数条目）原样返回', () => {
    expect(localizeParseMessage('前缀操作符调用需要 2 个参数，但实际为 3', 'zh-CN')).toBe('前缀操作符调用需要 2 个参数，但实际为 3');
  });
});

describe('syntax-diagnostics 目录（aster-lang-locales 唯一真相源）', () => {
  it.each([
    ['en-US', enCatalog],
    ['zh-CN', zhCatalog],
    ['de-DE', deCatalog],
    ['hi-IN', hiCatalog],
  ])('%s 含编辑器用到的全部 key', (_locale, catalog) => {
    for (const key of PARSE_MESSAGE_KEYS) {
      expect(catalog, key).toHaveProperty([key]);
      expect((catalog as Record<string, string>)[key], key).not.toBe('');
    }
  });
});

describe('降级错误（无码）经 collectCompileDiagnostics 仍按英文句型翻译', () => {
  it.each([
    ['zh-CN', '无法识别的语句'],
    ['de-DE', 'Unbekannte Anweisung'],
    ['hi-IN', 'अज्ञात कथन'],
  ])('%s', async (locale, expected) => {
    const { collectCompileDiagnostics } = await import('@/hooks/useAsterCompiler');
    const out = collectCompileDiagnostics({ loweringErrors: ['Unknown statement'] } as never, locale);
    expect(out[0]!.message).toBe(expected);
  });
});
