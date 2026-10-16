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
