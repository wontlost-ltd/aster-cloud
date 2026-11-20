'use client';

/**
 * Guard 对账明细（ADR 0061 §3.7）：按租户列孤儿动作，状态标签 OPEN / ACKNOWLEDGED / RESOLVED、severity 多选
 * （缺省 critical,warning）、kind 下拉、`before` 游标「加载更多」；管理员行内确认。
 *
 * - 未指定租户时按 R6 取跨租户摘要里排第一的租户（critical 最多；摘要不可用则取第一个可见租户，即个人租户）。
 * - 过滤条件写回 URL（history.replaceState：不新增历史、不触发服务端重渲染）；切换租户或过滤条件重置列表。
 * - 列表在客户端取；快速切换时中止旧请求并丢弃晚到的响应。
 * - 确认结果：成功 → 在 OPEN 视图中移出并提示；409 已不是 OPEN → 用返回的状态更新该行并说明；
 *   403 → 本租户的确认入口全部隐藏并提示权限已变化（BFF 每次现查角色）。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, Button, Container, EmptyState, Label, PageHeader, Select } from '@/components/ui';
import { ORPHAN_KINDS, ORPHAN_SEVERITIES, ORPHAN_STATUSES } from '@/lib/guard-reconciliation/kinds';
import type { ReconciliationOverview } from '@/lib/guard-reconciliation/overview';
import {
  filterToSearch,
  orphanListUrl,
  readBffError,
  type BffError,
  type OrphanFilter,
  type OrphanItem,
} from '@/lib/guard-reconciliation/ui';
import type { GuardOrphanKind, GuardOrphanSeverity, GuardOrphanStatus } from '@/services/policy/guard-types';
import type { AckResult } from './ack-dialog';
import { OrphanRow } from './orphan-row';

export interface TenantOption {
  id: string;
  /** 空串 = 个人租户。 */
  name: string;
  canAck: boolean;
}

interface Props {
  locale: string;
  tenants: TenantOption[];
  initialTenantId: string | null;
  initialFilter: OrphanFilter;
  breadcrumbs?: ReactNode;
}

interface PageBody {
  page: { items: OrphanItem[]; next?: number };
  canAck: boolean;
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; err: BffError }
  | { kind: 'ok'; items: OrphanItem[]; next?: number; canAck: boolean };

type FetchResult = { ok: true; body: PageBody } | { ok: false; err: BffError } | null;

/** 取一页；被中止时返回 null。 */
async function fetchPage(tenantId: string, filter: OrphanFilter, before: number | undefined, signal: AbortSignal): Promise<FetchResult> {
  try {
    const res = await fetch(orphanListUrl(tenantId, filter, before), { cache: 'no-store', signal });
    if (res.ok) return { ok: true, body: (await res.json()) as PageBody };
    return { ok: false, err: await readBffError(res) };
  } catch {
    return signal.aborted ? null : { ok: false, err: { httpStatus: 0 } };
  }
}

/** R6：跨租户摘要已按 critical 降序（平手 openTotal、个人租户优先）排好；取第一个仍可见的租户。 */
async function defaultTenant(tenants: TenantOption[]): Promise<string | null> {
  const fallback = tenants[0]?.id ?? null;
  if (tenants.length <= 1) return fallback;
  try {
    const res = await fetch('/api/guard-reconciliation', { cache: 'no-store' });
    if (!res.ok) return fallback;
    const overview = (await res.json()) as ReconciliationOverview;
    const visible = new Set(tenants.map((x) => x.id));
    return overview.tenants.find((x) => visible.has(x.tenantId))?.tenantId ?? fallback;
  } catch {
    return fallback;
  }
}

function syncUrl(tenantId: string, filter: OrphanFilter) {
  const search = new URLSearchParams({ tenant: tenantId });
  for (const [k, v] of filterToSearch(filter)) search.set(k, v);
  window.history.replaceState(window.history.state, '', `${window.location.pathname}?${search.toString()}`);
}

/** severity 多选：空数组 = 全部；不允许取消最后一个（否则与「全部」含义冲突）。 */
function toggleSeverity(current: GuardOrphanSeverity[], s: GuardOrphanSeverity): GuardOrphanSeverity[] {
  const base = current.length === 0 ? [...ORPHAN_SEVERITIES] : current;
  const next = base.includes(s) ? base.filter((x) => x !== s) : [...base, s];
  if (next.length === 0) return current;
  const ordered = ORPHAN_SEVERITIES.filter((x) => next.includes(x));
  return ordered.length === ORPHAN_SEVERITIES.length ? [] : ordered;
}

