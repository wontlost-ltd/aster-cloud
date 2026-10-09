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

  it('字符串值内的 { : , 不影响结构，也不产生多余键', () => {
    expect(keys(`    a: { x: 'has { and : and , inside', y: "{count} items" },`)).toEqual(['a.x', 'a.y']);
  });

  it('值里的转义引号不会提前结束字符串，其后的 `z: 1` 不成为键', () => {
    expect(keys(`    a: { x: 'it\\'s: {z: 1}', y: 'ok' },`)).toEqual(['a.x', 'a.y']);
  });

  it('行尾 // 注释先被剥离，内联对象照常解析', () => {
    expect(keys(`    a: { x: 'X', y: 'Y' }, // c`)).toEqual(['a.x', 'a.y']);
  });

  it('字符串里含 // 时行被截断、对象无法闭合：整行丢弃（失败安全：宁缺不造键）', () => {
    // 丢键只会让门禁多报缺失、促使人工核对；造出幻影键则会漏报，故这是可接受方向。
    expect(keys(`    a: { x: 'https://e.com', y: 'Y' },`)).toEqual([]);
  });

  it('非字面量值（三元）只登记其键，值内字符串里的 `foo: "bar"` 不成为键', () => {
    expect(keys(`    a: { x: cond ? 'foo: "bar"' : 'z', y: 'Y' },`)).toEqual(['a.y']);
  });
});
