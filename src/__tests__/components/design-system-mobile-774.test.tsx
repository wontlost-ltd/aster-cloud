// @vitest-environment jsdom
/**
 * #774：DataTable 与 Breadcrumbs 的移动端缺陷已在设计系统修复（@aster-cloud/ui 0.3.2），cloud 不再在调用处打补丁。
 * 这里守住升级后的行为，防止依赖回退时整页横向溢出再次出现：
 * - DataTable 滚动容器是定位祖先（relative），sr-only 表头不会逃出 overflow-x-auto；
 * - 面包屑 <ol> 可折行、子项可收缩，窄屏下不撑宽整页。
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { DataTable } from '@/components/ui';
import { Breadcrumbs } from '@/components/ui/breadcrumbs';

describe('design-system mobile fixes (#774)', () => {
  it('DataTable scroll container is the containing block of sr-only headers', () => {
    const { container } = render(
      <DataTable
        columns={[{ key: 'a', header: 'Actions', srHeader: true, cell: () => 'x' }]}
        rows={[{ id: '1' }]}
        getRowKey={(r) => r.id}
      />,
    );
    const table = container.querySelector('table') as HTMLElement;
    const scroller = table.parentElement as HTMLElement;
    expect(scroller.className).toMatch(/(^|\s)overflow-x-auto(\s|$)/);
    expect(scroller.className).toMatch(/(^|\s)relative(\s|$)/);
  });

  it('Breadcrumbs trail wraps instead of overflowing narrow viewports', () => {
    const { container } = render(
      <Breadcrumbs items={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Domain vocabularies', href: '/domain-vocabularies' }, { label: 'Vocabulary snapshots' }]} />,
    );
    const nav = container.querySelector('nav[aria-label="Breadcrumb"]') as HTMLElement;
    const ol = nav.querySelector('ol') as HTMLElement;
    expect(nav.className).toContain('min-w-0');
    expect(ol.className).toContain('flex-wrap');
    expect(ol.className).toContain('min-w-0');
  });
});