/** kind 下拉：空串 = 全部（去掉 kind 键）。 */
function withKind(filter: OrphanFilter, kind: GuardOrphanKind | ''): OrphanFilter {
  const next: OrphanFilter = { status: filter.status, severities: filter.severities };
  if (kind) next.kind = kind;
  return next;
}

export function ReconciliationContent({ locale, tenants, initialTenantId, initialFilter, breadcrumbs }: Props) {
  const t = useTranslations('guardReconciliation');
  const [tenantId, setTenantId] = useState<string | null>(initialTenantId);
  const [filter, setFilter] = useState<OrphanFilter>(initialFilter);
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [moreError, setMoreError] = useState<BffError | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState<{ variant: 'success' | 'warning'; text: string } | null>(null);
  const inflight = useRef<AbortController | null>(null);

  const load = useCallback(async (tenant: string, f: OrphanFilter) => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    setList({ kind: 'loading' });
    setMoreError(null);
    syncUrl(tenant, f);
    const r = await fetchPage(tenant, f, undefined, controller.signal);
    if (!r || controller.signal.aborted) return;
    setList(r.ok
      ? { kind: 'ok', items: r.body.page.items, next: r.body.page.next, canAck: r.body.canAck }
      : { kind: 'error', err: r.err });
  }, []);

  // 首屏：URL 指定了可见租户就用它，否则按 R6 取缺省租户
  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      const tenant = initialTenantId ?? (await defaultTenant(tenants));
      if (cancelled || !tenant) return;
      setTenantId(tenant);
      await load(tenant, initialFilter);
    };
    void start();
    return () => {
      cancelled = true;
      inflight.current?.abort();
    };
  }, [initialTenantId, tenants, initialFilter, load]);

  const change = (nextTenant: string, nextFilter: OrphanFilter) => {
    setTenantId(nextTenant);
    setFilter(nextFilter);
    setNotice(null);
    void load(nextTenant, nextFilter);
  };

  const loadMore = async () => {
    if (!tenantId || list.kind !== 'ok' || list.next === undefined) return;
    const controller = new AbortController();
    inflight.current = controller;
    setLoadingMore(true);
    setMoreError(null);
    const r = await fetchPage(tenantId, filter, list.next, controller.signal);
    setLoadingMore(false);
    if (!r || controller.signal.aborted) return;
    if (!r.ok) return setMoreError(r.err);
    setList((cur) => cur.kind === 'ok'
      ? { ...cur, items: [...cur.items, ...r.body.page.items], next: r.body.page.next }
      : cur);
  };

  const onAckResult = (orphanId: number, result: AckResult) => {
    if (result.kind === 'forbidden') {
      setList((cur) => (cur.kind === 'ok' ? { ...cur, canAck: false } : cur));
      setNotice({ variant: 'warning', text: t('ack.permissionChanged') });
      return;
    }
    const status: GuardOrphanStatus = result.kind === 'acknowledged' ? result.orphan.status : result.status;
    setList((cur) => {
      if (cur.kind !== 'ok') return cur;
      // 确认成功且当前是 OPEN 视图：移出该行；409 时保留该行并更新为当前状态，由行内说明原因
      if (result.kind === 'acknowledged' && filter.status !== status) {
        return { ...cur, items: cur.items.filter((o) => o.id !== orphanId) };
      }
      const patch = result.kind === 'acknowledged' ? result.orphan : { status };
      return { ...cur, items: cur.items.map((o) => (o.id === orphanId ? { ...o, ...patch } : o)) };
    });
    if (result.kind === 'acknowledged') setNotice({ variant: 'success', text: t('ack.done') });
  };

  const errorText = (err: BffError) => {
    if (err.httpStatus === 403) return t('errors.forbidden');
    if (err.error === 'invalid_query') return t('errors.invalid_query');
    if (err.error === 'upstream_unavailable') return t('errors.upstream_unavailable');
    return t('errors.generic');
  };

  const header = <PageHeader title={t('title')} subtitle={t('subtitle')} breadcrumbs={breadcrumbs} className="mb-6" />;

  if (tenants.length === 0) {
    return (
      <Container size="xl" className="py-6 sm:py-10">
        {header}
        <EmptyState title={t('noTenants')} description={t('noTenantsHint')} />
      </Container>
    );
  }

  const severityPressed = (s: GuardOrphanSeverity) => filter.severities.length === 0 || filter.severities.includes(s);

  return (
    <Container size="xl" className="py-6 sm:py-10">
      {header}

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="reconciliation-tenant">{t('filters.tenant')}</Label>
          <Select id="reconciliation-tenant" size="sm" value={tenantId ?? ''} disabled={!tenantId}
            onChange={(e) => change(e.target.value, filter)}>
            {tenants.map((x) => <option key={x.id} value={x.id}>{x.name || t('personal')}</option>)}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="reconciliation-kind">{t('filters.kind')}</Label>
          <Select id="reconciliation-kind" size="sm" value={filter.kind ?? ''} disabled={!tenantId}
            onChange={(e) => change(tenantId!, withKind(filter, e.target.value as GuardOrphanKind | ''))}>
            <option value="">{t('filters.allKinds')}</option>
            {ORPHAN_KINDS.map((k) => <option key={k.kind} value={k.kind}>{t(`kinds.${k.kind}.name`)}</option>)}
          </Select>
        </div>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium text-fg">{t('filters.severity')}</legend>
          <div className="flex gap-2">
            {ORPHAN_SEVERITIES.map((s) => (
              <Button key={s} size="sm" variant={severityPressed(s) ? 'primary' : 'secondary'} aria-pressed={severityPressed(s)}
                disabled={!tenantId} onClick={() => change(tenantId!, { ...filter, severities: toggleSeverity(filter.severities, s) })}>
                {t(`severity.${s}`)}
              </Button>
            ))}
          </div>
        </fieldset>
      </div>

      <div role="tablist" aria-label={t('filters.status')} className="mb-4 flex flex-wrap gap-2">
        {ORPHAN_STATUSES.map((s) => (
          <Button key={s} role="tab" aria-selected={s === filter.status} size="sm" disabled={!tenantId}
            variant={s === filter.status ? 'primary' : 'secondary'} onClick={() => change(tenantId!, { ...filter, status: s })}>
            {t(`status.${s}`)}
          </Button>
        ))}
      </div>

      {notice && <Alert variant={notice.variant} className="mb-4" data-testid="reconciliation-notice">{notice.text}</Alert>}

      {list.kind === 'loading' && <div data-testid="reconciliation-loading" className="h-8 w-64 animate-pulse rounded bg-bg-muted" />}

      {list.kind === 'error' && (
        <Alert variant="danger" className="mb-4" data-testid="reconciliation-error">
          {errorText(list.err)}
          {list.err.requestId && <span className="ml-1 font-mono text-xs">{t('errors.requestId', { id: list.err.requestId })}</span>}{' '}
          {tenantId && <Button size="sm" variant="secondary" onClick={() => load(tenantId, filter)}>{t('retry')}</Button>}
        </Alert>
      )}

      {list.kind === 'ok' && list.items.length === 0 && (
        <EmptyState title={t(`empty.${filter.status}`)} description={t('emptyHint')} />
      )}

      {list.kind === 'ok' && list.items.length > 0 && tenantId && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase text-fg-muted">
                <th className="px-4 py-2 text-left">{t('columns.severity')}</th>
                <th className="px-4 py-2 text-left">{t('columns.kind')}</th>
                <th className="px-4 py-2 text-left">{t('columns.detectedAt')}</th>
                <th className="px-4 py-2 text-left">{t('columns.executor')}</th>
                <th className="px-4 py-2 text-left">{t('columns.status')}</th>
                <th className="px-4 py-2 text-left">{t('columns.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((o) => (
                <OrphanRow key={o.id} orphan={o} tenantId={tenantId} canAck={list.canAck} locale={locale} onAckResult={onAckResult} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {list.kind === 'ok' && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {list.next !== undefined && (
            <Button variant="secondary" onClick={loadMore} disabled={loadingMore} data-testid="load-more">
              {loadingMore ? t('loading') : t('loadMore')}
            </Button>
          )}
          {moreError && (
            <Alert variant="danger">
              {errorText(moreError)}
              {moreError.requestId && <span className="ml-1 font-mono text-xs">{t('errors.requestId', { id: moreError.requestId })}</span>}
            </Alert>
          )}
        </div>
      )}
    </Container>
  );
}
