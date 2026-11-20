'use client';

/**
 * 治理页的「Guard 对账」摘要卡（ADR 0061 §3.7）。
 *
 * 挂载后在客户端取 `GET /api/guard-reconciliation`（跨租户摘要，cloud 不存对账状态），`/governance` 的 SSR
 * 因此不增加任何 aster-api 调用。每个可见租户一行：critical / warning / info 的 OPEN 计数、最近对账时间（UTC）、
 * 「查看」链接到按租户的明细页。没有任何可见租户（且无不可用租户）时整卡不渲染；单租户失败只提示数量。
 */
import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Alert, Badge, Button, Card, CardBody, CardHeader, CardTitle } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { ORPHAN_SEVERITIES } from '@/lib/guard-reconciliation/kinds';
import type { ReconciliationOverview } from '@/lib/guard-reconciliation/overview';
import { formatUtc, reconciliationPageHref } from '@/lib/guard-reconciliation/ui';
import type { GuardOrphanSeverity } from '@/services/policy/guard-types';

type LoadState = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ok'; overview: ReconciliationOverview };

/** 计数为 0 时一律中性；info 无论多少都中性（多为会自动解除的旧 SDK 记录）。 */
function badgeVariant(severity: GuardOrphanSeverity, count: number): 'danger' | 'warning' | 'neutral' {
  if (count > 0 && severity === 'critical') return 'danger';
  if (count > 0 && severity === 'warning') return 'warning';
  return 'neutral';
}

async function fetchOverview(): Promise<ReconciliationOverview | null> {
  try {
    const res = await fetch('/api/guard-reconciliation', { cache: 'no-store' });
    return res.ok ? ((await res.json()) as ReconciliationOverview) : null;
  } catch {
    return null;
  }
}

export function ReconciliationSummaryCard() {
  const t = useTranslations('governancePage.reconciliation');
  const locale = useLocale();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchOverview().then((overview) => {
      if (!cancelled) setState(overview ? { kind: 'ok', overview } : { kind: 'failed' });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const retry = useCallback(async () => {
    setState({ kind: 'loading' });
    const overview = await fetchOverview();
    setState(overview ? { kind: 'ok', overview } : { kind: 'failed' });
  }, []);

  if (state.kind === 'ok' && state.overview.tenants.length === 0 && state.overview.unavailableTenants.length === 0) {
    return null;
  }

  return (
    <Card data-testid="reconciliation-summary">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardBody>
        <p className="mb-3 text-sm text-fg-muted">{t('description')}</p>
        {state.kind === 'loading' && (
          <div data-testid="reconciliation-summary-loading" className="h-6 w-48 animate-pulse rounded bg-bg-muted" />
        )}
        {state.kind === 'failed' && (
          <Alert variant="danger">
            <span>{t('loadFailed')}</span>{' '}
            <Button size="sm" variant="secondary" onClick={retry}>{t('retry')}</Button>
          </Alert>
        )}
        {state.kind === 'ok' && (
          <>
            {state.overview.unavailableTenants.length > 0 && (
              <Alert variant="warning" className="mb-3">
                {t('unavailable', { count: state.overview.unavailableTenants.length })}
              </Alert>
            )}
            {state.overview.tenants.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs uppercase text-fg-muted">
                      <th className="px-2 py-1 text-left">{t('columns.workspace')}</th>
                      <th className="px-2 py-1 text-left">{t('columns.open')}</th>
                      <th className="px-2 py-1 text-left">{t('columns.lastRun')}</th>
                      <th className="px-2 py-1 text-left"><span className="sr-only">{t('columns.actions')}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.overview.tenants.map((row) => (
                      <tr key={row.tenantId} className="border-b border-border last:border-b-0"
                        data-testid={`reconciliation-tenant-${row.tenantId}`}>
                        <td className="px-2 py-2 font-medium text-fg">{row.tenantName || t('personal')}</td>
                        <td className="px-2 py-2">
                          <div className="flex flex-wrap gap-1">
                            {ORPHAN_SEVERITIES.map((s) => (
                              <Badge key={s} variant={badgeVariant(s, row.openBySeverity[s])} data-severity={s}>
                                {t(`counts.${s}`, { count: row.openBySeverity[s] })}
                              </Badge>
                            ))}
                          </div>
                        </td>
                        <td className="px-2 py-2 text-fg-muted">
                          {row.lastRunAt ? formatUtc(row.lastRunAt, locale) : t('neverRun')}
                        </td>
                        <td className="px-2 py-2 text-right">
                          <Link href={reconciliationPageHref(row.tenantId)}
                            className="font-medium text-primary hover:text-primary-hover">
                            {t('view')} →
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
