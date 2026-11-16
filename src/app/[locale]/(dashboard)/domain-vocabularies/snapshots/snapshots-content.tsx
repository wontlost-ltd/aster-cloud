'use client';

import { useCallback, useMemo, useState, useTransition } from 'react';
import { Archive } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/navigation';
import {
  Badge,
  Breadcrumbs,
  Button,
  ConfirmDialog,
  Container,
  DataTable,
  EmptyState,
  ListSearchInput,
  PageHeader,
  Pagination,
  toast,
  type DataTableColumn,
} from '@/components/ui';
import { buildListUrl, type ListUrlOptions } from '@/lib/list-search-params';
import { useVocabularyErrors } from '../use-vocabulary-errors';
import { SnapshotDiffPanel } from './snapshot-diff-panel';

export interface SerializableSnapshot {
  id: string;
  domain: string;
  locale: string;
  version: number;
  contentHash: string;
  refCount: number;
  termCount: number;
  archived: boolean;
  createdAt: string;
}

interface SnapshotsContentProps {
  initialSnapshots: SerializableSnapshot[];
  initialTotal: number;
  initialPage: number;
  initialPageSize: number;
  initialQuery: string;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

const SNAPSHOTS_URL_OPTS: ListUrlOptions = {
  defaultPageSize: 25,
  allowedPageSizes: [25, 50, 100],
  filterKeys: [],
};

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Snapshots browser: list (F7) + rollback confirm (F8).
 *
 * Selecting a row opens the diff panel which lazily fetches
 * /api/v1/domain-vocabularies/snapshots/[id] for the resolved terms +
 * set-comparison. The rollback button moves through a single
 * confirmation step before calling POST /rollback.
 *
 * URL state (page, pageSize, q) is owned by the server component;
 * any mutation here routes through router.refresh() so the page-side
 * service queries re-run and the new state appears in the SSR payload
 * before React commits.
 */
export function SnapshotsContent({
  initialSnapshots,
  initialTotal,
  initialPage,
  initialPageSize,
  initialQuery,
}: SnapshotsContentProps) {
  const t = useTranslations('domainVocabularies.snapshotsView');
  const vocabularyErrors = useVocabularyErrors();
  const tNav = useTranslations('dashboardNav');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [, startTransition] = useTransition();

  const [searchInput, setSearchInput] = useState<string>(initialQuery);
  const [selected, setSelected] = useState<SerializableSnapshot | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<SerializableSnapshot | null>(null);
  const [rollingBack, setRollingBack] = useState(false);

  const currentUrlState = useMemo(
    () => ({
      page: initialPage,
      pageSize: initialPageSize,
      q: initialQuery || undefined,
      filters: {},
    }),
    [initialPage, initialPageSize, initialQuery],
  );

  const navigate = useCallback(
    (patch: Parameters<typeof buildListUrl>[2]) => {
      const next = buildListUrl(pathname, currentUrlState, patch, SNAPSHOTS_URL_OPTS);
      startTransition(() => {
        router.replace(next);
      });
    },
    [pathname, currentUrlState, router],
  );

  const debouncedSearchTimer = useMemo(
    () => ({ current: null as ReturnType<typeof setTimeout> | null }),
    [],
  );
  const handleSearchChange = useCallback(
    (next: string) => {
      setSearchInput(next);
      if (debouncedSearchTimer.current) clearTimeout(debouncedSearchTimer.current);
      // debouncedSearchTimer 是 useMemo 造的可变 ref 容器，此处在事件回调内写 .current，非渲染期突变，误报
      // eslint-disable-next-line react-hooks/immutability
      debouncedSearchTimer.current = setTimeout(() => {
        navigate({ q: next });
      }, SEARCH_DEBOUNCE_MS);
    },
    [debouncedSearchTimer, navigate],
  );

  const refreshRsc = useCallback(() => {
    startTransition(() => {
      router.refresh();
    });
  }, [router]);

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  );

  // The server returns the page's slice; we still let the user filter
  // locally on the current page by content-hash / domain / locale —
  // useful when they're scanning the page they're on. Cross-page hash
  // search would need to move into the server query; not in scope for
  // v1 since snapshots are typically few.
  const visible = useMemo(() => {
    const q = searchInput.trim().toLowerCase();
    if (!q) return initialSnapshots;
    return initialSnapshots.filter(
      (s) =>
        s.domain.toLowerCase().includes(q) ||
        s.locale.toLowerCase().includes(q) ||
        s.contentHash.toLowerCase().includes(q),
    );
  }, [initialSnapshots, searchInput]);

