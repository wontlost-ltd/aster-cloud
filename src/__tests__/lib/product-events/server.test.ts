import { beforeEach, describe, expect, it, vi } from 'vitest';

const inserted: Array<Record<string, unknown>> = [];
const conflictTargets: unknown[] = [];
let failNextInsert = false;
let conflictNext = false;

vi.mock('@/lib/prisma', () => {
  const productEvents = { dedupeKey: 'dedupeKey-col', id: 'id-col' };
  return {
    productEvents,
    db: {
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          const run = async () => {
            if (failNextInsert) {
              failNextInsert = false;
              throw new Error('db down');
            }
            if (conflictNext) {
              conflictNext = false;
              return [];
            }
            inserted.push(row);
            return [{ id: row.id }];
          };
          return {
            returning: run,
            onConflictDoNothing: (opts: { target: unknown }) => {
              conflictTargets.push(opts.target);
              return { returning: run };
            },
          };
        },
      }),
    },
  };
});

import { pseudonymize, recordProductEvent, resetOnceCacheForTests } from '@/lib/product-events/server';

beforeEach(() => {
  inserted.length = 0;
  conflictTargets.length = 0;
  failNextInsert = false;
  conflictNext = false;
  resetOnceCacheForTests();
  delete process.env.PRODUCT_ANALYTICS_SALT;
});

describe('pseudonymize', () => {
  it('稳定、不含原始 id、用户与租户命名空间分开', () => {
    const a = pseudonymize('user', 'user-123');
    expect(a).toBe(pseudonymize('user', 'user-123'));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toContain('user-123');
    expect(pseudonymize('tenant', 'user-123')).not.toBe(a);
  });

  it('密钥变化时假名随之变化', () => {
    const before = pseudonymize('user', 'u1');
    process.env.PRODUCT_ANALYTICS_SALT = 'rotated';
    expect(pseudonymize('user', 'u1')).not.toBe(before);
  });
});

describe('recordProductEvent', () => {
  it('写入假名化 actor / tenant 与过滤后的属性', async () => {
    const ok = await recordProductEvent('evidence_exported', {
      userId: 'user-1',
      tenantId: 'team-9',
      properties: { format: 'jsonl', scope: 'all', verifiableOnly: true, policySource: 'Module x.' },
    });
    expect(ok).toBe(true);
    expect(inserted).toHaveLength(1);
    const row = inserted[0];
    expect(row.name).toBe('evidence_exported');
    expect(row.actorId).toBe(pseudonymize('user', 'user-1'));
    expect(row.tenantId).toBe(pseudonymize('tenant', 'team-9'));
    expect(row.properties).toEqual({ format: 'jsonl', scope: 'all', verifiableOnly: true });
    expect(row.dedupeKey).toBeNull();
    expect(JSON.stringify(row)).not.toContain('user-1');
  });

  it('匿名事件允许没有 actor', async () => {
    await recordProductEvent('landing_viewed', { properties: { page: 'credit-decisions' } });
    expect(inserted[0]).toMatchObject({ actorId: null, tenantId: null, properties: { page: 'credit-decisions' } });
  });

  it('once 事件按 dedupeKey 冲突忽略，并在进程内缓存后不再打库', async () => {
    expect(await recordProductEvent('policy_first_saved', { userId: 'u-1' })).toBe(true);
    expect(inserted[0].dedupeKey).toBe(`policy_first_saved:${pseudonymize('user', 'u-1')}`);
    expect(conflictTargets).toEqual(['dedupeKey-col']);
    expect(await recordProductEvent('policy_first_saved', { userId: 'u-1' })).toBe(false);
    expect(inserted).toHaveLength(1);
    expect(conflictTargets).toHaveLength(1);
  });

  it('once 事件已被其他实例写过时返回 false', async () => {
    conflictNext = true;
    expect(await recordProductEvent('policy_first_executed', { userId: 'u-2', properties: { source: 'api' } })).toBe(false);
  });

  it('once 事件缺 actor 时不写', async () => {
    expect(await recordProductEvent('policy_first_executed', {})).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it('写库失败不抛错（埋点不能影响主流程）', async () => {
    failNextInsert = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(recordProductEvent('signup_completed', { userId: 'u-3' })).resolves.toBe(false);
    warn.mockRestore();
  });
});
