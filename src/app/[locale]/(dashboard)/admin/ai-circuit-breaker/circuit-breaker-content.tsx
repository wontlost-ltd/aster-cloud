'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Badge,
  Breadcrumbs,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  CardDescription,
  ConfirmDialog,
  Container,
  PageHeader,
  Stack,
  StatCard,
  toast,
} from '@/components/ui';
import { Activity, RefreshCw } from 'lucide-react';
import { useApi } from '@/lib/api';
import { extractErrorMessage } from '@/lib/api/error-envelope';

// 与 lib/ai-circuit-breaker 的 CircuitState 一致（API 原样返回）。此前页面期望的是
// 'OPEN' | 'CLOSED_*' 一套从未存在过的取值，导致「当前状态」永远落到 '—'。
type CircuitState = 'closed' | 'free_stopped' | 'free_trial_stopped';

interface CircuitStatus {
  today_cents: number;
  today_usd: string;
  state: CircuitState;
  /** 当前生效的熔断 ban 推出的状态；'closed' 表示没有可解除的熔断。 */
  ban_state: CircuitState;
  /** 生效的熔断里是否有管理员手动熔断。 */
  manual: boolean;
  thresholds: {
    free_stop_usd: number;
    trial_stop_usd: number;
  };
}

/**
 * Admin console for the LLM circuit breaker.
 *
 * Backend exposes GET (status) + POST { action: 'trip' | 'release' } at
 * /api/admin/ai-circuit-breaker. This page surfaces:
 *
 *   - Today's platform spend as a stat card so the admin sees how
 *     close the auto-trip thresholds are.
 *   - Current circuit state as a badge (closed / free_stopped /
 *     free_trial_stopped) read from the same source as the admin
 *     overview card, with localized labels.
 *   - Thresholds the auto-tripper compares against.
 *   - Manual Trip button (gated by ConfirmDialog): stops Free + Trial
 *     AI calls until end of the UTC day, for provider incidents where
 *     cost has not yet crossed the auto thresholds.
 *   - Manual Release button (gated by ConfirmDialog) that POSTs
 *     to /release the circuit, used when an incident is over but
 *     the auto-trip cooldown hasn't elapsed yet. Release undoes both
 *     automatic and manual trips.
 *
 * useApi caches the status for 30 s; an explicit "Refresh" button
 * re-fetches without waiting.
 */
