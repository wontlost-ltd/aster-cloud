// E000（解析错误兜底）按策略 lexicon 语言本地化（第 4 轮生产复测：中文源码的语法错误仍是英文）。
// 解析器只在关键词槽位用作者语言（如 '返回'），句子骨架恒为英文；这里按句型翻译骨架与常见名词，
// 引号内的符号 / 关键词原样保留。aster-lang-ts 给解析错误补错误码与 overlay 后应改走引擎译文。
import { describe, it, expect } from 'vitest';
import { localizeParseMessage } from '@/lib/parse-diagnostic-l10n';
import { collectCompileDiagnostics } from '@/hooks/useAsterCompiler';

describe('localizeParseMessage', () => {
  it.each([
    ["Expected '.' at end of statement", '语句末尾应为 \'.\'', "Am Ende der Anweisung wird '.' erwartet"],
    ["Expected '.' or ':' after return type", "返回类型之后应为 '.' 或 ':'", "Nach Rückgabetyp wird '.' oder ':' erwartet"],
    ["Expected '返回' after '那么'", "'那么' 之后应为 '返回'", "Nach '那么' wird '返回' erwartet"],
    ["Expected 'set to' in construction", "构造中应为 'set to'", "In Konstruktion wird 'set to' erwartet"],
    ['Expected identifier', '此处应为标识符', 'Bezeichner erwartet'],
    ['Expected identifier after dot', '点之后应为标识符', 'Nach Punkt wird Bezeichner erwartet'],
    ['Unknown statement', '无法识别的语句', 'Unbekannte Anweisung'],
    ['Unexpected token at top level', '顶层出现意外的记号', 'Unerwartetes Token auf oberster Ebene'],
    ["Unexpected ')'", "意外的 ')'", "Unerwartet: ')'"],
  ])('%s', (en, zh, de) => {
    expect(localizeParseMessage(en, 'zh-CN')).toBe(zh);
    expect(localizeParseMessage(en, 'de-DE')).toBe(de);
  });

  it('en-US 与未收录的语言原样返回', () => {
    expect(localizeParseMessage("Expected '.' at end of statement", 'en-US')).toBe("Expected '.' at end of statement");
    expect(localizeParseMessage("Expected '.' at end of statement", 'hi-IN')).toBe("Expected '.' at end of statement");
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

describe('collectCompileDiagnostics 按 locale 本地化 E000', () => {
  it('★解析错误与降级错误按 zh-CN 译出，其他诊断不动', () => {
    const out = collectCompileDiagnostics({
      parseErrors: [{ message: "Expected '.' at end of statement" }],
      loweringErrors: ['Unknown statement'],
      typeErrors: [{ severity: 'error', code: 'E003', message: 'Undefined variable: x' }],
    } as never, 'zh-CN');
    expect(out.map((d) => d.message)).toEqual(["语句末尾应为 '.'", '无法识别的语句', 'Undefined variable: x']);
  });

  it('不传 locale 时保持原文', () => {
    const out = collectCompileDiagnostics({ parseErrors: [{ message: 'Expected identifier' }] } as never);
    expect(out[0]!.message).toBe('Expected identifier');
  });
});
