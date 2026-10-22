'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useApi } from '@/lib/api';

interface AhaAchieved {
  achieved: true;
  achievedAt: string;
  hoursToFirst: number | null;
  withinAhaWindow: boolean | null;
  ahaWindowHours: number;
}

interface AhaPending {
  achieved: false;
  hoursSinceSignup: number;
  hoursRemaining: number;
  ahaWindowHours: number;
  expired: boolean;
  /** 是否已有未删除的策略；为 true 时「创建首个策略」引导没有意义，卡片不渲染 */
  hasPolicies?: boolean;
}

type AhaStatus = AhaAchieved | AhaPending;

/**
 * AHA Moment 卡片
 *
 * 已达成：庆祝消息 + 用时统计
 * 未达成 + 在 24h 窗口内：进度条 + 剩余时间 + 首条策略 CTA
 * 已超出 24h 窗口：仍提示 publish 首条策略（无窗口压力）
 * 未达成但已有策略：不渲染（卡片的行动入口是「创建策略」，对已有策略的用户是噪音）
 *
 * Data: useApi caches /api/user/aha-status across mounts (multiple
 * dashboard surfaces can render this card without re-fetching) and
 * SWR's natural revalidate-on-focus picks up backend state changes
 * without the parent needing to plumb an explicit refetch.
 */
export function AhaStatusCard({ locale }: { locale: string }) {
  const t = useTranslations('dashboard.aha');
  const { data, isLoading } = useApi<AhaStatus>('/api/user/aha-status');

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border bg-bg p-4 shadow-sm">
        <div className="h-4 w-24 animate-pulse rounded bg-bg-muted" />
        <div className="mt-2 h-6 w-40 animate-pulse rounded bg-bg-muted" />
      </div>
    );
  }

  if (!data) return null;

  if (data.achieved) {
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 p-4 shadow-sm">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-green-700">
              {t('achievedTitle')}
            </p>
            <p className="mt-1 text-lg font-semibold text-green-900">
              {data.hoursToFirst !== null
                ? t('hoursAfterSignup', { hours: data.hoursToFirst })
                : t('achieved')}
            </p>
            {data.withinAhaWindow === true && (
              <p className="mt-1 text-xs text-green-700">
                {t('insideWindow', { hours: data.ahaWindowHours })}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (data.hasPolicies) return null;

  if (data.expired) {
    // 超出 AHA 窗口但仍未 publish — 温和提示，不威胁
    return (
      <div className="rounded-lg border border-border bg-bg p-4 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-wider text-fg-muted">
          {t('publishFirstTitle')}
        </p>
        <p className="mt-1 text-sm text-fg">
          {t('publishFirstBody')}
        </p>
        <Link
          href={`/${locale}/policies/new`}
          className="mt-2 inline-block text-sm font-medium text-primary hover:text-primary-hover"
        >
          {t('createPolicy')}
        </Link>
      </div>
    );
  }

  // 在 AHA 窗口内 — 显示倒计时鼓励
  const progressPercent = Math.min(
    100,
    Math.round((data.hoursSinceSignup / data.ahaWindowHours) * 100),
  );

  return (
    <div className="rounded-lg border border-primary/30 bg-primary-subtle p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wider text-primary-hover">
        {t('challengeTitle')}
      </p>
      <p className="mt-1 text-sm font-medium text-primary-active">
        {t('challengeBody', { hours: data.ahaWindowHours })}
      </p>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-primary-subtle">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${progressPercent}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-primary-hover">
        {t('hoursRemaining', { hours: data.hoursRemaining.toFixed(1) })}
      </p>
      <Link
        href={`/${locale}/policies/new`}
        className="mt-3 inline-block rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-hover"
      >
        {t('createPolicy')}
      </Link>
    </div>
  );
}