  const handleRollback = useCallback(async () => {
    if (!rollbackTarget) return;
    setRollingBack(true);
    try {
      const res = await fetch(
        `/api/v1/domain-vocabularies/snapshots/${rollbackTarget.id}/rollback`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          credentials: 'same-origin',
        },
      );
      if (!res.ok) {
        const env = (await res.json().catch(() => ({}))) as ErrorEnvelope;
        // 按错误码本地化，不显示服务端原文（#634）
        throw new Error(vocabularyErrors.envelope(env.error?.code, env.error?.message, t('rollbackFailed')));
      }
      const data = (await res.json()) as {
        added: number;
        removed: number;
        unchanged: number;
      };
      toast.success(
        t('rollbackSuccess', {
          added: data.added,
          removed: data.removed,
          unchanged: data.unchanged,
        }),
      );
      setRollbackTarget(null);
      setSelected(null);
      refreshRsc();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('rollbackFailed'));
    } finally {
      setRollingBack(false);
    }
  }, [rollbackTarget, refreshRsc, t, vocabularyErrors]);

  const columns: DataTableColumn<SerializableSnapshot>[] = [
    {
      key: 'scope',
      header: t('table.scope'),
      cell: (row) => (
        <div className="flex flex-col">
          <span className="text-sm font-medium text-fg">
            {row.domain} · {row.locale}
          </span>
          <span className="font-mono text-xs text-fg-subtle">
            {t('table.version', { n: row.version })}
          </span>
        </div>
      ),
    },
    {
      key: 'termCount',
      header: t('table.termCount'),
      className: 'text-right',
      cell: (row) => (
        <span className="font-mono text-sm text-fg">{row.termCount}</span>
      ),
    },
    {
      key: 'refCount',
      header: t('table.refCount'),
      className: 'text-right',
      cell: (row) => (
        <span className="font-mono text-sm text-fg-muted">{row.refCount}</span>
      ),
    },
    {
      key: 'contentHash',
      header: t('table.hash'),
      cell: (row) => (
        <code className="text-xs text-fg-subtle">
          {row.contentHash.slice(0, 12)}…
        </code>
      ),
    },
    {
      key: 'createdAt',
      header: t('table.createdAt'),
      cell: (row) => (
        <span className="text-sm text-fg-muted">
          {dateFormatter.format(new Date(row.createdAt))}
        </span>
      ),
    },
    {
      key: 'archived',
      header: t('table.status'),
      cell: (row) =>
        row.archived ? (
          <Badge variant="warning">
            <Archive className="mr-1 inline h-3 w-3" aria-hidden="true" />
            {t('table.archivedBadge')}
          </Badge>
        ) : (
          <Badge variant="success">{t('table.activeBadge')}</Badge>
        ),
    },
    {
      key: 'actions',
      header: t('table.actions'),
      srHeader: true,
      className: 'text-right',
      cell: (row) => (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelected(row)}
          >
            {t('actions.view')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={row.archived}
            title={row.archived ? t('archivedTooltip') : undefined}
            onClick={() => setRollbackTarget(row)}
          >
            {t('actions.rollback')}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <Container size="xl" className="py-6 sm:py-10">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        breadcrumbs={
          <Breadcrumbs
            items={[
              { label: tNav('dashboard'), href: '/dashboard' },
              { label: tNav('domainVocabularies'), href: '/domain-vocabularies' },
              { label: t('title') },
            ]}
          />
        }
      />

      {initialTotal > 0 ? (
        <div className="mt-6">
          <ListSearchInput
            value={searchInput}
            onChange={handleSearchChange}
            placeholder={t('searchPlaceholder')}
          />
        </div>
      ) : null}

      <div className="mt-4">
        <DataTable
          columns={columns}
          rows={visible}
          getRowKey={(row) => row.id}
          aria-label={t('title')}
          emptyState={
            <EmptyState
              title={t('empty.title')}
              description={t('empty.description')}
            />
          }
        />
      </div>

      <Pagination
        page={initialPage}
        pageSize={initialPageSize}
        total={initialTotal}
        pageSizeOptions={[...SNAPSHOTS_URL_OPTS.allowedPageSizes]}
        buildHref={({ page, pageSize }) =>
          buildListUrl(
            pathname,
            currentUrlState,
            { page, pageSize, resetPage: false },
            SNAPSHOTS_URL_OPTS,
          )
        }
        onPageSizeChange={(next) => navigate({ pageSize: next })}
      />

      {selected ? (
        <SnapshotDiffPanel
          snapshot={selected}
          onClose={() => setSelected(null)}
          onRollback={() => setRollbackTarget(selected)}
        />
      ) : null}

      <ConfirmDialog
        isOpen={rollbackTarget !== null}
        title={t('rollback.title')}
        description={
          rollbackTarget
            ? t('rollback.description', {
                domain: rollbackTarget.domain,
                locale: rollbackTarget.locale,
                version: rollbackTarget.version,
              })
            : ''
        }
        variant="warning"
        confirmLabel={t('rollback.confirm')}
        cancelLabel={t('rollback.cancel')}
        isLoading={rollingBack}
        onConfirm={handleRollback}
        onCancel={() => {
          if (!rollingBack) setRollbackTarget(null);
        }}
      />
    </Container>
  );
}
