/**
 * 新建策略的入门模板（starter）选择契约。
 *
 * - 按界面语言选模板：en / zh / de 各取本语种模板，hi 与其它语言回落 en-US
 *   （hi-IN 暂无内置模板，编辑器对 hi 界面的空策略也按 en-US 处理，二者一致）。
 * - 模板语言 = 编辑器判定的策略 CNL 语言，不触发「语言不一致」提示。
 * - 入门模板就是模板目录里的「基础入门」条目（单一真相源），模块名与其它内置样例不重复。
 */
import { describe, it, expect } from 'vitest';
import {
  ASTER_POLICY_TEMPLATES,
  STARTER_TEMPLATE_ID,
  getStarterTemplate,
  getTemplateForLocale,
  withoutPristineStarter,
} from '@/config/aster-policy-templates';
import { POLICY_EXAMPLES, type SupportedLocale } from '@/data/policy-examples';
import { detectLocaleMismatch, resolveEditorCnlLocale } from '@/components/policy/policy-form/policy-cnl-locale';

const UI_LOCALES: [string, SupportedLocale][] = [
  ['en', 'en-US'],
  ['zh', 'zh-CN'],
  ['de', 'de-DE'],
  ['hi', 'en-US'],
  ['fr', 'en-US'],
  ['', 'en-US'],
];

/** 源码的模块名（首个 Module/模块/Modul 声明）。 */
function moduleNameOf(source: string): string {
  const m = /^\s*(?:Module|模块|Modul)\s+(\S+?)[.。]\s*$/m.exec(source);
  return m ? m[1] : '';
}

describe('getStarterTemplate：按界面语言选入门模板', () => {
  it.each(UI_LOCALES)('界面 %s → %s 模板', (ui, expected) => {
    const starter = getStarterTemplate(ui);
    expect(starter.locale).toBe(expected);
    expect(starter.source).toBe(ASTER_POLICY_TEMPLATES[expected]);
    expect(getTemplateForLocale(ui)).toBe(starter.source);
  });

  it.each(UI_LOCALES)('界面 %s：编辑器判定的 CNL 语言与模板语言一致、无不一致提示', (ui, expected) => {
    const { source } = getStarterTemplate(ui);
    const cnl = resolveEditorCnlLocale({ chosen: null, resolved: null, content: source, uiLocale: ui });
    expect(cnl).toBe(expected);
    expect(detectLocaleMismatch(cnl, source)).toBeNull();
  });
});

describe('入门模板与模板目录是同一份数据', () => {
  const entry = POLICY_EXAMPLES.find((e) => e.id === STARTER_TEMPLATE_ID);

  it('模板目录含「基础入门」条目且排在首位', () => {
    expect(entry).toBeTruthy();
    expect(POLICY_EXAMPLES[0]?.id).toBe(STARTER_TEMPLATE_ID);
  });

  it('目录条目的各语种源码就是 ASTER_POLICY_TEMPLATES（不复制第二份）', () => {
    for (const locale of Object.keys(ASTER_POLICY_TEMPLATES) as SupportedLocale[]) {
      expect(entry!.sources[locale]).toBe(ASTER_POLICY_TEMPLATES[locale]);
    }
  });

  it('入门模板的模块名与其它内置样例不重复（同语种内）', () => {
    for (const locale of Object.keys(ASTER_POLICY_TEMPLATES) as SupportedLocale[]) {
      const starterModule = moduleNameOf(ASTER_POLICY_TEMPLATES[locale]);
      expect(starterModule, `${locale} 模块名`).toBeTruthy();
      const others = POLICY_EXAMPLES.filter((e) => e.id !== STARTER_TEMPLATE_ID).map((e) => moduleNameOf(e.sources[locale]));
      expect(others, `${locale} 模块名 ${starterModule} 与其它样例冲突`).not.toContain(starterModule);
    }
  });
});

describe('withoutPristineStarter：未改动的入门模板不算用户内容', () => {
  const starter = ASTER_POLICY_TEMPLATES['en-US'];

  it('与入门模板一致 → 空串', () => {
    expect(withoutPristineStarter(starter, starter)).toBe('');
  });

  it('改动过 / 没有入门模板 → 原样返回', () => {
    expect(withoutPristineStarter(`${starter}\n-- edited`, starter)).toBe(`${starter}\n-- edited`);
    expect(withoutPristineStarter('Module a.', null)).toBe('Module a.');
    expect(withoutPristineStarter('', starter)).toBe('');
  });
});
