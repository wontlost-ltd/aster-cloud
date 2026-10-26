import { describe, it, expect, vi } from 'vitest';
import { choosePolicyLocale } from '@/lib/policy-locale-priority';

/** #627：策略 CNL 语言的唯一判定顺序（执行端与编辑器共用）。 */

describe('choosePolicyLocale', () => {
  const detect = vi.fn(() => 'de-DE');

  it('记录的编译 locale 优先，即使源码识别结果不同也不覆盖', () => {
    expect(choosePolicyLocale({ recorded: 'en-US', snapshotLocale: 'de', source: 'Modul x.', detect })).toBe('en-US');
  });

  it('无记录值时用唯一快照 locale，再退到源码识别', () => {
    expect(choosePolicyLocale({ snapshotLocale: 'zh-CN', source: 'Modul x.', detect })).toBe('zh-CN');
    expect(choosePolicyLocale({ source: 'Modul x.', detect })).toBe('de-DE');
  });

  it('界面语言兜底只用于空源码', () => {
    expect(choosePolicyLocale({ source: '  ', detect, emptySourceFallback: 'zh-CN' })).toBe('zh-CN');
    expect(choosePolicyLocale({ source: 'Modul x.', detect, emptySourceFallback: 'zh-CN' })).toBe('de-DE');
    // 有记录值时不看兜底
    expect(choosePolicyLocale({ recorded: 'en-US', source: '', detect, emptySourceFallback: 'zh-CN' })).toBe('en-US');
  });
});
