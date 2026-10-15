import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * byok-envelope 单测：resolveByokEnvelope（**多 key 优先级 fallback** 选择层）
 * 与 injectByokEnvelope（剥离 caller _byok + 注入服务端 envelope）。
 *
 * 选择层契约（selection-time fallback，不做运行时重试）：候选按 priority asc 排序，顺次跳过
 * provider 不支持 / 已过期 / 已超本月额度，选第一个通过的，只解密它。
 */

const { mockCandidates, mockDecryptById, mockUsed } = vi.hoisted(() => ({
  mockCandidates: vi.fn(),
  mockDecryptById: vi.fn(),
  mockUsed: vi.fn(),
}));

vi.mock('@/lib/ai-key-vault', () => ({
  getBYOKCandidatesForInference: mockCandidates,
  getDecryptedBYOKKeyById: mockDecryptById,
}));
vi.mock('@/lib/ai-quota', () => ({ byokTokensUsedThisMonth: mockUsed }));

import { resolveByokEnvelope, injectByokEnvelope } from '@/lib/byok-envelope';

// 候选工厂：默认 openai、无 url、无 quota、不过期。传入的候选已按调用优先级排好序（模拟 vault 已排序）。
function cand(over: Partial<{
  id: string; provider: string; providerUrl: string | null; tokenQuota: number | null; expiresAt: Date | null; model: string | null;
}> = {}) {
  return {
    id: over.id ?? 'b1',
    provider: over.provider ?? 'openai',
    providerUrl: over.providerUrl ?? null,
    tokenQuota: over.tokenQuota ?? null,
    expiresAt: over.expiresAt ?? null,
    model: over.model ?? null,
  };
}

