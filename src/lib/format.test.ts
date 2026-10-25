import { describe, expect, it } from 'vitest';
import { formatDate } from './format';

describe('formatDate', () => {
  // 22:04 UTC：UTC 下为 10/12，UTC+13 下为 10/13——服务端与浏览器若按各自时区格式化即不一致（#585）
  const lateUtc = '2026-10-12T22:04:28.748Z';

  it('按 UTC 日历日格式化，与运行环境时区无关', () => {
    expect(formatDate(lateUtc, 'en-US')).toBe('10/12/2026');
    expect(formatDate(new Date(lateUtc), 'en-US')).toBe('10/12/2026');
  });

  it('与显式按 UTC 格式化的结果相同（服务端口径），且不等于 UTC+13 的本地日期', () => {
    const utc = new Date(lateUtc).toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' });
    const auckland = new Date(lateUtc).toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Pacific/Auckland' });
    expect(formatDate(lateUtc, 'en-US')).toBe(utc);
    expect(auckland).not.toBe(utc);
  });

  it('保留 locale 的日期格式', () => {
    expect(formatDate(lateUtc, 'de-DE')).toBe('12.10.2026');
    expect(formatDate(lateUtc, 'zh-CN')).toBe('2026/10/12');
  });
});
