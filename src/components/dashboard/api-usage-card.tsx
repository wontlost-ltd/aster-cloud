'use client';

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CLIENT_CAPABILITIES } from '@/hooks/use-deployment-mode';

interface ApiUsage {
  plan: string;
  period: string;
  monthly: { used: number; limit: number; remaining: number; percent: number };
  latency: { p50: number; p95: number; sampleCount: number };
  trend: Array<{ day: string; calls: number }>;
}

/**
 * 用户 dashboard Policy Execution API 用量卡片
 * 显示：本月用量进度条 / p50/p95 延迟 / 升级 CTA
 *
 * Free 计划（limit=0）显示锁定状态
 * Enterprise（limit=-1）显示无限符号 + 仅延迟
 */
export function ApiUsageCard({ locale }: { locale: string }) {
  const t = useTranslations('dashboard.apiUsage');
  // 进度条以卡片标题为可访问名称（axe aria-progressbar-name）
  const titleId = useId();
  const [data, setData] = useState<ApiUsage | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/user/api-usage')
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="h-32 animate-pulse rounded-lg bg-bg-muted" />;
  }
  if (!data) return null;

  // Free 计划 — 锁定状态 + 升级 CTA
  if (data.monthly.limit === 0) {
    return (
      <div className="rounded-lg border border-border bg-bg-subtle p-4">
        <div className="flex items-center justify-between">
          <h3 id={titleId} className="text-sm font-medium text-fg">{t('title')}</h3>
          <span className="rounded bg-bg-muted px-2 py-0.5 text-xs font-medium text-fg-muted">
            {t('locked')}
          </span>
        </div>
        <p className="mt-2 text-xs text-fg-muted">{t('lockedHint')}</p>
        {/* On-prem 没有 plan 升级；API 访问由 license 决定，
            "upgrade" 链接到 pricing 不可达。隐藏 CTA。 */}
        {CLIENT_CAPABILITIES.pricing && (
          <Link
            href={`/${locale}/pricing`}
            className="mt-3 inline-block text-xs font-medium text-primary hover:underline"
          >
            {t('upgrade')} →
          </Link>
        )}
      </div>
    );
  }

  const percent = data.monthly.percent;
  const barColor = percent >= 100 ? 'bg-red-500' : percent >= 80 ? 'bg-yellow-500' : 'bg-primary';
  const textColor = percent >= 100 ? 'text-red-700' : percent >= 80 ? 'text-yellow-700' : 'text-fg';

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between">
        <h3 id={titleId} className="text-sm font-medium text-fg">{t('title')}</h3>
        <span className={`text-xs font-medium ${textColor}`}>
          {data.monthly.used.toLocaleString()} / {data.monthly.limit === -1 ? '∞' : data.monthly.limit.toLocaleString()}
        </span>
      </div>

      {data.monthly.limit !== -1 && (
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-bg-muted">
          <div
            className={`h-full ${barColor} transition-all`}
            style={{ width: `${Math.min(percent, 100)}%` }}
            role="progressbar"
            aria-labelledby={titleId}
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
      )}

      <div className="mt-3 flex items-center justify-between text-xs text-fg-muted">
        <span>{t('latencyP50', { ms: data.latency.p50 })}</span>
        <span>{t('latencyP95', { ms: data.latency.p95 })}</span>
        <span>{t('plan', { plan: data.plan })}</span>
      </div>

      {percent >= 80 && data.monthly.limit !== -1 && (
        <div className="mt-3 rounded bg-yellow-50 p-2 text-xs text-yellow-800">
          {percent >= 100
            ? t('warningOverage', { percent })
            : t('warningHighUsage', { remaining: data.monthly.remaining })}
          {CLIENT_CAPABILITIES.pricing && (
            <Link
              href={`/${locale}/pricing`}
              className="ml-2 font-medium text-primary hover:underline"
            >
              {t('upgrade')} →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