describe('resolveByokEnvelope（多 key 选择层）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsed.mockResolvedValue(0);
  });

  it('无 active 候选 → null（平台）', async () => {
    mockCandidates.mockResolvedValue([]);
    expect(await resolveByokEnvelope('u1')).toBeNull();
    expect(mockDecryptById).not.toHaveBeenCalled();
  });

  it('单个 openai 候选 + 解密成功 → envelope（退化=旧单 key 行为不变）', async () => {
    mockCandidates.mockResolvedValue([cand({ id: 'binding-1' })]);
    mockDecryptById.mockResolvedValue('sk-user');
    expect(await resolveByokEnvelope('u1')).toEqual({
      provider: 'openai', apiKey: 'sk-user', baseUrl: null, bindingId: 'binding-1', model: null,
    });
    expect(mockDecryptById).toHaveBeenCalledWith('u1', 'binding-1');
  });

  it('候选带 model → envelope.model 透传', async () => {
    mockCandidates.mockResolvedValue([cand({ id: 'b1', model: 'gpt-4o' })]);
    mockDecryptById.mockResolvedValue('sk-user');
    expect((await resolveByokEnvelope('u1'))?.model).toBe('gpt-4o');
  });

  it('★多 key：选 priority 最高（列表第一个可用）→ 只解密它', async () => {
    // 候选已按 priority 排序：b1 在前。
    mockCandidates.mockResolvedValue([cand({ id: 'b1' }), cand({ id: 'b2' })]);
    mockDecryptById.mockResolvedValue('sk-b1');
    const env = await resolveByokEnvelope('u1');
    expect(env?.bindingId).toBe('b1');
    // 只解密胜出的一个，不碰后面的
    expect(mockDecryptById).toHaveBeenCalledTimes(1);
    expect(mockDecryptById).toHaveBeenCalledWith('u1', 'b1');
  });

  it('★多 key：第一个已过期 → 跳过，选第二个', async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    mockCandidates.mockResolvedValue([
      cand({ id: 'b1', expiresAt: yesterday }),
      cand({ id: 'b2' }),
    ]);
    mockDecryptById.mockResolvedValue('sk-b2');
    const env = await resolveByokEnvelope('u1');
    expect(env?.bindingId).toBe('b2');
    expect(mockDecryptById).toHaveBeenCalledWith('u1', 'b2');
  });

  it('★多 key：第一个 provider 不支持（vertex）→ 跳过，选下一个 openai', async () => {
    mockCandidates.mockResolvedValue([
      cand({ id: 'b1', provider: 'vertex' }),
      cand({ id: 'b2', provider: 'openai' }),
    ]);
    mockDecryptById.mockResolvedValue('sk-b2');
    const env = await resolveByokEnvelope('u1');
    expect(env?.provider).toBe('openai');
    expect(env?.bindingId).toBe('b2');
  });

  it('★全部候选都不可用（全过期/全 vertex）→ null', async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    mockCandidates.mockResolvedValue([
      cand({ id: 'b1', expiresAt: yesterday }),
      cand({ id: 'b2', provider: 'vertex' }),
    ]);
    expect(await resolveByokEnvelope('u1')).toBeNull();
    expect(mockDecryptById).not.toHaveBeenCalled();
  });

  it('★超额跳过：第一个 quota 用满 → 跳过，选第二个（无 quota）', async () => {
    mockUsed.mockResolvedValue(1000);
    mockCandidates.mockResolvedValue([
      cand({ id: 'b1', tokenQuota: 500 }),   // 已用 1000 >= 500 → 跳过
      cand({ id: 'b2', tokenQuota: null }),  // 无限 → 选中
    ]);
    mockDecryptById.mockResolvedValue('sk-b2');
    const env = await resolveByokEnvelope('u1');
    expect(env?.bindingId).toBe('b2');
  });

  it('★超额边界：已用 == quota → 跳过（>= 判定）', async () => {
    mockUsed.mockResolvedValue(500);
    mockCandidates.mockResolvedValue([cand({ id: 'b1', tokenQuota: 500 })]);
    expect(await resolveByokEnvelope('u1')).toBeNull();
  });

  it('未超额：已用 < quota → 选中', async () => {
    mockUsed.mockResolvedValue(499);
    mockCandidates.mockResolvedValue([cand({ id: 'b1', tokenQuota: 500 })]);
    mockDecryptById.mockResolvedValue('sk-b1');
    expect((await resolveByokEnvelope('u1'))?.bindingId).toBe('b1');
  });

  it('无候选设 quota → 不查用量（省一次聚合查询）', async () => {
    mockCandidates.mockResolvedValue([cand({ id: 'b1', tokenQuota: null })]);
    mockDecryptById.mockResolvedValue('sk-b1');
    await resolveByokEnvelope('u1');
    expect(mockUsed).not.toHaveBeenCalled();
  });

  it('★providerUrl 非空 → envelope 带 baseUrl（供 aster-api 重校验）', async () => {
    mockCandidates.mockResolvedValue([cand({ id: 'b1', providerUrl: 'https://gw.example.com/v1' })]);
    mockDecryptById.mockResolvedValue('sk-user');
    expect((await resolveByokEnvelope('u1'))?.baseUrl).toBe('https://gw.example.com/v1');
  });

  it('★解密抛错 → 抛出（fail-closed 503，不静默回退平台偷烧预算）', async () => {
    mockCandidates.mockResolvedValue([cand({ id: 'b1' })]);
    mockDecryptById.mockRejectedValue(new Error('decrypt boom'));
    await expect(resolveByokEnvelope('u1')).rejects.toThrow('decrypt boom');
  });

  it('解密返回 null（行刚被删/停用竞态）→ 跳过看下一个', async () => {
    mockCandidates.mockResolvedValue([cand({ id: 'b1' }), cand({ id: 'b2' })]);
    mockDecryptById.mockResolvedValueOnce(null).mockResolvedValueOnce('sk-b2');
    const env = await resolveByokEnvelope('u1');
    expect(env?.bindingId).toBe('b2');
    expect(mockDecryptById).toHaveBeenCalledTimes(2);
  });

  it('解密全返回 null → null', async () => {
    mockCandidates.mockResolvedValue([cand({ id: 'b1' })]);
    mockDecryptById.mockResolvedValue(null);
    expect(await resolveByokEnvelope('u1')).toBeNull();
  });
});

