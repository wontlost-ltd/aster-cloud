'use client';

import { useCallback, useMemo, useState, useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
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
  Select,
  StatCard,
  toast,
  type DataTableColumn,
} from '@/components/ui';
import { parseVocabularyValidationMessage } from '@/lib/vocabulary-validation-message';
import { buildListUrl, type ListUrlOptions } from '@/lib/list-search-params';
import { BulkJobProgress } from './bulk-job-progress';
import { BulkUploadDialog } from './bulk-upload-dialog';
import { KIND_OPTIONS, KNOWN_ERROR_CODES, type Kind } from './constants';
import { DowngradeBanner, ProGate } from './pro-gate';
import { VocabularyDialog, type VocabularyDialogValues } from './vocabulary-dialog';

const VOCAB_URL_OPTS: ListUrlOptions = {
  defaultPageSize: 50,
  allowedPageSizes: [25, 50, 100],
  filterKeys: ['domain', 'locale', 'kind'],
};

type KindKey = `kinds.${Kind}`;
type ErrorKey = `errors.${
  | 'quota_exceeded'
  | 'duplicate_link'
  | 'validation_failed'
  | 'not_found'
  | 'plan_gate_required'
  | 'internal_error'}`;

/**
 * Serializable wire-format of a TermLink: timestamps as ISO strings so the
 * server component can pass the row through React's serialization boundary.
 */
export interface SerializableTermLink {
  id: string;
  termId: string;
  userId: string;
  domain: string;
  locale: string;
  kind: string;
  canonical: string;
  localized: string;
  parentCanonical: string | null;
  aliases: string[];
  description: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  archivedAt?: string | null;
}

export interface VocabularyQuota {
  maxTerms: number;
  bulkAsync: boolean;
  allowed: boolean;
  /** Current plan after trial-expiry resolution. */
  plan: string;
  /** True when this request crossed the trial→free boundary. */
  downgraded: boolean;
  /** ISO timestamp when the trial ends/ended; null when never on trial. */
  trialEndsAt: string | null;
}

export interface VocabFilters {
  domain: string;
  locale: string;
  kind: string;
}

