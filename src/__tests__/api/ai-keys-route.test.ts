// BYOK 管理接口（PATCH 编辑额度/失效日期 + 重置额度 + 重排优先级；DELETE 按 id 撤销；
// POST 多 key 新增）授权与审计测试。
//
// 关注最敏感的安全路径：
//   - PATCH 编辑按 (id, userId) 双校验：越权/不存在统一 404，不泄露存在性。
//   - resetQuota 只改本人水位线，且**不删** aiUsageRecords（审计记录不可变）。
//   - reorder 校验 orderedIds（非空/唯一/字符串），只改本人，审计记 id 顺序。
//   - DELETE 按 id（多 key）；审计 deleted 区分真删/空删。
//   - 审计 metadata **绝不**含明文 key（apiKey / encryptedKey）。

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/ai-key-vault', () => ({
  saveBYOKKey: vi.fn(),
  deleteBYOKKey: vi.fn(),
  updateBYOKKeyMeta: vi.fn(),
  reorderBYOKKeys: vi.fn(),
  updateBYOKAvailableModels: vi.fn(),
  getDecryptedBYOKKeyById: vi.fn(),
  findBindingForUser: vi.fn(),
}));
vi.mock('@/lib/byok-models', () => ({
  fetchByokModels: vi.fn(),
  MODEL_ID_RE: /^[A-Za-z0-9._:/-]{1,128}$/,
}));
vi.mock('@/lib/ai-quota', () => ({
  byokTokensUsedThisMonth: vi.fn().mockResolvedValue(0),
  resetByokQuotaUsage: vi.fn(),
}));
vi.mock('@/lib/audit-log', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
  extractClientInfo: vi.fn().mockReturnValue({ ipAddress: '1.2.3.4', userAgent: 'test' }),
}));

import { PATCH, DELETE, POST } from '@/app/api/user/ai-keys/route';
import { auth } from '@/auth';
import {
  saveBYOKKey, deleteBYOKKey, updateBYOKKeyMeta, reorderBYOKKeys,
  updateBYOKAvailableModels, getDecryptedBYOKKeyById, findBindingForUser,
} from '@/lib/ai-key-vault';
import { fetchByokModels } from '@/lib/byok-models';
import { resetByokQuotaUsage } from '@/lib/ai-quota';
import { logAuditEvent } from '@/lib/audit-log';

