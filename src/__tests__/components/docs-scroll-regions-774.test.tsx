// @vitest-environment jsdom
/**
 * #774：文档里横向滚动的代码块与宽表格必须可键盘聚焦（axe scrollable-region-focusable），
 * 宽表格须包在自身的滚动容器里，不能把移动端整页撑出横向滚动。
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));
vi.mock('next/navigation', () => ({ usePathname: () => '/en/docs/api' }));

import { DocsCodeBlock } from '@/components/docs/DocsCodeBlock';
import { DocsTable } from '@/components/docs/DocsTable';
import { useMDXComponents } from '../../../mdx-components';

describe('docs scroll regions (#774)', () => {
  it('code blocks are focusable scroll regions', () => {
    const { container } = render(<DocsCodeBlock><code>{'const x = 1;'}</code></DocsCodeBlock>);
    const pre = container.querySelector('pre') as HTMLElement;
    expect(pre.tabIndex).toBe(0);
    expect(pre.className).toContain('overflow-x-auto');
  });

  it('keeps code blocks focusable even if the MDX passes tabIndex', () => {
    const { container } = render(<DocsCodeBlock tabIndex={-1}><code>x</code></DocsCodeBlock>);
    expect((container.querySelector('pre') as HTMLElement).tabIndex).toBe(0);
  });

  it('tables scroll inside their own focusable, positioned container', () => {
    const { container } = render(<DocsTable><tbody><tr><td>x</td></tr></tbody></DocsTable>);
    const wrap = container.firstElementChild as HTMLElement;
    expect(wrap.tagName).toBe('DIV');
    expect(wrap.tabIndex).toBe(0);
    expect(wrap.className).toMatch(/\boverflow-x-auto\b/);
    expect(wrap.className).toMatch(/\brelative\b/);
    expect(wrap.querySelector('table')).not.toBeNull();
  });

  it('MDX routes <table> through DocsTable', () => {
    expect(useMDXComponents({}).table).toBe(DocsTable);
  });
});
