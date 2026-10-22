import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { formatDate } from '@/lib/format';

/**
 * 全站统一日期格式（F17 / F22）。
 *
 * 生产上同一个 zh 界面出现三种日期：管理员概览 "10/22/2026"、已信任设备 "24/10/2026"、
 * 其余页面 "2026/10/22"。根因是这两处调用了不带 locale 的 toLocaleDateString()，
 * 跟随的是浏览器/服务器默认区域而不是界面语言。统一走 lib/format 的 formatDate。
 */
describe('formatDate', () => {
  const d = '2026-10-22T08:00:00Z';

  it('按界面 locale 输出，而不是运行环境默认区域', () => {
    expect(formatDate(d, 'zh')).toBe('2026/10/22');
    expect(formatDate(d, 'en')).toBe('10/22/2026');
    expect(formatDate(d, 'de')).toBe('22.10.2026');
  });

  it('接受 Date 对象', () => {
    expect(formatDate(new Date(d), 'zh')).toBe('2026/10/22');
  });
});

describe('不得再出现不带 locale 的日期格式化', () => {
  const ROOT = path.resolve(__dirname, '../../..');
  const SRC = path.join(ROOT, 'src');

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        out.push(...walk(p));
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(p);
      }
    }
    return out;
  }

  it('src 下没有 toLocaleDateString() / toLocaleTimeString() 空参调用', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/\.toLocale(Date|Time)String\(\s*\)/.test(line)) {
          offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
