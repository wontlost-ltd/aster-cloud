// #649：内部失效端点需要知道 KV 是否真的删掉了（失败要返回非 200，迁移 Job 才看得到）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const env = vi.hoisted(() => ({ value: null as null | { CACHE?: { delete: (k: string) => Promise<void> } } }));
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: async () => {
    if (!env.value) throw new Error('not in workers');
    return { env: env.value };
  },
}));

import { invalidatePolicyCacheReporting } from '@/lib/cache';

describe('invalidatePolicyCacheReporting', () => {
  beforeEach(() => { env.value = null; });

  it('无 KV binding → kv_unavailable', async () => {
    await expect(invalidatePolicyCacheReporting('p1')).resolves.toBe('kv_unavailable');
  });

  it('删除策略的两条缓存键 → invalidated', async () => {
    const del = vi.fn(async (_key: string) => undefined);
    env.value = { CACHE: { delete: del } };
    await expect(invalidatePolicyCacheReporting('p1')).resolves.toBe('invalidated');
    expect(del.mock.calls.map((c) => c[0]).sort()).toEqual(['policy-content:p1', 'policy:v4:p1']);
  });

  it('KV 删除失败 → 抛出（不吞掉）', async () => {
    env.value = { CACHE: { delete: vi.fn(async () => { throw new Error('kv down'); }) } };
    await expect(invalidatePolicyCacheReporting('p1')).rejects.toThrow('kv down');
  });
});
