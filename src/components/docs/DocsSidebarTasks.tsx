'use client';

/**
 * "By task" rendering of the docs sidebar.
 *
 * Each task expands inline to show its step list. Active matching is
 * two-axis: the current path determines which step is selected, and
 * the `?task=<id>` search param (if present) determines which task
 * is forced open. Without that param every task collapses to a
 * header — readers can scan task names without scrolling through
 * step lists they may not want.
 *
 * Step links append `?task=<id>` so navigating between steps in a
 * task preserves the task context. The breadcrumb component reads
 * the same param to display "Tasks › <task name> › <step>" instead
 * of the reference breadcrumb.
 */

import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname } from '@/i18n/navigation';
import { Link } from '@/i18n/navigation';
import { TASK_VIEWS, sidebarLabelKeyFor } from '@/lib/docs/task-views';

export function DocsSidebarTasks() {
  const t = useTranslations();
  const locale = useLocale();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeTaskId = searchParams.get('task');
  const currentSlug = pathname.replace(/^\/docs\/?/, '');

  return (
    <nav aria-label={t('docs.sidebar.tasksLabel')}>
      <ul className="space-y-3" role="list">
        {TASK_VIEWS.map((task) => {
          const expanded = task.id === activeTaskId;
          return (
            <li key={task.id}>
              <details
                open={expanded}
                className="rounded-md border border-border bg-bg"
              >
                <summary
                  className={
                    'cursor-pointer rounded-md px-3 py-2 text-sm font-medium text-fg ' +
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
                  }
                >
                  {t(task.titleKey)}
                </summary>
                <p className="px-3 pb-2 text-xs text-fg-muted">
                  {t(task.descriptionKey)}
                </p>
                <ol className="mb-2 space-y-1 px-2 pb-2" role="list">
                  {task.steps.map((step, i) => {
                    const isActive = currentSlug === step.slug;
                    const labelKey = sidebarLabelKeyFor(step.slug);
                    return (
                      <li key={step.slug}>
                        <Link
                          href={`/docs/${step.slug}?task=${encodeURIComponent(task.id)}`}
                          locale={locale}
                          className={
                            (isActive
                              ? 'flex items-center gap-2 rounded-md bg-bg-soft px-2 py-1.5 text-sm font-medium text-fg max-sm:py-3'
                              : 'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg-muted transition-colors hover:bg-bg-soft hover:text-fg max-sm:py-3') +
                            ' focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
                          }
                          aria-current={isActive ? 'page' : undefined}
                        >
                          <span
                            aria-hidden="true"
                            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bg-subtle text-[10px] font-semibold text-fg-muted"
                          >
                            {i + 1}
                          </span>
                          <span>
                            {labelKey ? t(labelKey) : step.slug}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ol>
              </details>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