interface VocabulariesContentProps {
  initialTerms: SerializableTermLink[];
  initialTotal: number;
  initialDeletedTerms: SerializableTermLink[];
  initialDeletedCount: number;
  initialPage: number;
  initialPageSize: number;
  initialFilters: VocabFilters;
  initialQuery: string;
  quota: VocabularyQuota;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

const QUOTA_WARNING_THRESHOLD = 0.9;
const SEARCH_DEBOUNCE_MS = 300;

function pickQuotaTone(
  isUnlimited: boolean,
  used: number,
  max: number,
  atLimit: boolean,
): 'neutral' | 'warning' | 'danger' {
  if (atLimit) return 'danger';
  if (!isUnlimited && used >= max * QUOTA_WARNING_THRESHOLD) return 'warning';
  return 'neutral';
}

function isKnownKind(value: string): value is Kind {
  return (KIND_OPTIONS as readonly string[]).includes(value);
}

export function VocabulariesContent({
  initialTerms,
  initialTotal,
  initialDeletedTerms,
  initialDeletedCount,
  initialPage,
  initialPageSize,
  initialFilters,
  initialQuery,
  quota,
}: VocabulariesContentProps) {
  const t = useTranslations('domainVocabularies');
  const tNav = useTranslations('dashboardNav');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [, startTransition] = useTransition();

  // The list, total, and archivedCount are all server-owned now: every
  // mutation routes through router.refresh() and the page.tsx re-runs.
  // Local state is only kept for the search input so the user sees the
  // typed characters immediately while the debounced URL update fires
  // in the background.
  const [searchInput, setSearchInput] = useState<string>(initialQuery);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SerializableTermLink | null>(null);
  const [deleting, setDeleting] = useState<SerializableTermLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [loadingDeletedPage, setLoadingDeletedPage] = useState(false);
  const [deletedTerms, setDeletedTerms] = useState(initialDeletedTerms);

  const [bulkOpen, setBulkOpen] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const currentUrlState = useMemo(
    () => ({
      page: initialPage,
      pageSize: initialPageSize,
      q: initialQuery || undefined,
      filters: stripEmpty(initialFilters),
    }),
    [initialPage, initialPageSize, initialQuery, initialFilters],
  );

  // Build a URL relative to the current pathname using the shared URL
  // helper. All filter/search/page mutations go through this single
  // entry point so the canonical-form + auto-reset rules in
  // list-search-params.ts can't be bypassed.
  const navigate = useCallback(
    (patch: Parameters<typeof buildListUrl>[2]) => {
      const next = buildListUrl(pathname, currentUrlState, patch, VOCAB_URL_OPTS);
      startTransition(() => {
        router.replace(next);
      });
    },
    [pathname, currentUrlState, router],
  );

  // Debounced URL writeback for the search field. The keystroke lands
  // in local state immediately (no perceived lag), and the URL catches
  // up at most every SEARCH_DEBOUNCE_MS so we don't issue a server
  // re-render per character.
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

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }),
    [locale],
  );

  const translateKind = useCallback(
    (kind: string) => {
      if (isKnownKind(kind)) return t(`kinds.${kind}` as KindKey);
      return kind;
    },
    [t],
  );

  const validationMessage = useCallback(
    (serverMessage: string | undefined) => {
      // 服务端 validation_failed 原文可能是引擎中文诊断，不直接展示：识别为原因码后按当前语言渲染，
      // 识别不了时用通用提示。
      const detail = parseVocabularyValidationMessage(serverMessage);
      switch (detail?.reason) {
        case 'invalidCanonical': return t('errors.validation.invalidCanonical', detail.values);
        case 'duplicateCanonical': return t('errors.validation.duplicateCanonical', detail.values);
        case 'triggerConflict': return t('errors.validation.triggerConflict', detail.values);
        case 'invalidLiteral': return t('errors.validation.invalidLiteral');
        case 'parentRequired': return t('errors.validation.parentRequired');
        case 'fieldRequired': return t('errors.validation.fieldRequired', detail.values);
        default: return t('errors.validation.generic');
      }
    },
    [t],
  );

  const errorMessage = useCallback(
    (code: string | undefined, fallback: string | undefined) => {
      if (code === 'validation_failed') {
        return validationMessage(fallback);
      }
      if (code && KNOWN_ERROR_CODES.has(code)) {
        return t(`errors.${code}` as ErrorKey);
      }
      return fallback ?? t('dialog.errorGeneric');
    },
    [t, validationMessage],
  );

  const refreshRsc = useCallback(() => {
    startTransition(() => {
      router.refresh();
    });
  }, [router]);

  const handleSave = useCallback(
    async (values: VocabularyDialogValues) => {
      setBusy(true);
      try {
        const url = editing
          ? `/api/v1/domain-vocabularies/terms/${editing.id}`
          : '/api/v1/domain-vocabularies/terms';
        const method = editing ? 'PATCH' : 'POST';
        const res = await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
          },
          credentials: 'same-origin',
          body: JSON.stringify(values),
        });
        if (!res.ok) {
          const env = (await res.json().catch(() => ({}))) as ErrorEnvelope;
          const code = env.error?.code ?? 'internal_error';
          const message = errorMessage(code, env.error?.message);
          throw new Error(message);
        }
        setDialogOpen(false);
        setEditing(null);
        refreshRsc();
        toast.success(editing ? t('actions.termUpdated') : t('actions.termAdded'));
      } catch (err) {
        const message = err instanceof Error ? err.message : t('dialog.errorGeneric');
        toast.error(message);
        // Re-throw so the dialog keeps the form open with the error visible.
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [editing, errorMessage, refreshRsc, t],
  );

  const handleDelete = useCallback(async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/v1/domain-vocabularies/terms/${deleting.id}`,
        {
          method: 'DELETE',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          credentials: 'same-origin',
        },
      );
      if (!res.ok) {
        const env = (await res.json().catch(() => ({}))) as ErrorEnvelope;
        throw new Error(errorMessage(env.error?.code, env.error?.message));
      }
      setDeleting(null);
      refreshRsc();
      toast.success(t('actions.termDeleted'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('dialog.errorGeneric'));
    } finally {
      setBusy(false);
    }
  }, [deleting, errorMessage, refreshRsc, t]);

  const handleRestore = useCallback(async (term: SerializableTermLink) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/domain-vocabularies/terms/${term.id}/restore`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      });
      if (!res.ok) {
        const env = (await res.json().catch(() => ({}))) as ErrorEnvelope;
        throw new Error(errorMessage(env.error?.code, env.error?.message));
      }
      refreshRsc();
      setDeletedTerms((current) => current.filter((item) => item.id !== term.id));
      toast.success(t('actions.termRestored'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('dialog.errorGeneric'));
    } finally {
      setBusy(false);
    }
  }, [errorMessage, refreshRsc, t]);

  // Pro-gate. Full lock-screen carries the upgrade CTA + a downgrade
  // narrative when applicable so the user can tell why the page is
  // suddenly gated. Trial→free is the common case worth narrating.
  if (!quota.allowed) {
    return (
      <Container size="xl" className="py-6 sm:py-10">
        <Breadcrumbs
          className="mb-4"
          items={[
            { label: tNav('dashboard'), href: '/dashboard' },
            { label: tNav('domainVocabularies') },
          ]}
        />
        <ProGate
          trialExpired={quota.downgraded}
          trialEndsAt={quota.trialEndsAt}
        />
      </Container>
    );
  }

  const columns: DataTableColumn<SerializableTermLink>[] = [
    {
      key: 'canonical',
      header: t('table.canonical'),
      cell: (row) => (
        <div className="flex flex-col">
          <span className="font-mono text-sm font-medium text-fg">{row.canonical}</span>
          {row.parentCanonical ? (
            <span className="font-mono text-xs text-fg-subtle">
              {row.parentCanonical}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'localized',
      header: t('table.localized'),
      cell: (row) => (
        <div className="flex flex-col">
          <span className="text-sm text-fg">{row.localized}</span>
          {row.aliases.length > 0 ? (
            <span className="text-xs text-fg-subtle">{row.aliases.join(', ')}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'domain',
      header: t('table.domain'),
      cell: (row) => <span className="text-sm text-fg-muted">{row.domain}</span>,
    },
    {
      key: 'locale',
      header: t('table.locale'),
      cell: (row) => <span className="text-sm text-fg-muted">{row.locale}</span>,
    },
    {
      key: 'kind',
      header: t('table.kind'),
      cell: (row) => (
        <Badge variant="neutral">{translateKind(row.kind)}</Badge>
      ),
    },
    {
      key: 'updatedAt',
      header: t('table.updatedAt'),
      cell: (row) => (
        <span className="text-sm text-fg-muted">
          {dateFormatter.format(new Date(row.updatedAt))}
        </span>
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
            onClick={() => {
              setEditing(row);
              setDialogOpen(true);
            }}
          >
            {t('actions.edit')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setDeleting(row)}
          >
            {t('actions.delete')}
          </Button>
        </div>
      ),
    },
  ];

  const isUnlimited = quota.maxTerms === -1;
  const quotaLabel = isUnlimited
    ? t('quota.unlimited')
    : t('quota.used', { used: initialTotal, total: quota.maxTerms });
  const remaining = isUnlimited
    ? null
    : Math.max(0, quota.maxTerms - initialTotal);
  const atLimit = !isUnlimited && initialTotal >= quota.maxTerms;
  const quotaTone = pickQuotaTone(
    isUnlimited,
    initialTotal,
    quota.maxTerms,
    atLimit,
  );

  // Note: domain/locale filter dropdowns now only carry the values that
  // appear in the current server response. Server-side pagination is
  // the authority here — there's no client-side facet set to keep alive
  // across narrowing because the URL already round-trips state. If the
  // user wants to re-widen, "All" clears the filter.
  const domainOptionsFromRows = uniqueSorted(initialTerms.map((r) => r.domain));
  const localeOptionsFromRows = uniqueSorted(initialTerms.map((r) => r.locale));
  const domainOptions = upsert(domainOptionsFromRows, initialFilters.domain);
  const localeOptions = upsert(localeOptionsFromRows, initialFilters.locale);

  return (
    <Container size="xl" className="py-6 sm:py-10">
      <DowngradeBanner
        trialExpired={quota.downgraded}
        trialEndsAt={quota.trialEndsAt}
      />

      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        breadcrumbs={
          <Breadcrumbs
            items={[
              { label: tNav('dashboard'), href: '/dashboard' },
              { label: tNav('domainVocabularies') },
            ]}
          />
        }
        action={
          <div className="flex flex-wrap gap-2">
            <Link
              href="/domain-vocabularies/snapshots"
              className="inline-flex items-center rounded-md border border-border bg-bg px-3 py-2 text-sm font-medium text-fg hover:bg-bg-subtle"
            >
              {t('snapshots')}
            </Link>
            <Button
              variant="outline"
              onClick={() => setBulkOpen(true)}
              disabled={atLimit}
              title={atLimit ? t('quota.atLimit') : undefined}
            >
              {t('bulkUpload')}
            </Button>
            <Button
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
              disabled={atLimit}
              aria-disabled={atLimit}
              title={atLimit ? t('quota.atLimit') : undefined}
            >
              {t('newTerm')}
            </Button>
          </div>
        }
      />

      {activeJobId ? (
        <div className="mt-4">
          <BulkJobProgress
            jobId={activeJobId}
            onClear={() => setActiveJobId(null)}
            onTerminal={refreshRsc}
          />
        </div>
      ) : null}

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <StatCard
          label={t('quota.label')}
          value={quotaLabel}
          tone={quotaTone}
          hint={
            remaining === null
              ? undefined
              : atLimit
                ? t('quota.atLimit')
                : t('quota.remaining', { n: remaining })
          }
        />
        <StatCard label={t('stats.visible')} value={String(initialTerms.length)} />
      <StatCard label={t('actions.deletedRecoverable')} value={String(initialDeletedCount)} />
      </div>

      <div className="mt-5 flex gap-2">
        <Button variant={!showDeleted ? 'primary' : 'outline'} onClick={() => setShowDeleted(false)}>{t('actions.activeTerms')}</Button>
        <Button variant={showDeleted ? 'primary' : 'outline'} onClick={() => setShowDeleted(true)}>{t('actions.recentlyDeleted')}</Button>
      </div>

      <div className="mt-6 flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1">
          <ListSearchInput
            value={searchInput}
            onChange={handleSearchChange}
            placeholder={t('filters.search')}
          />
        </div>
        <Select
          aria-label={t('filters.domain')}
          value={initialFilters.domain}
          onChange={(e) =>
            navigate({ filters: { domain: e.target.value || undefined } })
          }
        >
          <option value="">{t('filters.all')}</option>
          {domainOptions.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </Select>
        <Select
          aria-label={t('filters.locale')}
          value={initialFilters.locale}
          onChange={(e) =>
            navigate({ filters: { locale: e.target.value || undefined } })
          }
        >
          <option value="">{t('filters.all')}</option>
          {localeOptions.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </Select>
        <Select
          aria-label={t('filters.kind')}
          value={initialFilters.kind}
          onChange={(e) =>
            navigate({ filters: { kind: e.target.value || undefined } })
          }
        >
          <option value="">{t('filters.all')}</option>
          {KIND_OPTIONS.map((k) => (
            <option key={k} value={k}>
              {translateKind(k)}
            </option>
          ))}
        </Select>
      </div>

      <div className="mt-6">
        {showDeleted ? (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm"><thead><tr><th className="p-3">{t('table.canonical')}</th><th className="p-3">{t('table.localized')}</th><th className="p-3">{t('table.domain')}</th><th className="p-3">{t('table.actions')}</th></tr></thead>
              <tbody>{deletedTerms.map((term) => <tr key={term.id} className="border-t border-border"><td className="p-3 font-mono">{term.canonical}</td><td className="p-3">{term.localized}</td><td className="p-3">{term.domain}</td><td className="p-3"><Button size="sm" disabled={busy} onClick={() => handleRestore(term)}>{t('actions.restore')}</Button></td></tr>)}</tbody>
            </table>
            {deletedTerms.length === 0 ? <p className="p-6 text-center text-sm text-fg-muted">{t('actions.noRecentlyDeleted')}</p> : null}
            {deletedTerms.length < initialDeletedCount ? <div className="p-3 text-center"><Button variant="outline" disabled={loadingDeletedPage} onClick={async () => {
              setLoadingDeletedPage(true);
              try {
                const page = Math.floor(deletedTerms.length / 200) + 1;
                const res = await fetch(`/api/v1/domain-vocabularies/terms?deletedOnly=true&page=${page}&pageSize=200`, { credentials: 'same-origin' });
                if (!res.ok) throw new Error(t('dialog.errorGeneric'));
                const result = await res.json() as { items: SerializableTermLink[] };
                setDeletedTerms((current) => [...current, ...result.items]);
              } catch (err) {
                toast.error(err instanceof Error ? err.message : t('dialog.errorGeneric'));
              } finally {
                setLoadingDeletedPage(false);
              }
            }}>{loadingDeletedPage ? t('actions.loadingMore') : t('actions.loadMore')}</Button></div> : null}
          </div>
        ) : <DataTable
          columns={columns}
          rows={initialTerms}
          getRowKey={(row) => row.id}
          aria-label={t('title')}
          emptyState={
            <EmptyState
              title={t('empty.title')}
              description={t('empty.description')}
              action={
                <Button
                  onClick={() => {
                    setEditing(null);
                    setDialogOpen(true);
                  }}
                  disabled={atLimit}
                >
                  {t('newTerm')}
                </Button>
              }
            />
          }
        />}
      </div>

      <Pagination
        page={initialPage}
        pageSize={initialPageSize}
        total={initialTotal}
        pageSizeOptions={[...VOCAB_URL_OPTS.allowedPageSizes]}
        buildHref={({ page, pageSize }) =>
          buildListUrl(
            pathname,
            currentUrlState,
            { page, pageSize, resetPage: false },
            VOCAB_URL_OPTS,
          )
        }
        onPageSizeChange={(next) => navigate({ pageSize: next })}
      />

      <VocabularyDialog
        isOpen={dialogOpen}
        mode={editing ? 'edit' : 'create'}
        initialValues={editing ?? undefined}
        onClose={() => {
          if (!busy) {
            setDialogOpen(false);
            setEditing(null);
          }
        }}
        onSave={handleSave}
        isSaving={busy}
      />

      <BulkUploadDialog
        isOpen={bulkOpen}
        bulkAsyncAllowed={quota.bulkAsync}
        onClose={() => setBulkOpen(false)}
        onEnqueued={(jobId) => setActiveJobId(jobId)}
      />

      <ConfirmDialog
        isOpen={!!deleting}
        title={t('delete.title')}
        description={
          deleting
            ? t('delete.description', { name: deleting.localized })
            : ''
        }
        variant="danger"
        confirmLabel={t('delete.confirm')}
        cancelLabel={t('delete.cancel')}
        isLoading={busy}
        onConfirm={handleDelete}
        onCancel={() => {
          if (!busy) setDeleting(null);
        }}
      />
    </Container>
  );
}

function stripEmpty(filters: VocabFilters): Record<string, string> {
  const out: Record<string, string> = {};
  if (filters.domain) out.domain = filters.domain;
  if (filters.locale) out.locale = filters.locale;
  if (filters.kind) out.kind = filters.kind;
  return out;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Ensure the currently-active filter value is always present in the
 * dropdown options, even if it doesn't appear in the current page's
 * rows (which can happen when the user narrows the filter past the
 * first page).
 */
function upsert(values: string[], current: string): string[] {
  if (!current || values.includes(current)) return values;
  return [...values, current].sort();
}