export function CircuitBreakerContent() {
  const t = useTranslations('settings.aiCircuitBreakerPage');
  const tCommon = useTranslations('common');
  const { data, error, isLoading, mutate } = useApi<CircuitStatus>(
    '/api/admin/ai-circuit-breaker',
    { refreshInterval: 30_000 },
  );
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [confirmTrip, setConfirmTrip] = useState(false);
  const [pendingAction, setPendingAction] = useState<'trip' | 'release' | null>(null);

  const stateLabel = (() => {
    switch (data?.state) {
      case 'closed':
        return t('stateOpen');
      case 'free_stopped':
        return t('stateClosedFree');
      case 'free_trial_stopped':
        return t('stateClosedTrial');
      default:
        return '—';
    }
  })();
  const stateVariant = data?.state === 'closed' ? 'success' : 'danger';

  // 手动熔断与解除共用一条 POST；失败只显示本地化前缀 + 服务端错误码，不渲染异常文本。
  const post = async (action: 'trip' | 'release') => {
    setPendingAction(action);
    try {
      const res = await fetch('/api/admin/ai-circuit-breaker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: unknown };
      if (!res.ok) {
        const error = extractErrorMessage(body) || res.status;
        toast.error(
          action === 'trip' ? t('tripFailure', { error }) : t('releaseFailure', { error }),
        );
        return;
      }
      toast.success(action === 'trip' ? t('tripSuccess') : t('releaseSuccess'));
      setConfirmTrip(false);
      setConfirmRelease(false);
      mutate();
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <Container size="xl" className="py-6 sm:py-10">
      <Stack gap={6}>
        <PageHeader
          breadcrumbs={
            <Breadcrumbs items={[{ label: t('breadcrumb') }]} />
          }
          title={t('title')}
          subtitle={t('subtitle')}
          action={
            <Button
              variant="secondary"
              onClick={() => mutate()}
              disabled={isLoading}
            >
              <RefreshCw aria-hidden className="size-4" />
              {t('refresh')}
            </Button>
          }
        />

        {error && (
          // Never render error.message — it can carry stack-trace
          // fragments. The BFF now returns a structured envelope with
          // a stable requestId we can surface for support correlation.
          <div
            role="alert"
            className="rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger"
          >
            <p className="font-medium">{tCommon('loadFailed')}</p>
            {typeof error.body === 'object' &&
              error.body !== null &&
              'error' in error.body &&
              typeof (error.body as { error?: unknown }).error === 'object' &&
              (error.body as { error: { requestId?: string } }).error
                ?.requestId && (
                <p className="mt-1 font-mono text-xs opacity-80">
                  {tCommon('errorId')}:{' '}
                  {
                    (error.body as { error: { requestId: string } }).error
                      .requestId
                  }
                </p>
              )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <StatCard
            label={t('todaySpend')}
            value={data ? t('spendUsd', { usd: data.today_usd }) : '—'}
            icon={<Activity className="size-5" />}
            tone={data && data.state !== 'closed' ? 'danger' : 'primary'}
          />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('currentState')}</CardTitle>
              <CardDescription>
                <Badge variant={stateVariant}>{stateLabel}</Badge>
                {data?.manual && (
                  <span className="ml-2 text-xs text-fg-muted">{t('manualNote')}</span>
                )}
              </CardDescription>
            </CardHeader>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('thresholds')}</CardTitle>
          </CardHeader>
          <CardBody>
            <Stack direction="row" gap={6} wrap>
              <span className="text-sm text-fg-muted">
                {t('thresholdFree', {
                  usd: data ? data.thresholds.free_stop_usd.toFixed(2) : '—',
                })}
              </span>
              <span className="text-sm text-fg-muted">
                {t('thresholdTrial', {
                  usd: data ? data.thresholds.trial_stop_usd.toFixed(2) : '—',
                })}
              </span>
            </Stack>
          </CardBody>
        </Card>

        <Card className="border-danger/40">
          <CardHeader>
            <CardTitle className="text-base text-danger">{t('trip')}</CardTitle>
            <CardDescription>{t('tripHint')}</CardDescription>
          </CardHeader>
          <CardBody>
            <Button
              variant="destructive"
              onClick={() => setConfirmTrip(true)}
              disabled={!data || data.ban_state === 'free_trial_stopped'}
            >
              {t('trip')}
            </Button>
          </CardBody>
        </Card>

        <Card className="border-danger/40">
          <CardHeader>
            <CardTitle className="text-base text-danger">
              {t('release')}
            </CardTitle>
            <CardDescription>{t('releaseConfirmBody')}</CardDescription>
          </CardHeader>
          <CardBody>
            {/* 只有存在生效的熔断 ban 时才有东西可解除。 */}
            <Button
              variant="destructive"
              onClick={() => setConfirmRelease(true)}
              disabled={!data || data.ban_state === 'closed'}
            >
              {t('release')}
            </Button>
          </CardBody>
        </Card>
      </Stack>

      <ConfirmDialog
        isOpen={confirmTrip}
        title={t('tripConfirmTitle')}
        description={t('tripConfirmBody')}
        confirmLabel={t('tripConfirmAction')}
        cancelLabel={t('releaseConfirmCancel')}
        variant="danger"
        isLoading={pendingAction === 'trip'}
        onConfirm={() => post('trip')}
        onCancel={() => pendingAction === null && setConfirmTrip(false)}
      />
      <ConfirmDialog
        isOpen={confirmRelease}
        title={t('releaseConfirmTitle')}
        description={t('releaseConfirmBody')}
        confirmLabel={t('releaseConfirmAction')}
        cancelLabel={t('releaseConfirmCancel')}
        variant="danger"
        isLoading={pendingAction === 'release'}
        onConfirm={() => post('release')}
        onCancel={() => pendingAction === null && setConfirmRelease(false)}
      />
      {/* tCommon kept for future use; suppress unused lint */}
      <span hidden>{tCommon('loading')}</span>
    </Container>
  );
}
