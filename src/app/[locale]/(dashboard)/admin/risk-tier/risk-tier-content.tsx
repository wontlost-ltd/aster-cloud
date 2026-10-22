'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Container, PageHeader, Breadcrumbs } from '@/components/ui';
import { formatDate } from '@/lib/format';

interface RiskRow {
  id: string;
  email: string | null;
  emailNormalized: string | null;
  plan: string;
  riskTier: number;
  riskTierReason: string | null;
  priorPurgeCount: number;
  reactivationCount: number;
  createdAt: string;
  deletedAt: string | null;
}

type SortKey = 'riskTier' | 'createdAt' | 'priorPurgeCount';


/**
 * 风险等级的本地化显示（「等级 1（常规）」）。此前是写死的英文 trusted/normal/…，
 * 卡片还加了 uppercase，zh 页面上显示成 "TIER 1 (NORMAL)"。
 * 键写成字面量，便于 check:message-keys 静态核对；未知等级只显示数字。
 */
function useTierLabel(): (tier: number) => string {
  const t = useTranslations('admin.riskTier');
  const names: Record<number, string> = {
    0: t('tiers.trusted'),
    1: t('tiers.normal'),
    2: t('tiers.elevated'),
    3: t('tiers.high'),
    4: t('tiers.hard'),
  };
  return (tier) => (names[tier] ? t('tierCard', { tier, label: names[tier] }) : String(tier));
}

const TIER_COLORS: Record<number, string> = {
  0: 'bg-bg-muted text-fg',
  1: 'bg-yellow-100 text-yellow-800',
  2: 'bg-orange-100 text-orange-800',
  3: 'bg-red-100 text-red-800',
  4: 'bg-red-200 text-red-900 font-semibold',
};

