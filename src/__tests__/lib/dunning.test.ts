import { describe, it, expect } from 'vitest';
import {
  pickDunningStage,
  shouldSendStage,
  buildDunningEmail,
  graceDaysLeft,
  GRACE_PERIOD_DAYS,
  DOWNGRADE_RECOVERY_DAYS,
} from '@/lib/dunning';

const DAY = 24 * 60 * 60 * 1000;

describe('pickDunningStage', () => {
  it('null 起点 → null', () => {
    expect(pickDunningStage(null)).toBeNull();
  });

  it('Day 0 → 0', () => {
    const start = new Date('2026-05-01T00:00:00Z');
    const now = new Date('2026-05-01T12:00:00Z'); // 同日
    expect(pickDunningStage(start, now)).toBe(0);
  });

  it('Day 2.99 → 0（还没到 Day 3）', () => {
    const start = new Date('2026-05-01T00:00:00Z');
    const now = new Date(start.getTime() + 2.99 * DAY);
    expect(pickDunningStage(start, now)).toBe(0);
  });

  it('Day 3 → 3', () => {
    const start = new Date('2026-05-01T00:00:00Z');
    const now = new Date(start.getTime() + 3 * DAY);
    expect(pickDunningStage(start, now)).toBe(3);
  });

  it('Day 7 → 7', () => {
    const start = new Date('2026-05-01T00:00:00Z');
    const now = new Date(start.getTime() + 7.5 * DAY);
    expect(pickDunningStage(start, now)).toBe(7);
  });

  it('Day 14 → 14', () => {
    const start = new Date('2026-05-01T00:00:00Z');
    const now = new Date(start.getTime() + 14 * DAY);
    expect(pickDunningStage(start, now)).toBe(14);
  });

  it('Day 21（grace 已过期）→ 仍返回 14（不再升级）', () => {
    const start = new Date('2026-05-01T00:00:00Z');
    const now = new Date(start.getTime() + 21 * DAY);
    // pickDunningStage 只判定阶段，超过 14 也维持 14；降级由 auto-downgrade cron 处理
    expect(pickDunningStage(start, now)).toBe(14);
  });
});

describe('shouldSendStage（幂等控制）', () => {
  it('stage=null → null', () => {
    expect(shouldSendStage(null, 0)).toBeNull();
  });

  it('sentCount=0, stage=0 → 应发 Day 0', () => {
    expect(shouldSendStage(0, 0)).toBe(0);
  });

  it('sentCount=1, stage=0 → 不重发（已发过 Day 0）', () => {
    expect(shouldSendStage(0, 1)).toBeNull();
  });

  it('sentCount=1, stage=3 → 应发 Day 3', () => {
    expect(shouldSendStage(3, 1)).toBe(3);
  });

  it('sentCount=2, stage=3 → 不重发', () => {
    expect(shouldSendStage(3, 2)).toBeNull();
  });

  it('sentCount=2, stage=7 → 应发 Day 7', () => {
    expect(shouldSendStage(7, 2)).toBe(7);
  });

  it('sentCount=3, stage=14 → 应发 Day 14', () => {
    expect(shouldSendStage(14, 3)).toBe(14);
  });

  it('sentCount=4, stage=14 → 不再发（已发完所有 4 封）', () => {
    expect(shouldSendStage(14, 4)).toBeNull();
  });

  it('"用户跳过中间几天" — sentCount=0 + stage=14 → 仍只发 Day 0', () => {
    // cron 失联 14 天后才跑：先发 Day 0 把序列追上；隔天再发 Day 3 ...
    expect(shouldSendStage(14, 0)).toBe(0);
    expect(shouldSendStage(14, 1)).toBe(3);
    expect(shouldSendStage(14, 2)).toBe(7);
    expect(shouldSendStage(14, 3)).toBe(14);
  });
});

describe('buildDunningEmail', () => {
  const portal = 'https://aster-lang.cloud/billing';

  it('Day 0 友好提醒', () => {
    const e = buildDunningEmail(0, 'Alice', 21, '$20', portal);
    expect(e.subject).toContain('Payment failed');
    expect(e.body).toContain('Alice');
    expect(e.body).toContain('first attempt');
    expect(e.body).toContain(portal);
  });

  it('Day 3 提到剩余天数', () => {
    const e = buildDunningEmail(3, 'Bob', 18, '$20', portal);
    expect(e.body).toContain('18 days');
  });

  it('Day 7 含 URGENT 字样', () => {
    const e = buildDunningEmail(7, 'Carol', 14, '$20', portal);
    expect(e.subject).toContain('URGENT');
    expect(e.body).toContain('14 days');
    expect(e.body).toContain('read-only');
  });

  it('Day 14 是 FINAL NOTICE', () => {
    const e = buildDunningEmail(14, 'Dave', 7, '$20', portal);
    expect(e.subject).toContain('FINAL NOTICE');
    expect(e.body).toContain('Stripe collections');
  });

  // 降级只吊销个人 key，团队 key 随团队 owner 套餐（ADR 0015 §5），预告文案不能说成全部 API 访问
  it('Day 7 / Day 14 预告的是个人 API 访问 / 个人 key', () => {
    expect(buildDunningEmail(7, 'Erin', 14, '$20', portal).body).toContain('• Personal API access will be disabled');
    expect(buildDunningEmail(14, 'Erin', 7, '$20', portal).body).toContain('• Personal API keys deactivated');
  });

  it('文案不暴露内部规则 id 或工程术语', () => {
    const e = buildDunningEmail(7, 'X', 10, '$20', portal);
    expect(e.body).not.toContain('shouldSendStage');
    expect(e.body).not.toContain('regex');
  });
});

describe('graceDaysLeft', () => {
  it('null → 0', () => {
    expect(graceDaysLeft(null)).toBe(0);
  });

  it('已过期 → 0', () => {
    expect(graceDaysLeft(new Date('2020-01-01'), new Date())).toBe(0);
  });

  it('还有 5 天', () => {
    const now = new Date('2026-05-01T00:00:00Z');
    const future = new Date(now.getTime() + 5 * DAY);
    expect(graceDaysLeft(future, now)).toBe(5);
  });

  it('差几小时也算 1 天（向上取整）', () => {
    const now = new Date('2026-05-01T00:00:00Z');
    const future = new Date(now.getTime() + 0.5 * DAY);
    expect(graceDaysLeft(future, now)).toBe(1);
  });
});

describe('常量与 PM 文档对齐', () => {
  it('grace period 21 天', () => {
    expect(GRACE_PERIOD_DAYS).toBe(21);
  });

  it('数据恢复窗口 30 天', () => {
    expect(DOWNGRADE_RECOVERY_DAYS).toBe(30);
  });
});
