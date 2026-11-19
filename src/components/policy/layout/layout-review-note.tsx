'use client';

/**
 * 复核面板顶部的显示排版说明（ADR 0058 §7.7 第 7 条，裁决 R15）。
 * 复核面板只渲染 canonical 片段、不渲染全文，所以不加 display 标签，只说明并链接到该策略的版本页。
 * 独立成组件：复核面板自身只用 `policyReview` 一个命名空间（见 policy-review-namespace.test.tsx）。
 */
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';

export function LayoutReviewNote({ policyId }: { policyId: string }) {
  const t = useTranslations('policyLayout');
  return (
    <p
      data-testid="review-layout-note"
      className="rounded-md border border-sky-300/60 bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:border-sky-400/30 dark:bg-sky-950/30 dark:text-sky-100"
    >
      {t('reviewNote')}{' '}
      <Link href={`/policies/${policyId}/versions`} className="font-medium underline hover:no-underline">
        {t('reviewLink')}
      </Link>
    </p>
  );
}