export function RiskTierAdminContent() {
  const t = useTranslations('admin.riskTier');
  const tNav = useTranslations('dashboardNav');
  const tierLabel = useTierLabel();
  const locale = useLocale();
  const [rows, setRows] = useState<RiskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [minTier, setMinTier] = useState<number>(1);
  const [sortBy, setSortBy] = useState<SortKey>('riskTier');

  const [overrideOf, setOverrideOf] = useState<RiskRow | null>(null);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/risk-tier?minTier=${minTier}&limit=200`);
      if (!res.ok) {
        // Prefer the BFF's structured envelope (lib/api/error-envelope):
        //   { error: { code, message, requestId } }
        // Fall back to the x-request-id header when the body is not
        // parseable. Never display raw stack-trace text — surface the
        // requestId so support can correlate to the Worker log.
        const body = (await res.json().catch(() => null)) as
          | { error?: { requestId?: string } }
          | null;
        const requestId =
          body?.error?.requestId ??
          res.headers.get('x-request-id') ??
          '';
        setError(requestId ? `id:${requestId}` : `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as { users: RiskRow[] };
      setRows(data.users);
    } catch {
      // Network-tier failure (offline, DNS, etc.) — no requestId
      // possible; flag a transient error without leaking exception text.
      setError('network');
    } finally {
      setLoading(false);
    }
  }, [minTier]);

  useEffect(() => {
    // 挂载/minTier 变化时拉取数据，fetchRows 首行同步 setLoading(true) 是刻意的加载态，故意在 effect 内 set
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchRows();
  }, [fetchRows]);

  const sorted = [...rows].sort((a, b) => {
    if (sortBy === 'riskTier') return b.riskTier - a.riskTier;
    if (sortBy === 'priorPurgeCount') return b.priorPurgeCount - a.priorPurgeCount;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  const distribution: Record<number, number> = {};
  for (const r of rows) distribution[r.riskTier] = (distribution[r.riskTier] ?? 0) + 1;

  return (
    <Container size="xl" className="py-6 sm:py-10">
      {/* deep 页：保留 Breadcrumbs（放进 PageHeader 的 breadcrumbs slot）。
          xl 宽：本页含 5 个统计卡 + 8 列表格，数据密集。 */}
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        breadcrumbs={
          <Breadcrumbs
            items={[
              { label: tNav('groupAdmin') },
              { label: t('title') },
            ]}
          />
        }
        className="mb-6"
      />

      <section className="mb-6 grid gap-3 grid-cols-2 sm:grid-cols-5">
        {[1, 2, 3, 4].map((tier) => (
          <div
            key={tier}
            className={`rounded-lg border border-border p-4 dark:border-gray-700 ${TIER_COLORS[tier]}`}
          >
            <p className="text-xs tracking-wider">
              {tierLabel(tier)}
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {distribution[tier] ?? 0}
            </p>
          </div>
        ))}
        <div className="rounded-lg border border-border p-4 dark:border-gray-700">
          <p className="text-xs uppercase tracking-wider text-fg-muted">{t('total')}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{rows.length}</p>
        </div>
      </section>

      <section className="mb-4 flex flex-wrap items-center gap-3">
        <label className="text-sm">
          {t('filters.minTier')}{' '}
          <select
            value={minTier}
            onChange={(e) => setMinTier(Number(e.target.value))}
            className="ml-1 rounded border border-border-strong px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800"
          >
            {[1, 2, 3, 4].map((v) => (
              <option key={v} value={v}>
                ≥ {tierLabel(v)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          {t('filters.sortBy')}{' '}
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortKey)}
            className="ml-1 rounded border border-border-strong px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800"
          >
            <option value="riskTier">{t('filters.byTier')}</option>
            <option value="createdAt">{t('filters.byCreated')}</option>
            <option value="priorPurgeCount">{t('filters.byPurges')}</option>
          </select>
        </label>
        <button
          onClick={fetchRows}
          className="ml-auto rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-hover"
        >
          {t('refresh')}
        </button>
      </section>

      {loading && <p className="text-sm text-fg-muted">{t('loading')}</p>}
      {error && <ErrorBlock error={error} />}

      {!loading && !error && (
        <div className="overflow-x-auto rounded-lg border border-border dark:border-gray-700">
          <table className="min-w-full divide-y divide-border dark:divide-gray-700">
            <thead className="bg-bg-subtle dark:bg-gray-800">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-fg-muted">
                  {t('table.tier')}
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-fg-muted">
                  {t('table.email')}
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-fg-muted">
                  {t('table.plan')}
                </th>
                <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-fg-muted">
                  {t('table.priorPurges')}
                </th>
                <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-fg-muted">
                  {t('table.reactivations')}
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-fg-muted">
                  {t('table.reason')}
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-fg-muted">
                  {t('table.created')}
                </th>
                <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-fg-muted">
                  {t('table.actions')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border dark:divide-gray-700">
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-sm text-fg-muted">
                    {t('empty')}
                  </td>
                </tr>
              )}
              {sorted.map((r) => (
                <tr key={r.id} className={r.deletedAt ? 'bg-bg-subtle/50 dark:bg-gray-900/40' : ''}>
                  <td className="px-3 py-2">
                    <span className={`inline-flex rounded px-2 py-0.5 text-xs ${TIER_COLORS[r.riskTier]}`}>
                      {tierLabel(r.riskTier)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-sm">
                    <div className="font-mono">{r.email ?? '—'}</div>
                    {r.emailNormalized && r.emailNormalized !== r.email && (
                      <div className="font-mono text-xs text-fg-muted">↳ {r.emailNormalized}</div>
                    )}
                    {r.deletedAt && (
                      <div className="mt-0.5 text-xs text-red-600">
                        {t('table.tombstoned')}: {formatDate(r.deletedAt, locale)}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-sm">{r.plan}</td>
                  <td className="px-3 py-2 text-right text-sm tabular-nums">{r.priorPurgeCount}</td>
                  <td className="px-3 py-2 text-right text-sm tabular-nums">{r.reactivationCount}</td>
                  <td className="px-3 py-2 text-xs font-mono">{r.riskTierReason ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-fg-muted">
                    {formatDate(r.createdAt, locale)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => setOverrideOf(r)}
                      className="rounded bg-bg-muted px-2 py-1 text-xs font-medium hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600"
                    >
                      {t('table.override')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {overrideOf && (
        <OverrideModal
          row={overrideOf}
          onClose={() => setOverrideOf(null)}
          onDone={() => {
            setOverrideOf(null);
            fetchRows();
          }}
        />
      )}
    </Container>
  );
}

function OverrideModal({
  row,
  onClose,
  onDone,
}: {
  row: RiskRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('admin.riskTier.override');
  const tierLabel = useTierLabel();
  const [newTier, setNewTier] = useState<number>(0);
  const [ticketId, setTicketId] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/risk-tier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: row.id,
          newTier,
          ticketId: ticketId.trim() || undefined,
          note: note.trim() || undefined,
        }),
      });
      if (!res.ok) {
        // 4xx validation responses keep the old envelope shape
        // ({error: 'userId_required'}). 5xx server failures use the
        // structured envelope ({error: {code, message, requestId}}).
        // Both are surfaced via ErrorBlock — by-id for the latter,
        // by-code for the former so the operator sees an actionable
        // hint without leaking stack-trace text.
        const body = (await res.json().catch(() => null)) as
          | { error?: string | { code?: string; requestId?: string } }
          | null;
        if (body?.error && typeof body.error === 'object') {
          const reqId =
            body.error.requestId ?? res.headers.get('x-request-id') ?? '';
          setError(reqId ? `id:${reqId}` : `HTTP ${res.status}`);
        } else if (typeof body?.error === 'string') {
          setError(`code:${body.error}`);
        } else {
          setError(`HTTP ${res.status}`);
        }
        return;
      }
      onDone();
    } catch {
      setError('network');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-lg bg-bg p-6 shadow-xl dark:bg-gray-900">
        <h3 className="text-lg font-semibold">{t('title')}</h3>
        <p className="mt-2 text-sm text-fg-muted dark:text-fg-subtle">
          <span className="font-mono">{row.email ?? row.id}</span>
        </p>
        <p className="mt-1 text-xs text-fg-muted">
          {t('currentTier')}: <span className={`rounded px-1 ${TIER_COLORS[row.riskTier]}`}>
            {tierLabel(row.riskTier)}
          </span>
        </p>

        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            {t('newTier')}
            <select
              value={newTier}
              onChange={(e) => setNewTier(Number(e.target.value))}
              className="mt-1 block w-full rounded border border-border-strong px-2 py-1 dark:border-gray-700 dark:bg-gray-800"
            >
              {[0, 1, 2, 3, 4].map((v) => (
                <option key={v} value={v}>
                  {tierLabel(v)}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm">
            {t('ticketId')} <span className="text-xs text-fg-muted">{t('ticketIdHint')}</span>
            <input
              type="text"
              value={ticketId}
              onChange={(e) => setTicketId(e.target.value)}
              placeholder="SUP-1234"
              className="mt-1 block w-full rounded border border-border-strong px-2 py-1 dark:border-gray-700 dark:bg-gray-800"
            />
          </label>

          <label className="block text-sm">
            {t('note')}
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder={t('notePlaceholder')}
              className="mt-1 block w-full rounded border border-border-strong px-2 py-1 dark:border-gray-700 dark:bg-gray-800"
            />
          </label>

          {error && <ErrorBlock error={error} compact />}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="rounded px-3 py-1.5 text-sm hover:bg-bg-muted dark:hover:bg-gray-800"
          >
            {t('cancel')}
          </button>
          <button
            onClick={submit}
            disabled={submitting || newTier === row.riskTier}
            className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {submitting ? t('submitting') : t('submit')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Localized error renderer that never displays raw exception text.
 *
 * The setError() callers above encode the failure mode as a short
 * tagged string:
 *   `id:<requestId>`  → server failure with a structured envelope.
 *   `code:<code>`     → 4xx validation error from the BFF (e.g.
 *                       'userId_required', 'cannot_override_self').
 *   `network`         → fetch threw before any response (offline / DNS).
 *   anything else     → HTTP status fallback, treat as generic.
 *
 * Display rules:
 *   - For id: → "Could not load this view. Error ID: <uuid>"
 *   - For code: → "Could not load this view. Code: <code>"
 *   - Otherwise → just the generic line.
 */
function ErrorBlock({ error, compact }: { error: string; compact?: boolean }) {
  const tCommon = useTranslations('common');
  const colorClass = compact
    ? 'rounded bg-red-50 p-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300'
    : 'rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300';

  const idMatch = /^id:(.+)$/.exec(error);
  const codeMatch = /^code:(.+)$/.exec(error);

  return (
    <div role="alert" className={colorClass}>
      <p className="font-medium">{tCommon('loadFailed')}</p>
      {idMatch && (
        <p className="mt-1 font-mono text-xs opacity-80">
          {tCommon('errorId')}: {idMatch[1]}
        </p>
      )}
      {codeMatch && (
        <p className="mt-1 font-mono text-xs opacity-80">{codeMatch[1]}</p>
      )}
    </div>
  );
}
