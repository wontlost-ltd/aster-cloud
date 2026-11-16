'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { track, Events } from '@/lib/mixpanel';
import { CLIENT_CAPABILITIES } from '@/hooks/use-deployment-mode';
import type { UpgradeReason, RecommendedPlan } from '@/lib/plan-quota';

/**
 * 升级阻塞 modal — 用户尝试越过 plan 限额时弹出
 *
 * 文案来自 messages/{en,zh,de}.json 的 upgradeBlocker namespace。
 * 触发 Mixpanel UPGRADE_BLOCKED_AT_REVIEW，是 NSM 漏斗 Free→Pro 的最强转化信号。
 */
interface UpgradeBlockerProps {
  open: boolean;
  reason: UpgradeReason;
  locale: string;
  recommendedPlan?: RecommendedPlan;
  usage?: number;
  limit?: number;
  onClose: () => void;
}

export function UpgradeBlocker({
  open,
  reason,
  locale,
  recommendedPlan = 'pro',
  usage,
  limit,
  onClose,
}: UpgradeBlockerProps) {
  const t = useTranslations('upgradeBlocker');

  useEffect(() => {
    // Mixpanel UPGRADE_BLOCKED_AT_REVIEW 是 SaaS NSM 漏斗指标。on-prem
    // 没有"升级"概念，埋点也无意义；mixpanel.track 自身已经在 on-prem
    // no-op，这里多一道短路以防未来变化。
    if (open && CLIENT_CAPABILITIES.mixpanel) {
      track(Events.UPGRADE_BLOCKED_AT_REVIEW, {
        reason,
        recommended_plan: recommendedPlan,
        usage,
        limit,
      });
    }
  }, [open, reason, recommendedPlan, usage, limit]);

  // P2-R20: Esc dismisses modal (WCAG 2.1.1 keyboard parity with backdrop click)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  // On-prem 行为：仍可达到配额上限（license 决定上限），但 "升级到 Pro" 无意义。
  // CTA 改为 "联系管理员"。文案分支由 CTA 段决定；标题/正文仍复用 SaaS 文案
  // （配额超限的描述对两种模式都准确）。
  const isOnPrem = !CLIENT_CAPABILITIES.pricing;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-bg p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 text-lg font-semibold text-fg">
          {t(`${reason}.title`, { limit: limit ?? 0 })}
        </h2>
        <p className="mb-6 text-sm text-fg-muted">
          {t(`${reason}.body`, { limit: limit ?? 0 })}
        </p>
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border-strong px-4 py-2 text-sm font-medium text-fg hover:bg-bg-subtle"
          >
            {t('dismiss')}
          </button>
          {isOnPrem ? (
            <span className="rounded-md bg-bg-subtle px-4 py-2 text-sm font-medium text-fg-muted">
              {t('contactAdmin')}
            </span>
          ) : (
            <Link
              href={`/${locale}/pricing?ref=upgrade-blocker&reason=${reason}`}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-fg hover:bg-primary-hover"
            >
              {t('viewPlans')}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
