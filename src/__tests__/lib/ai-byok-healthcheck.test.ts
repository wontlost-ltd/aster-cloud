import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findMany, updateSet, fetchModels, updateAvail } = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateSet: vi.fn(),
  fetchModels: vi.fn(),
  updateAvail: vi.fn(),
}));

vi.mock('@/lib/prisma', () => {
  const chain = { set: updateSet, where: vi.fn().mockResolvedValue(undefined) };
  updateSet.mockReturnValue(chain);
  return {
    db: { query: { aiKeyBindings: { findMany }, users: { findFirst: vi.fn() } }, update: vi.fn(() => chain) },
    aiKeyBindings: { id: 'id', active: 'active' },
    users: { id: 'id' },
  };
});
vi.mock('@/lib/ai-key-vault', () => ({
  getDecryptedBYOKKeyById: vi.fn().mockResolvedValue('sk-'.padEnd(24, 'x')),
  updateBYOKAvailableModels: updateAvail,
}));
vi.mock('@/lib/byok-models', () => ({ fetchByokModels: fetchModels }));

import { checkAllBYOKKeys } from '@/lib/ai-byok-healthcheck';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
});

describe('BYOK healthcheck：刷新 availableModels（ADR 0048）', () => {
  it('健康 ping 后查询模型列表并写入', async () => {
    findMany.mockResolvedValue([{ id: 'b1', userId: 'u', provider: 'openai', providerUrl: null, lastErrorAt: null }]);
    fetchModels.mockResolvedValue({ ok: true, models: ['gpt-4o'], defaultModel: 'gpt-4o-mini' });
    const res = await checkAllBYOKKeys(vi.fn());
    expect(res[0].status).toBe('healthy');
    expect(fetchModels).toHaveBeenCalledWith('u', { provider: 'openai', apiKey: expect.any(String), baseUrl: null }, { timeoutMs: 5000 });
    expect(updateAvail).toHaveBeenCalledWith('b1', { models: ['gpt-4o'], defaultModel: 'gpt-4o-mini' });
  });

  it('24h 内查过的 binding 不再查询', async () => {
    findMany.mockResolvedValue([{ id: 'b1', userId: 'u', provider: 'openai', providerUrl: null, lastErrorAt: null, modelsCheckedAt: new Date(Date.now() - 60_000) }]);
    await checkAllBYOKKeys(vi.fn());
    expect(fetchModels).not.toHaveBeenCalled();
  });

  it('★每轮最多刷新 50 条（预算上界）', async () => {
    findMany.mockResolvedValue(Array.from({ length: 60 }, (_, i) => ({ id: `b${i}`, userId: 'u', provider: 'openai', providerUrl: null, lastErrorAt: null, modelsCheckedAt: null })));
    fetchModels.mockResolvedValue({ ok: true, models: ['m'], defaultModel: 'm' });
    await checkAllBYOKKeys(vi.fn());
    expect(fetchModels).toHaveBeenCalledTimes(50);
  });

  it('★列表查询失败 → 不写 availableModels，binding 仍 healthy', async () => {
    findMany.mockResolvedValue([{ id: 'b1', userId: 'u', provider: 'openai', providerUrl: null, lastErrorAt: null }]);
    fetchModels.mockResolvedValue({ ok: false, error: 'models_unavailable' });
    const res = await checkAllBYOKKeys(vi.fn());
    expect(res[0].status).toBe('healthy');
    expect(updateAvail).not.toHaveBeenCalled();
  });

  it('★availableModels 写入失败 → 不抛出，binding 仍 healthy', async () => {
    findMany.mockResolvedValue([{ id: 'b1', userId: 'u', provider: 'openai', providerUrl: null, lastErrorAt: null }]);
    fetchModels.mockResolvedValue({ ok: true, models: ['gpt-4o'], defaultModel: 'gpt-4o-mini' });
    updateAvail.mockRejectedValueOnce(new Error('db down'));
    const res = await checkAllBYOKKeys(vi.fn());
    expect(res[0].status).toBe('healthy');
  });

  it('vertex 不查询列表', async () => {
    findMany.mockResolvedValue([{ id: 'b1', userId: 'u', provider: 'vertex', providerUrl: null, lastErrorAt: null }]);
    await checkAllBYOKKeys(vi.fn());
    expect(fetchModels).not.toHaveBeenCalled();
  });
});
