import type { ComponentPropsWithoutRef } from 'react';

/**
 * MDX `<table>` 覆盖：包一层可横向滚动的容器。
 *
 * 文档里的参数表 / 规则表列多、单元格含长代码，移动端（390px）会把整页撑出横向滚动（#774 审计）。
 * 容器负责滚动，表格本身保持 prose 排版；tabIndex=0 让键盘用户聚焦后可用方向键滚动
 * （axe scrollable-region-focusable）。`relative` 让表内绝对定位的元素也被容器裁剪。
 */
export function DocsTable(props: ComponentPropsWithoutRef<'table'>) {
  return (
    <div
      tabIndex={0}
      className="docs-table-wrap relative my-6 overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <table {...props} className={['!my-0', props.className].filter(Boolean).join(' ')} />
    </div>
  );
}
