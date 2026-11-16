// @vitest-environment jsdom
/**
 * #774：设计系统面包屑的 <ol> 不折行，「仪表盘 › 领域词汇 › 词汇快照」在 390px 宽度下把整页撑出横向滚动。
 * 包装层允许折行并让 flex 子项可收缩（min-w-0，truncate 才会生效）。
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Breadcrumbs } from '@/components/ui/breadcrumbs';

describe('Breadcrumbs wrapper (#774)', () => {
  it('lets the trail wrap instead of overflowing narrow viewports', () => {
    const { container } = render(
      <Breadcrumbs className="mb-2" items={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Domain vocabularies', href: '/domain-vocabularies' }, { label: 'Vocabulary snapshots' }]} />,
    );
    const nav = container.querySelector('nav[aria-label="Breadcrumb"]') as HTMLElement;
    expect(nav.className).toContain('min-w-0');
    expect(nav.className).toContain('[&>ol]:flex-wrap');
    expect(nav.className).toContain('mb-2');
  });
});
