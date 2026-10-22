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

// 与 lib/ai-circuit-breaker 的 CircuitState 一致（API 原样返回），状态徽标按这三个取值映射文案。
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
 * AI 熔断器管理页。
 *
 * 后端为 /api/admin/ai-circuit-breaker：GET 取状态，POST { action: 'trip' | 'release' } 熔断或解除。
 * 页面展示：
 *   - 今日平台成本（统计卡），便于判断离自动熔断阈值还有多远；
 *   - 当前熔断状态徽标（closed / free_stopped / free_trial_stopped），与管理员概览卡片同源、本地化显示；
 *   - 自动熔断所比较的阈值；
 *   - 手动熔断（确认框把关）：停止 Free 与 Trial 的 AI 调用（含之后才进入这两个套餐的用户），
 *     持续到 UTC 当日结束或解除，用于成本尚未触及阈值的上游故障；
 *   - 解除（确认框把关）：同时撤销自动与手动熔断，用于故障结束但当日熔断尚未到期的情况。
 *
 * 状态每 30 秒自动刷新，「刷新」按钮可立即重新拉取。
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
