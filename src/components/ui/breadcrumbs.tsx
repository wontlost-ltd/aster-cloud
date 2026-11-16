/**
 * Aster-cloud Breadcrumbs wrapper.
 *
 * The design-system Breadcrumbs is routing-agnostic; this wrapper
 * injects the next-intl-aware Link so consumer page code stays a
 * one-liner.
 */
import {
  Breadcrumbs as DesignSystemBreadcrumbs,
  type BreadcrumbItem,
  type BreadcrumbsProps as DesignSystemBreadcrumbsProps,
} from '@aster-cloud/ui';
import { Link } from '@/i18n/navigation';

export type BreadcrumbsProps = Omit<DesignSystemBreadcrumbsProps, 'linkComponent'>;
export type { BreadcrumbItem };

export function Breadcrumbs(props: BreadcrumbsProps) {
  return (
    <DesignSystemBreadcrumbs
      {...props}
      linkComponent={({ href, className, children }) => (
        // 移动端链接至少 44px 宽：设计系统已把高度撑到 44px，短的中文面包屑（如「设置」）宽度只有 28px（#774）
        <Link href={href} className={`${className ?? ''} max-sm:min-w-11 max-sm:text-center`}>
          {children}
        </Link>
      )}
    />
  );
}
