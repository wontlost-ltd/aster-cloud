/**
 * #774 设计决策：移动端点击目标 ≥ 44×44 CSS px，桌面不变。
 * 实际效果由 UI 审计在真实浏览器里逐页量（tap-target-lt-44，含伪元素点击区与重叠判定）；
 * 这里守住 globals.css 里那段规则的关键约束，防止被误删或改成全视口生效。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

function mobileBlock(): string {
  const start = css.indexOf('@layer base {\n  @media (max-width: 639.98px) {');
  expect(start, 'mobile tap-target block must exist').toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') depth -= 1;
    if (depth === 0) return css.slice(start, i + 1);
  }
  throw new Error('unterminated block');
}

describe('mobile tap targets (globals.css)', () => {
  it('only applies below the sm breakpoint and inside @layer base (utilities such as absolute/fixed still win)', () => {
    const block = mobileBlock();
    expect(block).toMatch(/^@layer base \{\n {2}@media \(max-width: 639\.98px\)/);
  });

  it('gives form controls a real 44px height', () => {
    expect(mobileBlock()).toMatch(/select, textarea\) \{\s*min-height: 2\.75rem;/);
  });

  it('enlarges buttons and links with a centred 44×44 hit area, but not links in running text', () => {
    const block = mobileBlock();
    expect(block).toMatch(/::after \{[^}]*width: max\(100%, 2\.75rem\);[^}]*height: max\(100%, 2\.75rem\);[^}]*transform: translate\(-50%, -50%\);/);
    expect(block).toContain(':not(:where(.prose, .docs-article, article) :where(p, li, td) a)');
  });
});
