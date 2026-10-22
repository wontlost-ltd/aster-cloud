import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const { mockExecute } = vi.hoisted(() => ({ mockExecute: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ db: { execute: mockExecute } }));

import { todayPlatformCostCents } from '@/lib/ai-circuit-breaker';

describe('todayPlatformCostCents', () => {
  it('★按计费状态集合（success + api_error）汇总平台成本：到达 provider 后失败的调用同样产生成本', async () => {
    mockExecute.mockResolvedValue([{ cents: 123 }]);
    expect(await todayPlatformCostCents()).toBe(123);
    const q = new PgDialect().sqlToQuery(mockExecute.mock.calls[0][0] as SQL);
    expect(q.sql).toContain('status IN (');
    expect(q.sql).not.toContain("status = 'success'");
    expect(q.params).toEqual(expect.arrayContaining(['success', 'api_error']));
  });
});

/**
 * 熔断器统一状态来源 + 手动熔断（F18）。
 * 生产缺陷：熔断器页「当前状态」显示 "—"（页面期望的取值与 API 不一致），而管理员概览
 * 卡片显示「健康」；页面只能解除、不能手动熔断。
 */
describe('stateFromBanReasons / moreSevere', () => {
  it('按生效 ban 的原因推出最严重档位，并识别手动熔断', async () => {
    const { stateFromBanReasons } = await import('@/lib/ai-circuit-breaker');
    expect(stateFromBanReasons([])).toEqual({ state: 'closed', manual: false });
    expect(stateFromBanReasons(['全局成本熔断（free_stopped）'])).toEqual({
      state: 'free_stopped',
      manual: false,
    });
    expect(
      stateFromBanReasons(['全局成本熔断（free_stopped）', '全局成本熔断（free_trial_stopped，manual）']),
    ).toEqual({ state: 'free_trial_stopped', manual: true });
    // 非熔断原因（人工封禁）不计入熔断状态。
    expect(stateFromBanReasons(['滥用封禁', null])).toEqual({ state: 'closed', manual: false });
  });

  it('moreSevere 取更严重者', async () => {
    const { moreSevere } = await import('@/lib/ai-circuit-breaker');
    expect(moreSevere('closed', 'free_stopped')).toBe('free_stopped');
    expect(moreSevere('free_trial_stopped', 'free_stopped')).toBe('free_trial_stopped');
    expect(moreSevere('closed', 'closed')).toBe('closed');
  });
});

describe('tripCircuitManually / releaseCircuit', () => {
  it('手动熔断复用 ban 机制：停 Free + Trial，原因带 manual 标记且以熔断前缀开头', async () => {
    const { tripCircuitManually } = await import('@/lib/ai-circuit-breaker');
    mockExecute.mockReset();
    mockExecute.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
    expect(await tripCircuitManually()).toEqual({ affected: 2 });
    const q = new PgDialect().sqlToQuery(mockExecute.mock.calls[0][0] as SQL);
    expect(q.sql).toContain('UPDATE "User"');
    expect(q.params).toEqual(
      expect.arrayContaining(['free', 'trial', '全局成本熔断（free_trial_stopped，manual）']),
    );
  });

  it('解除按同一前缀清除，因此同时撤销自动与手动熔断', async () => {
    const { releaseCircuit } = await import('@/lib/ai-circuit-breaker');
    mockExecute.mockReset();
    mockExecute.mockResolvedValue([{ id: 'u1' }]);
    expect(await releaseCircuit()).toEqual({ released: 1 });
    const q = new PgDialect().sqlToQuery(mockExecute.mock.calls[0][0] as SQL);
    expect(q.params).toContain('全局成本熔断%');
  });
});

describe('getCircuitStatus', () => {
  it('★成本未超阈值但存在手动熔断 → 对外状态为已熔断（概览与熔断器页同源）', async () => {
    const { getCircuitStatus } = await import('@/lib/ai-circuit-breaker');
    mockExecute.mockReset();
    mockExecute.mockImplementation(async (query: SQL) => {
      const q = new PgDialect().sqlToQuery(query);
      return q.sql.includes('AiUsageRecord')
        ? [{ cents: 100 }]
        : [{ reason: '全局成本熔断（free_trial_stopped，manual）', users: 7 }];
    });
    expect(await getCircuitStatus()).toEqual({
      todayCents: 100,
      state: 'free_trial_stopped',
      costState: 'closed',
      banState: 'free_trial_stopped',
      manual: true,
      bannedUsers: 7,
    });
  });

  it('无生效 ban 且成本正常 → closed', async () => {
    const { getCircuitStatus } = await import('@/lib/ai-circuit-breaker');
    mockExecute.mockReset();
    mockExecute.mockImplementation(async (query: SQL) =>
      new PgDialect().sqlToQuery(query).sql.includes('AiUsageRecord') ? [{ cents: 0 }] : [],
    );
    const status = await getCircuitStatus();
    expect(status.state).toBe('closed');
    expect(status.bannedUsers).toBe(0);
  });
});
