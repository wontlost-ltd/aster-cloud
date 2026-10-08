// Dunning（催收）逻辑工具：阶段判定 + 邮件模板选择
//
// 详见 aster-deploy/docs/pm/08-dunning.md
//
// 4 阶段：
//   Day 0  首次失败       → 友好提醒（由 webhook 直接发）
//   Day 3  第 1 次重试失败 → 警告 + 站内横幅
//   Day 7  第 2 次重试失败 → 显眼弹窗
//   Day 14 第 3 次重试失败 → "服务即将暂停"
//   Day 21 grace period 结束 → 由 auto-downgrade cron 处理（不在此模块）

export type DunningStage = 0 | 3 | 7 | 14;

export const GRACE_PERIOD_DAYS = 21;
export const DOWNGRADE_RECOVERY_DAYS = 30;

/**
 * 给定 grace period 起点 + 当前时间，决定**应该**已经发到哪一阶段邮件（含本日）。
 *
 * 返回 null 表示当前不应再发任何 dunning 邮件（已超过 Day 14 / 进入降级阶段）。
 */
export function pickDunningStage(
  gracePeriodStartsAt: Date | null,
  now: Date = new Date()
): DunningStage | null {
  if (!gracePeriodStartsAt) return null;
  const daysSince = Math.floor(
    (now.getTime() - gracePeriodStartsAt.getTime()) / (24 * 60 * 60 * 1000)
  );
  if (daysSince >= 14) return 14;
  if (daysSince >= 7) return 7;
  if (daysSince >= 3) return 3;
  if (daysSince >= 0) return 0;
  return null;
}

/**
 * 根据已发送计数决定是否需要发新一封：
 *   - sentCount === 0 → 应该发 Day 0
 *   - sentCount === 1 + Day ≥ 3 → 发 Day 3
 *   - sentCount === 2 + Day ≥ 7 → 发 Day 7
 *   - sentCount === 3 + Day ≥ 14 → 发 Day 14
 *   - sentCount === 4 → 已发完，等 auto-downgrade
 */
export function shouldSendStage(
  currentStage: DunningStage | null,
  sentCount: number
): DunningStage | null {
  if (currentStage === null) return null;
  if (sentCount >= 4) return null; // 已发完所有 4 封
  // sentCount 0..3 对应应发的第 (sentCount+1) 封
  // 但只有当前 stage ≥ 该封对应的 day 时才发
  const expectedNextStage: DunningStage =
    sentCount === 0 ? 0 : sentCount === 1 ? 3 : sentCount === 2 ? 7 : 14;
  if (currentStage >= expectedNextStage) {
    return expectedNextStage;
  }
  return null;
}

interface DunningEmailContent {
  subject: string;
  body: string;
}

export function buildDunningEmail(
  stage: DunningStage,
  userName: string,
  graceDaysLeft: number,
  amountDue: string,
  portalUrl: string
): DunningEmailContent {
  const greeting = `Hi ${userName},`;
  switch (stage) {
    case 0:
      return {
        subject: '[Aster] Payment failed — please update your payment method',
        body: `${greeting}\n\nWe couldn't process your latest invoice (${amountDue}). This is the first attempt — Stripe will retry over the next ~14 days.\n\nTo avoid service interruption, please update your payment method:\n${portalUrl}\n\nIf you've already fixed it, no action needed.\n\n— Aster Team`,
      };
    case 3:
      return {
        subject: '[Aster] Payment still failing — service interruption in ' + graceDaysLeft + ' days',
        body: `${greeting}\n\nOur 2nd attempt to charge ${amountDue} failed. You have ${graceDaysLeft} days before service is automatically downgraded to Free.\n\nUpdate payment method now:\n${portalUrl}\n\nNeed help? Reply to this email — we're happy to assist.\n\n— Aster Team`,
      };
    case 7:
      return {
        subject: '[Aster] URGENT: ' + graceDaysLeft + ' days until service interruption',
        body: `${greeting}\n\nOur 3rd attempt to charge ${amountDue} failed. Your account will be downgraded to Free in ${graceDaysLeft} days unless payment is resolved.\n\nWhen downgraded:\n• Personal API access will be disabled\n• AI features will be limited to Free quota\n• Your policies and data will be preserved (read-only) for 30 days\n\nResolve now: ${portalUrl}\n\n— Aster Team`,
      };
    case 14:
      return {
        subject: '[Aster] FINAL NOTICE: Service downgrade in 7 days',
        body: `${greeting}\n\nThis is the final reminder. Despite multiple retry attempts, ${amountDue} remains unpaid. Your account will be downgraded to Free on the day after tomorrow if payment is not resolved.\n\nWhat happens at downgrade:\n• Pro/Team features disabled immediately\n• Personal API keys deactivated\n• Data preserved read-only for 30 days\n• Unpaid amounts remain due (Stripe collections may apply)\n\nResolve immediately: ${portalUrl}\n\nIf you've decided to cancel, no action needed — downgrade happens automatically.\n\n— Aster Team`,
      };
  }
}

/**
 * 计算 grace period 还剩多少天（用于邮件文案 + dashboard 横幅）
 */
export function graceDaysLeft(gracePeriodEndsAt: Date | null, now: Date = new Date()): number {
  if (!gracePeriodEndsAt) return 0;
  const ms = gracePeriodEndsAt.getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}
