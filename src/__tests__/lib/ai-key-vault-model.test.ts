import { beforeEach, describe, expect, it, vi } from 'vitest';

// 捕获 db.execute 的 SQL 片段与 update().set() 参数，不连库。
const { executeMock, setMock, whereMock, returningMock, selectRows, limitMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  setMock: vi.fn(),
  whereMock: vi.fn(),
  returningMock: vi.fn(),
  selectRows: vi.fn(),
  limitMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => {
  const chain = { set: setMock, where: whereMock, returning: returningMock };
  setMock.mockReturnValue(chain);
  whereMock.mockReturnValue(chain);
  return {
    db: {
      execute: executeMock,
      update: vi.fn(() => chain),
      select: vi.fn(() => ({
        from: () => ({ where: () => ({ orderBy: selectRows, limit: limitMock }) }),
      })),
    },
    aiKeyBindings: {
      id: 'id', userId: 'userId', provider: 'provider', providerUrl: 'providerUrl', tokenQuota: 'tokenQuota',
      expiresAt: 'expiresAt', priority: 'priority', createdAt: 'createdAt', active: 'active', model: 'model',
      availableModels: 'availableModels', modelsCheckedAt: 'modelsCheckedAt', updatedAt: 'updatedAt',
    },
  };
});

import {
  saveBYOKKey,
  updateBYOKKeyMeta,
  updateBYOKAvailableModels,
  getBYOKCandidatesForInference,
  findBindingForUser,
} from '@/lib/ai-key-vault';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AI_KEY_ENCRYPTION_SECRET = 'unit-test-secret-at-least-16';
});

describe('ai-key-vault：model 列（ADR 0048）', () => {
  it('saveBYOKKey 把 model 写入 INSERT（未提供 → NULL）', async () => {
    executeMock.mockResolvedValue([]);
    await saveBYOKKey({ userId: 'u', provider: 'openai', apiKey: 'sk-'.padEnd(24, 'x'), model: 'gpt-4o' });
    const sqlText = JSON.stringify(executeMock.mock.calls[0][0]);
    expect(sqlText).toContain('\\"model\\"');
    expect(sqlText).toContain('gpt-4o');
    await saveBYOKKey({ userId: 'u', provider: 'openai', apiKey: 'sk-'.padEnd(24, 'x') });
    expect(JSON.stringify(executeMock.mock.calls[1][0])).toContain('\\"model\\"');
  });

  it('updateBYOKKeyMeta：model 未提供=不动；null=清空；字符串=写入', async () => {
    returningMock.mockResolvedValue([{ provider: 'openai', keyHint: 'xxxx' }]);
    await updateBYOKKeyMeta({ userId: 'u', bindingId: 'b', tokenQuota: 5 });
    expect(setMock.mock.calls[0][0]).not.toHaveProperty('model');
    await updateBYOKKeyMeta({ userId: 'u', bindingId: 'b', model: null });
    expect(setMock.mock.calls[1][0]).toMatchObject({ model: null });
    await updateBYOKKeyMeta({ userId: 'u', bindingId: 'b', model: 'gpt-4o' });
    expect(setMock.mock.calls[2][0]).toMatchObject({ model: 'gpt-4o' });
  });

  it('updateBYOKAvailableModels 写 availableModels + modelsCheckedAt，并再次收敛大小（形状过滤、≤200 条）', async () => {
    whereMock.mockResolvedValue(undefined);
    await updateBYOKAvailableModels('b', { models: ['a', 'b', 'x'.repeat(129), 'bad id'], defaultModel: 'a' });
    expect(setMock.mock.calls[0][0]).toMatchObject({ availableModels: { models: ['a', 'b'], defaultModel: 'a' } });
    expect(setMock.mock.calls[0][0].modelsCheckedAt).toBeInstanceOf(Date);
    const many = Array.from({ length: 250 }, (_, i) => `m-${i}`);
    await updateBYOKAvailableModels('b', { models: many, defaultModel: 'a' });
    expect(setMock.mock.calls[1][0].availableModels.models).toHaveLength(200);
  });

  it('getBYOKCandidatesForInference 返回 model（缺省 null）', async () => {
    selectRows.mockResolvedValue([
      { id: 'b', provider: 'openai', providerUrl: null, tokenQuota: null, expiresAt: null, model: 'gpt-4o' },
      { id: 'c', provider: 'anthropic', providerUrl: null, tokenQuota: null, expiresAt: null, model: null },
    ]);
    const rows = await getBYOKCandidatesForInference('u');
    expect(rows.map((r) => r.model)).toEqual(['gpt-4o', null]);
  });

  it('findBindingForUser：(id,userId) 匹配返回行；否则 null', async () => {
    limitMock.mockResolvedValueOnce([{ id: 'b', provider: 'openai', providerUrl: undefined }]);
    expect(await findBindingForUser('u', 'b')).toEqual({ id: 'b', provider: 'openai', providerUrl: null });
    limitMock.mockResolvedValueOnce([]);
    expect(await findBindingForUser('other', 'b')).toBeNull();
  });
});
