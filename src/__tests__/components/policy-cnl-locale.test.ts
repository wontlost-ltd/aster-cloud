import { describe, it, expect } from 'vitest';
import { detectLocaleMismatch, resolveEditorCnlLocale } from '@/components/policy/policy-form/policy-cnl-locale';

/** #627：编辑器 CNL 语言 = 用户显式选择 > 服务端解析值（与执行同一函数）> 新建时的识别/界面语言。 */

const ENGLISH = 'Module m.\n\nRule r given x as Int, produce Int:\n  Return x.\n';
const GERMAN = 'Modul m.\n\nDefiniere Fahrer hat alter als Ganzzahl.\n';

describe('resolveEditorCnlLocale', () => {
  it('编辑：使用服务端解析值，不被源码识别覆盖', () => {
    expect(resolveEditorCnlLocale({ chosen: null, resolved: 'en-US', content: GERMAN, uiLocale: 'de' })).toBe('en-US');
    expect(resolveEditorCnlLocale({ chosen: null, resolved: 'de', content: ENGLISH, uiLocale: 'en' })).toBe('de-DE');
    expect(resolveEditorCnlLocale({ chosen: null, resolved: 'hi-IN', content: 'x', uiLocale: 'de' })).toBe('hi-IN');
  });

  it('用户显式选择优先', () => {
    expect(resolveEditorCnlLocale({ chosen: 'de-DE', resolved: 'en-US', content: GERMAN, uiLocale: 'en' })).toBe('de-DE');
  });

  it('新建：有源码按识别，与界面语言无关；空源码按界面语言', () => {
    expect(resolveEditorCnlLocale({ chosen: null, resolved: null, content: ENGLISH, uiLocale: 'de' })).toBe('en-US');
    expect(resolveEditorCnlLocale({ chosen: null, resolved: null, content: GERMAN, uiLocale: 'en' })).toBe('de-DE');
    expect(resolveEditorCnlLocale({ chosen: null, resolved: null, content: '', uiLocale: 'de' })).toBe('de-DE');
  });
});

describe('detectLocaleMismatch', () => {
  it('高置信识别结果与策略语言不同才提示', () => {
    expect(detectLocaleMismatch('en-US', GERMAN)).toBe('de-DE');
    expect(detectLocaleMismatch('de-DE', GERMAN)).toBeNull();
    expect(detectLocaleMismatch('de', GERMAN)).toBeNull();
  });

  it('识别不确定（空 / 过短）时不提示', () => {
    expect(detectLocaleMismatch('hi-IN', 'x')).toBeNull();
    expect(detectLocaleMismatch('en-US', '')).toBeNull();
  });
});
