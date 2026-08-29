'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CLIENT_CAPABILITIES } from '@/hooks/use-deployment-mode';

interface AiUsage {
  plan: string;
  period: string;
  monthly: { used: number; limit: number; remaining: number; percent: number };
  cost: { cents: number; tokens: number };
  rateLimit: { perMinute: number; perMinuteUsed: number };
  byok: { enabled: boolean; providers: Array<{ provider: string; keyHint: string }> };
  banned: { until: string; reason: string } | null;
  emailVerified: boolean;
}

/**
 * 用户 dashboard AI 用量卡片
 * 显示：本月用量进度条 / BYOK 状态 / 封禁警告 / 升级 CTA
 */
export function AiUsageCard({ locale }: { locale: string }) {
  const t = useTranslations('dashboard.aiUsage');
  const [data, setData] = useState<AiUsage | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/user/ai-usage')
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="h-32 animate-pulse rounded-lg bg-bg-muted" />;
  }
  if (!data) return null;

  // 止血：不再把"绑定了 BYOK"当作"unlimited BYOK 模式"提前返回。BYOK 真实推理尚未接入
  // （推理走平台 key），BYOK 用户实际受平台配额约束——若此处仍显示"BYOK active / 无限"，
  // 会与真实的配额墙矛盾、误导用户。故 BYOK 用户也落到下面的正常配额进度条视图（其底部
  // 已有 AI keys 管理入口，绑定信息不丢失）。BYOK 真接入推理后再恢复专属视图。

  // 邮箱未验证（Free 档强制）
  if (data.plan === 'free' && !data.emailVerified) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
        <h3 className="text-sm font-medium text-amber-800">{t('emailUnverifiedTitle')}</h3>
        <p className="mt-1 text-xs text-amber-700">{t('emailUnverifiedHint')}</p>
        {/* 锚到设置页的邮箱验证区块，而非页面顶部——该页有十几个区块，
            落在顶部等于让用户自己找。#email-verification 由该区块的
            容器 id 提供。 */}
        <Link
          href={`/${locale}/settings#email-verification`}
          className="mt-2 inline-block text-xs font-medium text-primary hover:underline"
        >
          {t('verifyNow')} →
        </Link>
      </div>
    );
  }

  // 被封禁
  if (data.banned) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4">
        <h3 className="text-sm font-medium text-red-700">{t('bannedTitle')}</h3>
        <p className="mt-1 text-xs text-red-600">{data.banned.reason}</p>
        <p className="mt-2 text-xs text-fg-muted">
          {t('bannedUntil', { date: new Date(data.banned.until).toLocaleString() })}
        </p>
      </div>
    );
  }

  // 配额进度条
  const percent = data.monthly.percent;
  const barColor = percent >= 90 ? 'bg-red-500' : percent >= 70 ? 'bg-yellow-500' : 'bg-primary';
  const textColor = percent >= 90 ? 'text-red-700' : percent >= 70 ? 'text-yellow-700' : 'text-fg';

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-fg">{t('title')}</h3>
        <span className={`text-xs font-medium ${textColor}`}>
          {data.monthly.used} / {data.monthly.limit === -1 ? '∞' : data.monthly.limit}
        </span>
      </div>

      {data.monthly.limit !== -1 && (
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-bg-muted">
          <div
            className={`h-full ${barColor} transition-all`}
            style={{ width: `${Math.min(percent, 100)}%` }}
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
      )}

      <div className="mt-3 flex items-center justify-between text-xs text-fg-muted">
        <span>{t('costThisMonth', { dollars: (data.cost.cents / 100).toFixed(2) })}</span>
        <span>{t('plan', { plan: data.plan })}</span>
      </div>

      {percent >= 80 && data.monthly.limit !== -1 && (
        <div className="mt-3 rounded bg-yellow-50 p-2 text-xs text-yellow-800">
          {t('warningHighUsage', { remaining: data.monthly.remaining })}
          {/* SaaS: 升级链接到 /pricing；on-prem: 没有升级概念，
              只显示 BYOK 选项（AI keys 在两种模式都可用）。 */}
          {CLIENT_CAPABILITIES.pricing && (
            <>
              <Link
                href={`/${locale}/pricing`}
                className="ml-2 font-medium text-primary hover:underline"
              >
                {t('upgrade')} →
              </Link>
              <span className="mx-1">{t('or')}</span>
            </>
          )}
          <Link
            href={`/${locale}/settings/ai-keys`}
            className="font-medium text-primary hover:underline"
          >
            {t('byok')} →
          </Link>
        </div>
      )}
    </div>
  );
}
