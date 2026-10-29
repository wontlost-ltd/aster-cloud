// POST /api/v1/policies/[id]/versions 关键词别名支持测试（ADR 0022）。
//
// 修复前：该版本写入入口只解构 source/releaseNote，完全忽略 aliasSet → 别名策略经此入口
// 创建的版本丢别名（无 envelope 冻结/无审计）。现应走 version-manager 可信路径，且
// allowStructural 从服务端 per-user entitlement 取（不信 body）。

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/services/policy/version-manager', () => ({
  createVersion: vi.fn(),
  listVersions: vi.fn(),
  listExecutableVersions: vi.fn(),
  // 路由 catch 分支用 instanceof 判编译门禁错误，mock 需提供该类。
  PolicyCompileError: class PolicyCompileError extends Error {},
}));
vi.mock('@/lib/structural-alias-grants', () => ({
  getStructuralAliasGrant: vi.fn(),
  buildAliasReservedForUser: vi.fn(),
}));
vi.mock('@/lib/prisma', () => ({
  db: { query: { policies: { findFirst: vi.fn() } } },
  policies: { id: {}, userId: {}, deletedAt: {} },
}));
vi.mock('@/lib/policy-freeze', () => ({ isPolicyFrozen: vi.fn() }));
// envelope 词汇段（ADR 0051 §7）：作者现行词汇的规范 scopes JSON。
vi.mock('@/lib/domain-vocabulary-snapshot', () => ({
  loadLiveVocabularyScopesJson: vi.fn(async () => '{"scopes":"live"}'),
}));

import { POST } from '@/app/api/v1/policies/[id]/versions/route';
import { auth } from '@/auth';
import { createVersion } from '@/services/policy/version-manager';
import { loadLiveVocabularyScopesJson } from '@/lib/domain-vocabulary-snapshot';
import {
  getStructuralAliasGrant,
  buildAliasReservedForUser,
} from '@/lib/structural-alias-grants';
import { db } from '@/lib/prisma';
import { isPolicyFrozen } from '@/lib/policy-freeze';

function req(body: unknown) {
  return new Request('http://localhost/api/v1/policies/p1/versions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}
const params = { params: Promise.resolve({ id: 'p1' }) };

describe('POST /api/v1/policies/[id]/versions — aliasSet 支持', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue({ user: { id: 'user-1' } } as never);
    // 默认：调用者拥有该策略且未冻结（授权通过）。
    vi.mocked(db.query.policies.findFirst).mockResolvedValue({ id: 'p1' } as never);
    vi.mocked(isPolicyFrozen).mockResolvedValue({ isFrozen: false } as never);
    vi.mocked(createVersion).mockResolvedValue({
      id: 'v2', version: 2, sourceHash: 'h', sourceEnvelopeSha256: 'e',
    } as never);
    vi.mocked(getStructuralAliasGrant).mockResolvedValue(false);
    vi.mocked(buildAliasReservedForUser).mockResolvedValue({
      canonicalKeywordsLower: new Set(),
    } as never);
  });

  it('带 aliasSet → 走 version-manager 且服务端 grant 权威传入', async () => {
    const r = await POST(req({
      source: 'Module X. Rule r given x as Int, produce Int: Return x multiplied by 2.',
      aliasSet: { TIMES: ['multiplied by'] },
      locale: 'en-US',
    }), params);

    expect(r.status).toBe(201);
    expect(buildAliasReservedForUser).toHaveBeenCalledWith('user-1', 'en-US');
    expect(createVersion).toHaveBeenCalledWith(expect.objectContaining({
      aliasSet: { TIMES: ['multiplied by'] },
      aliasReserved: expect.any(Object),
      allowStructuralAliases: false, // 来自服务端 grant，非 body
    }));
  });

  it('body 声称 allowStructural 无效——仍用服务端 grant', async () => {
    vi.mocked(getStructuralAliasGrant).mockResolvedValue(true);
    await POST(req({
      source: 'Module X.',
      aliasSet: { RETURN: ['the answer is'] },
      allowStructural: false, // body 谎报，应被忽略
    }), params);

    expect(createVersion).toHaveBeenCalledWith(expect.objectContaining({
      allowStructuralAliases: true, // 服务端 grant=true 权威
    }));
  });

  it('无 aliasSet → createVersion 收 null，不查 grant/reserved', async () => {
    await POST(req({ source: 'Module X.' }), params);

    expect(createVersion).toHaveBeenCalledWith(expect.objectContaining({ aliasSet: null }));
    expect(buildAliasReservedForUser).not.toHaveBeenCalled();
  });

  it('envelope 词汇段取作者现行词汇（按源码与编译 locale）', async () => {
    await POST(req({ source: 'Module X.', locale: 'de' }), params);
    expect(loadLiveVocabularyScopesJson).toHaveBeenCalledWith('user-1', { source: 'Module X.', locale: 'de-DE' });
    expect(createVersion).toHaveBeenCalledWith(expect.objectContaining({ scopesJson: '{"scopes":"live"}' }));
  });

  it('#609：别名校验失败 → 400 alias_invalid，而非 500', async () => {
    vi.mocked(createVersion).mockRejectedValueOnce(
      new Error('用户自定义别名校验失败: 不允许为结构词 IF 自定义别名'),
    );
    const r = await POST(req({ source: 'Module X.', aliasSet: { IF: ['provided that'] } }), params);
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('alias_invalid');
  });

  it('不受支持的 locale（en-GB）→ 400 unsupported_locale，不建版本', async () => {
    const r = await POST(req({ source: 'Module X.', locale: 'en-GB' }), params);
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ code: 'unsupported_locale' });
    expect(createVersion).not.toHaveBeenCalled();
  });

  it('短码 locale 规范化：zh → zh-CN', async () => {
    await POST(req({ source: 'Module X.', locale: 'zh' }), params);
    expect(createVersion).toHaveBeenCalledWith(expect.objectContaining({ locale: 'zh-CN' }));
  });

  it('未授权 → 401', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const r = await POST(req({ source: 'Module X.' }), params);
    expect(r.status).toBe(401);
  });

  it('缺 source → 400', async () => {
    const r = await POST(req({ aliasSet: { TIMES: ['multiplied by'] } }), params);
    expect(r.status).toBe(400);
    expect(createVersion).not.toHaveBeenCalled();
  });

  it('IDOR：非所有者对他人 policy 建版本 → 404，不建版本', async () => {
    // 授权校验：findFirst 按 (id, userId=self, 未删) 查不到 → 404。
    vi.mocked(db.query.policies.findFirst).mockResolvedValue(undefined as never);
    const r = await POST(req({ source: 'Module X.', aliasSet: { TIMES: ['multiplied by'] } }), params);
    expect(r.status).toBe(404);
    expect(createVersion).not.toHaveBeenCalled();
  });

  it('冻结策略 → 403，不建版本', async () => {
    vi.mocked(isPolicyFrozen).mockResolvedValue({ isFrozen: true } as never);
    const r = await POST(req({ source: 'Module X.' }), params);
    expect(r.status).toBe(403);
    expect(createVersion).not.toHaveBeenCalled();
  });
});
