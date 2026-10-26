import { describe, it, expect } from 'vitest';
import { resolvePolicyCnlLocale } from '@/components/policy/policy-form/policy-cnl-locale';

/** #627：编辑器 CNL 语言的判定顺序（源码高置信识别 → 已记录 locale → 界面语言兜底）。 */

const ENGLISH = 'Module m.\n\nRule r given x as Int, produce Int:\n  Return x.\n';
const GERMAN = 'Modul m.\n\nDefiniere Fahrer hat alter als Ganzzahl.\n';
const CHINESE = '模块 m。\n\n定义 司机 包含 年龄。\n';

describe('resolvePolicyCnlLocale', () => {
  it('源码高置信识别优先于界面语言', () => {
    expect(resolvePolicyCnlLocale({ recorded: null, content: ENGLISH, uiLocale: 'de' })).toBe('en-US');
    expect(resolvePolicyCnlLocale({ recorded: null, content: GERMAN, uiLocale: 'en' })).toBe('de-DE');
    expect(resolvePolicyCnlLocale({ recorded: null, content: CHINESE, uiLocale: 'en' })).toBe('zh-CN');
  });

  it('源码高置信识别优先于（可能被界面语言污染的）已记录 locale', () => {
    expect(resolvePolicyCnlLocale({ recorded: 'de-DE', content: ENGLISH, uiLocale: 'de' })).toBe('en-US');
    expect(resolvePolicyCnlLocale({ recorded: 'en-US', content: GERMAN, uiLocale: 'en' })).toBe('de-DE');
  });

  it('源码无法识别时用已记录 locale，并规范成完整标签', () => {
    expect(resolvePolicyCnlLocale({ recorded: 'hi-IN', content: 'x', uiLocale: 'de' })).toBe('hi-IN');
    expect(resolvePolicyCnlLocale({ recorded: 'de', content: '', uiLocale: 'en' })).toBe('de-DE');
  });

  it('不受支持的已记录 locale 忽略，退回界面语言', () => {
    expect(resolvePolicyCnlLocale({ recorded: 'fr-FR', content: '', uiLocale: 'zh' })).toBe('zh-CN');
  });

  it('新建空策略按界面语言', () => {
    expect(resolvePolicyCnlLocale({ recorded: null, content: '', uiLocale: 'de' })).toBe('de-DE');
    expect(resolvePolicyCnlLocale({ recorded: undefined, content: '   ', uiLocale: 'hi' })).toBe('en-US');
  });
});
