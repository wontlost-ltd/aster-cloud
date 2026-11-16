'use client';

/**
 * 从控制台页面指向站内文档的链接（#796）：空状态的「了解更多」、上手清单的文档入口、概念旁的帮助提示共用。
 *
 * <p>在 dashboard 内（有 DocsOverlayProvider）点击时在文档浮层里打开，不离开当前页；
 * 没有浮层时（dashboard 外或单测）退回指向 /docs/<slug> 的普通链接。
 * 两种形态都保留 href 语义：浮层模式是带 href 的 <a>，左键拦截改开浮层，新标签页 / 复制链接仍可用。
 */
import { HelpCircle } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import { useOptionalDocsOverlay } from '@/components/docs/docs-overlay-context';
import { cn } from '@/components/ui';

/** 文本链接的统一样式：主色、下划线悬停、可见的焦点环。 */
export const DOCS_LINK_CLASS =
  'inline-flex items-center gap-1 rounded-sm text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:shadow-ring';

/**
 * 空状态里「操作 + 了解更多」一行的布局：桌面横排；移动端竖排且每项真实高 44px，
 * 避免撑大的点击区与相邻项重叠（#774 的 44px 规范）。
 */
export const EMPTY_STATE_ACTIONS_CLASS =
  'flex flex-wrap items-center justify-center gap-x-6 gap-y-4 max-sm:flex-col max-sm:gap-y-2 max-sm:*:min-h-11';

export interface DocsLinkProps {
  /** /docs 下的页面 slug，如 'how-to/approvals'。 */
  slug: string;
  children: ReactNode;
  className?: string;
  'aria-label'?: string;
  title?: string;
}

export function DocsLink({ slug, children, className, ...rest }: DocsLinkProps) {
  const overlay = useOptionalDocsOverlay();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // 只接管普通左键：修饰键 / 中键保留浏览器默认（新标签页打开完整文档）
    if (!overlay || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    overlay.openDocs(slug);
  };
  return (
    <Link href={`/docs/${slug}`} onClick={onClick} className={className ?? DOCS_LINK_CLASS} {...rest}>
      {children}
    </Link>
  );
}

/**
 * 概念旁的小帮助提示：问号图标，点开对应文档段落。
 * label 是完整的可读名称（如「了解业务角色」），作为无障碍名称与悬停提示。
 * 移动端图标外框真实 44px，不靠伪元素撑大，免得压到相邻的标签按钮。
 */
export function HelpHint({ slug, label, className }: { slug: string; label: string; className?: string }) {
  return (
    <DocsLink
      slug={slug}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded-full align-middle max-sm:size-11 text-fg-muted hover:text-primary focus-visible:outline-none focus-visible:shadow-ring',
        className,
      )}
    >
      <HelpCircle className="size-4" aria-hidden />
    </DocsLink>
  );
}
