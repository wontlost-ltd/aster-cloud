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
        <Link href={href} className={className}>
          {children}
        </Link>
      )}
    />
  );
}
