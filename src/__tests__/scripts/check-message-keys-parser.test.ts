/**
 * check-message-keys.mjs 的 demo-supplement 解析器回归测试。
 *
 * 背景：3b 在 supplement 里写了单行内联对象
 *   dashboardNav: { reports: 'Evidence', approvals: 'Approvals' },
 * 旧解析器只认「key: '值'」与行尾 `key: {`，内联对象里的键整体丢失，
 * 导致门禁把实际存在的 dashboardNav.approvals 误报为缺失。
 */
import { describe, it, expect } from 'vitest';
import { parseSupplementKeys } from '../../../scripts/check-message-keys.mjs';

const wrap = (inner: string) => `export const X = {\n  en: {\n${inner}\n  },\n  zh: {\n    other: { ignored: 'x' },\n  },\n};\n`;

const keys = (inner: string): string[] => [...(parseSupplementKeys(wrap(inner)) as Set<string>)].sort();

describe('parseSupplementKeys', () => {
  it('解析多行嵌套对象', () => {
    expect(
      keys(`    approvals: {\n      title: 'Approvals',\n      empty: "None",\n    },`),
    ).toEqual(['approvals.empty', 'approvals.title']);
  });

  it('解析单行内联对象并带完整点路径', () => {
    expect(keys(`    dashboardNav: { reports: 'Evidence', approvals: "Approvals" },`)).toEqual([
      'dashboardNav.approvals',
      'dashboardNav.reports',
    ]);
  });

  it('解析多行对象内的内联对象与嵌套内联对象', () => {
    expect(
      keys(`    outer: {\n      nav: { a: 'A', deep: { b: 'B' } },\n      leaf: 'L',\n    },`),
    ).toEqual(['outer.leaf', 'outer.nav.a', 'outer.nav.deep.b']);
  });

  it('只读取 en 子树', () => {
    expect(keys(`    only: 'x',`)).toEqual(['only']);
  });
});