function patchReq(body: unknown) {
  return new Request('http://localhost/api/user/ai-keys', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof PATCH>[0];
}
function deleteReq(id: string | null) {
  const url = id
    ? `http://localhost/api/user/ai-keys?id=${encodeURIComponent(id)}`
    : 'http://localhost/api/user/ai-keys';
  return new Request(url, { method: 'DELETE' }) as unknown as Parameters<typeof DELETE>[0];
}
function postReq(body: unknown) {
  return new Request('http://localhost/api/user/ai-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: 'user-1' } } as never);
  // 默认：provider 列表查询失败（放行），各用例按需覆盖
  vi.mocked(fetchByokModels).mockResolvedValue({ ok: false, error: 'models_unavailable' });
});

describe('PATCH /api/user/ai-keys — 编辑额度/失效日期', () => {
  it('未登录 → 401', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const r = await PATCH(patchReq({ id: 'b1', tokenQuota: 100 }));
    expect(r.status).toBe(401);
  });

  it('缺 id（非 reset）→ 400', async () => {
    const r = await PATCH(patchReq({ tokenQuota: 100 }));
    expect(r.status).toBe(400);
    expect(updateBYOKKeyMeta).not.toHaveBeenCalled();
  });

  it('tokenQuota 非正整数 → 400', async () => {
    const r = await PATCH(patchReq({ id: 'b1', tokenQuota: -5 }));
    expect(r.status).toBe(400);
    expect(updateBYOKKeyMeta).not.toHaveBeenCalled();
  });

  it('expiresAt 过去时间 → 400', async () => {
    const r = await PATCH(patchReq({ id: 'b1', expiresAt: '2000-01-01T00:00:00Z' }));
    expect(r.status).toBe(400);
  });

  it('既没 quota 也没 expiry → 400（无可改）', async () => {
    const r = await PATCH(patchReq({ id: 'b1' }));
    expect(r.status).toBe(400);
  });

  it('越权/不存在（vault 返回 null）→ 404，不泄露存在性', async () => {
    vi.mocked(updateBYOKKeyMeta).mockResolvedValue(null);
    const r = await PATCH(patchReq({ id: 'someone-elses', tokenQuota: 100 }));
    expect(r.status).toBe(404);
    // vault 用 (id, userId) 双条件——路由把当前 session userId 传入
    expect(updateBYOKKeyMeta).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', bindingId: 'someone-elses' }),
    );
  });

  it('成功改额度 → 200 + 审计 ai-key.update，metadata 不含明文 key', async () => {
    vi.mocked(updateBYOKKeyMeta).mockResolvedValue({ provider: 'openai', keyHint: '1234' });
    const r = await PATCH(patchReq({ id: 'b1', tokenQuota: 500000 }));
    expect(r.status).toBe(200);

    expect(logAuditEvent).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(logAuditEvent).mock.calls[0][0];
    expect(entry.action).toBe('ai-key.update');
    expect(entry.userId).toBe('user-1');
    const metaStr = JSON.stringify(entry.metadata);
    expect(metaStr).not.toMatch(/apiKey|encryptedKey|sk-/i);
    expect(entry.metadata).toMatchObject({ tokenQuota: 500000, keyHint: '1234' });
  });

  it('tokenQuota:null 清空（改无限）→ 透传 null 给 vault', async () => {
    vi.mocked(updateBYOKKeyMeta).mockResolvedValue({ provider: 'openai', keyHint: '1234' });
    await PATCH(patchReq({ id: 'b1', tokenQuota: null }));
    expect(updateBYOKKeyMeta).toHaveBeenCalledWith(
      expect.objectContaining({ tokenQuota: null }),
    );
  });

  it('update 携带 model → 解密该 key 经列表校验后写入，审计 metadata 含 model', async () => {
    vi.mocked(findBindingForUser).mockResolvedValue({ id: 'b1', provider: 'openai', providerUrl: null });
    vi.mocked(getDecryptedBYOKKeyById).mockResolvedValue('sk-'.padEnd(24, 'x'));
    vi.mocked(fetchByokModels).mockResolvedValue({ ok: true, models: ['gpt-4o'], defaultModel: 'gpt-4o-mini' });
    vi.mocked(updateBYOKKeyMeta).mockResolvedValue({ provider: 'openai', keyHint: 'xxxx' });
    const r = await PATCH(patchReq({ id: 'b1', action: 'update', model: 'gpt-4o' }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, modelsChecked: true });
    expect(getDecryptedBYOKKeyById).toHaveBeenCalledWith('user-1', 'b1');
    expect(vi.mocked(updateBYOKKeyMeta).mock.calls[0][0]).toMatchObject({ model: 'gpt-4o' });
    expect(updateBYOKAvailableModels).toHaveBeenCalledWith('b1', { models: ['gpt-4o'], defaultModel: 'gpt-4o-mini' });
    expect(vi.mocked(logAuditEvent).mock.calls[0][0].metadata).toMatchObject({ model: 'gpt-4o' });
  });

  it('★update model 不在列表 → 400 model_not_available，不写入', async () => {
    vi.mocked(findBindingForUser).mockResolvedValue({ id: 'b1', provider: 'openai', providerUrl: null });
    vi.mocked(getDecryptedBYOKKeyById).mockResolvedValue('sk-'.padEnd(24, 'x'));
    vi.mocked(fetchByokModels).mockResolvedValue({ ok: true, models: ['gpt-4o-mini'], defaultModel: 'gpt-4o-mini' });
    const r = await PATCH(patchReq({ id: 'b1', action: 'update', model: 'gpt-9' }));
    expect(r.status).toBe(400);
    expect(updateBYOKKeyMeta).not.toHaveBeenCalled();
  });

  it('update model：列表查询失败 → 仍写入，modelsChecked=false', async () => {
    vi.mocked(findBindingForUser).mockResolvedValue({ id: 'b1', provider: 'openai', providerUrl: null });
    vi.mocked(getDecryptedBYOKKeyById).mockResolvedValue('sk-'.padEnd(24, 'x'));
    vi.mocked(fetchByokModels).mockResolvedValue({ ok: false, error: 'models_unavailable' });
    vi.mocked(updateBYOKKeyMeta).mockResolvedValue({ provider: 'openai', keyHint: 'xxxx' });
    const r = await PATCH(patchReq({ id: 'b1', action: 'update', model: 'gpt-4o' }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, modelsChecked: false });
  });

  it('★update model：availableModels 缓存写入失败 → 仍 200，modelsChecked=true', async () => {
    vi.mocked(findBindingForUser).mockResolvedValue({ id: 'b1', provider: 'openai', providerUrl: null });
    vi.mocked(getDecryptedBYOKKeyById).mockResolvedValue('sk-'.padEnd(24, 'x'));
    vi.mocked(fetchByokModels).mockResolvedValue({ ok: true, models: ['gpt-4o'], defaultModel: 'gpt-4o-mini' });
    vi.mocked(updateBYOKAvailableModels).mockRejectedValueOnce(new Error('db down'));
    vi.mocked(updateBYOKKeyMeta).mockResolvedValue({ provider: 'openai', keyHint: 'xxxx' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await PATCH(patchReq({ id: 'b1', action: 'update', model: 'gpt-4o' }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, modelsChecked: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('update：binding 不属于本人 → 404，不解密', async () => {
    vi.mocked(findBindingForUser).mockResolvedValue(null);
    const r = await PATCH(patchReq({ id: 'b-other', action: 'update', model: 'gpt-4o' }));
    expect(r.status).toBe(404);
    expect(getDecryptedBYOKKeyById).not.toHaveBeenCalled();
  });

  it('update model=null → 清空（回到平台默认）', async () => {
    vi.mocked(updateBYOKKeyMeta).mockResolvedValue({ provider: 'openai', keyHint: 'xxxx' });
    const r = await PATCH(patchReq({ id: 'b1', action: 'update', model: null }));
    expect(r.status).toBe(200);
    expect(vi.mocked(updateBYOKKeyMeta).mock.calls[0][0]).toMatchObject({ model: null });
  });

  it('update model 形状非法 → 400', async () => {
    const r = await PATCH(patchReq({ id: 'b1', action: 'update', model: 'x y' }));
    expect(r.status).toBe(400);
    expect(updateBYOKKeyMeta).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/user/ai-keys — 重置额度', () => {
  it('action=resetQuota → 调 resetByokQuotaUsage（本人）+ 审计 reset-quota，不碰 vault delete', async () => {
    const stamped = new Date('2026-07-16T00:00:00Z');
    vi.mocked(resetByokQuotaUsage).mockResolvedValue(stamped);

    const r = await PATCH(patchReq({ action: 'resetQuota' }));
    expect(r.status).toBe(200);
    // 只针对本人 userId
    expect(resetByokQuotaUsage).toHaveBeenCalledWith('user-1');
    // 重置绝不删除 key
    expect(deleteBYOKKey).not.toHaveBeenCalled();
    // 审计动作准确
    const entry = vi.mocked(logAuditEvent).mock.calls[0][0];
    expect(entry.action).toBe('ai-key.reset-quota');
    expect(entry.userId).toBe('user-1');
  });
});

describe('PATCH /api/user/ai-keys — 重排优先级（限定 provider 组）', () => {
  it('action=reorder + provider + 合法 orderedIds（全改到）→ 调 reorderBYOKKeys + 审计', async () => {
    vi.mocked(reorderBYOKKeys).mockResolvedValue(2); // 改到 2 行 == orderedIds.length
    const r = await PATCH(patchReq({ action: 'reorder', provider: 'openai', orderedIds: ['b2', 'b1'] }));
    expect(r.status).toBe(200);
    expect(reorderBYOKKeys).toHaveBeenCalledWith('user-1', 'openai', ['b2', 'b1']);
    const entry = vi.mocked(logAuditEvent).mock.calls[0][0];
    expect(entry.action).toBe('ai-key.reorder');
    expect(entry.metadata).toMatchObject({ provider: 'openai', orderedIds: ['b2', 'b1'] });
  });

  it('★改到的行数 != orderedIds.length（含越权/跨 provider id）→ 404，不写成功审计', async () => {
    vi.mocked(reorderBYOKKeys).mockResolvedValue(1); // 只改到 1 行，但传了 2 个 id
    const r = await PATCH(patchReq({ action: 'reorder', provider: 'openai', orderedIds: ['mine', 'foreign'] }));
    expect(r.status).toBe(404);
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('缺 provider → 400（不调 vault）', async () => {
    const r = await PATCH(patchReq({ action: 'reorder', orderedIds: ['b1', 'b2'] }));
    expect(r.status).toBe(400);
    expect(reorderBYOKKeys).not.toHaveBeenCalled();
  });

  it('orderedIds 为空数组 → 400（不调 vault）', async () => {
    const r = await PATCH(patchReq({ action: 'reorder', provider: 'openai', orderedIds: [] }));
    expect(r.status).toBe(400);
    expect(reorderBYOKKeys).not.toHaveBeenCalled();
  });

  it('orderedIds 有重复 id → 400（防 CASE 歧义）', async () => {
    const r = await PATCH(patchReq({ action: 'reorder', provider: 'openai', orderedIds: ['b1', 'b1'] }));
    expect(r.status).toBe(400);
    expect(reorderBYOKKeys).not.toHaveBeenCalled();
  });

  it('orderedIds 含非字符串 → 400', async () => {
    const r = await PATCH(patchReq({ action: 'reorder', provider: 'openai', orderedIds: ['b1', 123] }));
    expect(r.status).toBe(400);
    expect(reorderBYOKKeys).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/user/ai-keys — 按 id 撤销', () => {
  it('缺 id → 400', async () => {
    const r = await DELETE(deleteReq(null));
    expect(r.status).toBe(400);
  });

  it('删到行 → 审计 deleted=true + provider + keyHint', async () => {
    vi.mocked(deleteBYOKKey).mockResolvedValue({ deleted: true, provider: 'openai', keyHint: '9999' });
    const r = await DELETE(deleteReq('b1'));
    expect(r.status).toBe(200);
    // 按 (id, userId) 删
    expect(deleteBYOKKey).toHaveBeenCalledWith('user-1', 'b1');
    const entry = vi.mocked(logAuditEvent).mock.calls[0][0];
    expect(entry.action).toBe('ai-key.delete');
    expect(entry.metadata).toMatchObject({ bindingId: 'b1', provider: 'openai', deleted: true, keyHint: '9999' });
  });

  it('无匹配行（越权别人 id / 已删）→ 审计 deleted=false', async () => {
    vi.mocked(deleteBYOKKey).mockResolvedValue({ deleted: false, provider: null, keyHint: null });
    await DELETE(deleteReq('someone-elses'));
    const entry = vi.mocked(logAuditEvent).mock.calls[0][0];
    expect(entry.metadata).toMatchObject({ deleted: false });
  });
});

describe('POST /api/user/ai-keys — 多 key 新增', () => {
  const goodKey = 'sk-'.padEnd(24, 'x');

  it('新增 → ai-key.create + 返回 id，审计不含明文 key', async () => {
    vi.mocked(saveBYOKKey).mockResolvedValue({ id: 'new-binding-1' });
    const r = await POST(postReq({ provider: 'openai', apiKey: goodKey }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, id: 'new-binding-1' });
    const entry = vi.mocked(logAuditEvent).mock.calls[0][0];
    expect(entry.action).toBe('ai-key.create');
    expect(entry.metadata).toMatchObject({ bindingId: 'new-binding-1', provider: 'openai' });
    // 绝不记明文 key
    expect(JSON.stringify(entry.metadata)).not.toContain(goodKey);
  });

  it('同 provider 再加一个 → 仍是 create（多 key，不再 replace）', async () => {
    vi.mocked(saveBYOKKey).mockResolvedValue({ id: 'new-binding-2' });
    const r = await POST(postReq({ provider: 'openai', apiKey: goodKey }));
    expect(r.status).toBe(200);
    const entry = vi.mocked(logAuditEvent).mock.calls[0][0];
    expect(entry.action).toBe('ai-key.create');
  });

  it('model 指定且在列表中 → 保存并写 availableModels，返回 modelsChecked=true', async () => {
    vi.mocked(fetchByokModels).mockResolvedValue({ ok: true, models: ['gpt-4o', 'gpt-4o-mini'], defaultModel: 'gpt-4o-mini' });
    vi.mocked(saveBYOKKey).mockResolvedValue({ id: 'new-1' });
    const r = await POST(postReq({ provider: 'openai', apiKey: goodKey, model: 'gpt-4o' }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, id: 'new-1', modelsChecked: true });
    expect(vi.mocked(saveBYOKKey).mock.calls[0][0]).toMatchObject({ model: 'gpt-4o' });
    expect(updateBYOKAvailableModels).toHaveBeenCalledWith('new-1', { models: ['gpt-4o', 'gpt-4o-mini'], defaultModel: 'gpt-4o-mini' });
    expect(vi.mocked(logAuditEvent).mock.calls[0][0].metadata).toMatchObject({ model: 'gpt-4o' });
  });

  it('★model 不在列表 → 400 model_not_available，附可用列表，不保存', async () => {
    vi.mocked(fetchByokModels).mockResolvedValue({ ok: true, models: ['gpt-4o-mini'], defaultModel: 'gpt-4o-mini' });
    const r = await POST(postReq({ provider: 'openai', apiKey: goodKey, model: 'gpt-9' }));
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: 'model_not_available', available: ['gpt-4o-mini'] });
    expect(saveBYOKKey).not.toHaveBeenCalled();
  });

  it('★availableModels 缓存写入失败 → 仍 200 { ok, id, modelsChecked:true }', async () => {
    vi.mocked(fetchByokModels).mockResolvedValue({ ok: true, models: ['gpt-4o'], defaultModel: 'gpt-4o-mini' });
    vi.mocked(saveBYOKKey).mockResolvedValue({ id: 'new-w' });
    vi.mocked(updateBYOKAvailableModels).mockRejectedValueOnce(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await POST(postReq({ provider: 'openai', apiKey: goodKey, model: 'gpt-4o' }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, id: 'new-w', modelsChecked: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('★列表查询失败 → 仍保存，modelsChecked=false，不写 availableModels', async () => {
    vi.mocked(fetchByokModels).mockResolvedValue({ ok: false, error: 'models_unavailable' });
    vi.mocked(saveBYOKKey).mockResolvedValue({ id: 'new-2' });
    const r = await POST(postReq({ provider: 'openai', apiKey: goodKey, model: 'gpt-4o' }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, modelsChecked: false });
    expect(updateBYOKAvailableModels).not.toHaveBeenCalled();
  });

  it('网关不支持列表（models=null）→ 保存，不校验 model', async () => {
    vi.mocked(fetchByokModels).mockResolvedValue({ ok: true, models: null, defaultModel: 'x' });
    vi.mocked(saveBYOKKey).mockResolvedValue({ id: 'new-3' });
    const r = await POST(postReq({ provider: 'openai', apiKey: goodKey, model: 'gw-alias' }));
    expect(r.status).toBe(200);
    expect(updateBYOKAvailableModels).toHaveBeenCalledWith('new-3', { models: null, defaultModel: 'x' });
  });

  it('model 形状非法 → 400，不调 aster-api', async () => {
    const r = await POST(postReq({ provider: 'openai', apiKey: goodKey, model: 'bad model!' }));
    expect(r.status).toBe(400);
    expect(fetchByokModels).not.toHaveBeenCalled();
  });

  it('★model 纯空白 → 视为未指定（null），与 aster-api normalizeModel 一致', async () => {
    vi.mocked(fetchByokModels).mockResolvedValue({ ok: true, models: ['gpt-4o-mini'], defaultModel: 'gpt-4o-mini' });
    vi.mocked(saveBYOKKey).mockResolvedValue({ id: 'new-5' });
    const r = await POST(postReq({ provider: 'openai', apiKey: goodKey, model: '   ' }));
    expect(r.status).toBe(200);
    expect(vi.mocked(saveBYOKKey).mock.calls[0][0]).toMatchObject({ model: null });
  });

  it('vertex 不查询列表（Phase 2 不支持 BYOK 推理），model 原样入库', async () => {
    vi.mocked(saveBYOKKey).mockResolvedValue({ id: 'new-4' });
    const r = await POST(postReq({ provider: 'vertex', apiKey: goodKey, model: 'gemini-x' }));
    expect(r.status).toBe(200);
    expect(fetchByokModels).not.toHaveBeenCalled();
  });
});