describe('injectByokEnvelope', () => {
  it('envelope.model 非空 → 注入 _byok.model；为空 → 不带该字段（旧 api 兼容）', () => {
    const withModel = injectByokEnvelope('{"a":1}', { provider: 'openai', apiKey: 'k', baseUrl: null, bindingId: 'b', model: 'gpt-4o' });
    expect(JSON.parse(withModel.body)._byok).toEqual({ provider: 'openai', apiKey: 'k', model: 'gpt-4o' });
    const noModel = injectByokEnvelope('{"a":1}', { provider: 'openai', apiKey: 'k', baseUrl: null, bindingId: 'b', model: null });
    expect(JSON.parse(noModel.body)._byok).toEqual({ provider: 'openai', apiKey: 'k' });
  });

  it('注入服务端 envelope 到顶层 _byok（含 provider+apiKey，★bindingId 不转发；baseUrl 为空不注入）', () => {
    const out = injectByokEnvelope('{"goal":"x"}', { provider: 'openai', apiKey: 'sk', baseUrl: null, bindingId: 'b1', model: null });
    expect(out.injected).toBe(true);
    // bindingId 是 cloud 内部字段（用于 stamp lastUsedAt），绝不进转发 body；baseUrl 为空则不加字段
    expect(JSON.parse(out.body)).toEqual({ goal: 'x', _byok: { provider: 'openai', apiKey: 'sk' } });
  });

  // BYOK 自定义 Provider URL：baseUrl 非空 → 注入 _byok.baseUrl（aster-api 重新校验 allowlist+SSRF）。
  it('★baseUrl 非空 → 注入 _byok.baseUrl 供 aster-api 重校验', () => {
    const out = injectByokEnvelope('{"goal":"x"}', {
      provider: 'openai', apiKey: 'sk', baseUrl: 'https://gw.example.com/v1', bindingId: 'b1', model: null,
    });
    expect(out.injected).toBe(true);
    expect(JSON.parse(out.body)._byok).toEqual({
      provider: 'openai', apiKey: 'sk', baseUrl: 'https://gw.example.com/v1',
    });
  });

  it('★剥离 caller 提交的 _byok（防浏览器注入），无 envelope 时不重新注入，injected=false', () => {
    const out = injectByokEnvelope('{"goal":"x","_byok":{"provider":"evil","apiKey":"attacker"}}', null);
    expect(out.injected).toBe(false);
    expect(JSON.parse(out.body)).toEqual({ goal: 'x' });
  });

  it('★caller 带 _byok + 服务端有 envelope → 用服务端的覆盖 caller 的', () => {
    const out = injectByokEnvelope(
      '{"goal":"x","_byok":{"provider":"evil","apiKey":"attacker"}}',
      { provider: 'openai', apiKey: 'real', baseUrl: null, bindingId: 'b1', model: null }
    );
    expect(out.injected).toBe(true);
    expect(JSON.parse(out.body)._byok).toEqual({ provider: 'openai', apiKey: 'real' });
  });

  it('body 非 JSON → 原样返回、injected=false（避免"以为注入了"）', () => {
    const out = injectByokEnvelope('not-json', { provider: 'openai', apiKey: 'sk', baseUrl: null, bindingId: 'b1', model: null });
    expect(out).toEqual({ body: 'not-json', injected: false });
  });

  it('#185：注入 _usage.requestId（供 aster-api 回填真实 token）', () => {
    const out = injectByokEnvelope('{"goal":"x"}', null, 'req-123');
    const parsed = JSON.parse(out.body);
    expect(parsed._usage).toEqual({ requestId: 'req-123' });
  });

  it('#185：★剥离 caller 提交的 _usage（防浏览器伪造 requestId）', () => {
    const out = injectByokEnvelope(
      '{"goal":"x","_usage":{"requestId":"attacker-forged"}}',
      null,
      'server-req'
    );
    expect(JSON.parse(out.body)._usage).toEqual({ requestId: 'server-req' });
  });

  it('#185：无 requestId → 不注入 _usage（也剥离 caller 的）', () => {
    const out = injectByokEnvelope('{"goal":"x","_usage":{"requestId":"caller"}}', null);
    expect(JSON.parse(out.body)._usage).toBeUndefined();
  });

  it('#185：_byok + _usage 同时注入', () => {
    const out = injectByokEnvelope(
      '{"goal":"x"}',
      { provider: 'openai', apiKey: 'sk', baseUrl: null, bindingId: 'b1', model: null },
      'req-9'
    );
    const parsed = JSON.parse(out.body);
    expect(parsed._byok).toEqual({ provider: 'openai', apiKey: 'sk' });
    expect(parsed._usage).toEqual({ requestId: 'req-9' });
  });
});
