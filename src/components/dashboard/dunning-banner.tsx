'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CLIENT_CAPABILITIES } from '@/hooks/use-deployment-mode';

interface DunningStatus {
  subscriptionStatus: string | null;
  gracePeriodEndsAt: string | null;
  downgradedAt: string | null;
}

/**
 * Dunning 横幅：当 subscriptionStatus=past_due 时在 dashboard 顶部显示红色警告
 *
 * 行为分级：
 *   - past_due 且 daysLeft > 7  → 红色横幅，可继续浏览
 *   - past_due 且 daysLeft ≤ 7  → 红色横幅 + "URGENT" 标签
 *   - past_due 且 daysLeft ≤ 0  → modal（应该已被 cron 降级，但 cron 还没跑时兜底）
 *   - canceled + downgradedAt   → 显示 30 天恢复窗口提示
 *   - 其他                       → 不显示
 */
export function DunningBanner() {
  const t = useTranslations('dashboard.dunning');
  const [data, setData] = useState<DunningStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    // On-prem 没有 Stripe dunning 状态；/api/user/dunning-status 返回 404。
    // 直接跳过 fetch 避免噪音日志。CLIENT_CAPABILITIES 是 build-time 字面量，
    // 这里的条件分支会被 terser 折叠掉（on-prem 全 effect 是 setLoading(false)）。
    if (!CLIENT_CAPABILITIES.dunning) {
      // on-prem 无 dunning：挂载时一次性解除 loading 后 return，非渲染循环，属合法的初始加载态收敛。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      return;
    }
    fetch('/api/user/dunning-status')
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  // on-prem 路径：CLIENT_CAPABILITIES.dunning = false → data 永远是 null。
  if (loading || !data) return null;

  const openPortal = async () => {
    setOpening(true);
    try {
      const r = await fetch('/api/stripe/portal', { method: 'POST' });
      if (r.ok) {
        const { url } = await r.json();
        window.location.href = url;
      }
    } finally {
      setOpening(false);
    }
  };

  // 已降级到 Free，显示 30 天恢复窗口
  if (data.subscriptionStatus === 'canceled' && data.downgradedAt) {
    const downgradedAt = new Date(data.downgradedAt);
    const recoveryDeadline = new Date(downgradedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    const daysToRecover = Math.max(
      0,
      Math.ceil((recoveryDeadline.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    );
    if (daysToRecover === 0) return null; // 30 天窗口也过了，不再提示

    return (
      <div className="border-b border-orange-200 bg-orange-50 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="text-sm text-orange-900">
            <strong>{t('downgradedTitle')}</strong>{' '}
            {t('downgradedHint', { days: daysToRecover })}
          </div>
          <button
            onClick={openPortal}
            disabled={opening}
            className="rounded bg-orange-700 px-3 py-1 text-xs font-medium text-white hover:bg-orange-800 disabled:opacity-50"
          >
            {t('reactivate')}
          </button>
        </div>
      </div>
    );
  }

  // past_due
  if (data.subscriptionStatus !== 'past_due' || !data.gracePeriodEndsAt) return null;

  const endsAt = new Date(data.gracePeriodEndsAt);
  const daysLeft = Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
  const urgent = daysLeft <= 7;

  return (
    <div
      className={`border-b px-4 py-3 ${
        urgent ? 'border-red-300 bg-red-100' : 'border-yellow-200 bg-yellow-50'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className={`text-sm ${urgent ? 'text-red-900' : 'text-yellow-900'}`}>
          {urgent && (
            <span className="mr-2 inline-block rounded bg-red-600 px-2 py-0.5 text-xs font-bold text-white">
              URGENT
            </span>
          )}
          <strong>{t('paymentFailedTitle')}</strong>{' '}
          {t('paymentFailedHint', { days: daysLeft })}
        </div>
        <button
          onClick={openPortal}
          disabled={opening}
          className={`rounded px-3 py-1 text-xs font-medium text-white disabled:opacity-50 ${
            urgent ? 'bg-red-600 hover:bg-red-700' : 'bg-yellow-600 hover:bg-yellow-700'
          }`}
        >
          {opening ? t('opening') : t('updatePayment')}
        </button>
      </div>
    </div>
  );
}
