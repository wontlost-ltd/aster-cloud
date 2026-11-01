import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ record: vi.fn() }));

vi.mock('@/lib/product-events/server', () => ({ recordProductEventAfterResponse: h.record }));
vi.mock('@/lib/risk-tier', () => ({
  assessRegistrationRisk: vi.fn().mockResolvedValue({ tier: 0, reason: null }),
  policyForTier: () => ({ alertOnRegistration: false }),
}));

import { DrizzleAdapter } from '@/db/adapter';
import type { Database } from '@/db';

function fakeDb() {
  let insertedId = '';
  return {
    query: {
      auditLogs: { findMany: vi.fn().mockResolvedValue([]) },
      users: {
        findFirst: vi.fn().mockImplementation(async () => ({
          id: insertedId, email: 'new@corp.example', emailVerified: null, name: 'New', image: null,
        })),
      },
    },
    insert: () => ({
      values: async (row: { id: string }) => {
        insertedId = row.id;
      },
    }),
  } as unknown as Database;
}

describe('DrizzleAdapter.createUser → signup_completed', () => {
  it('建号成功后记一次注册事件，只传用户 id（不传邮箱 / 姓名）', async () => {
    const adapter = DrizzleAdapter(fakeDb());
    const user = await adapter.createUser!({
      id: 'ignored', email: 'new@corp.example', emailVerified: null, name: 'New', image: null,
    });
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record).toHaveBeenCalledWith('signup_completed', { userId: user.id, tenantId: user.id });
    expect(JSON.stringify(h.record.mock.calls)).not.toContain('new@corp.example');
  });
});
