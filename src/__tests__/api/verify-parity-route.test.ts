/*
 * POST /api/policies/[id]/executions/[execId]/verify-parity（manual parity 触发）测试。
 * 认证/归属 401/404；复用行上 side-A 只跑 side-B；结果返回；错误结构化 500 不裸抛。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getSession, findFirstPolicy, findFirstExec, findFirstVersion, runParityForExecutionNow } = vi.hoisted(() => ({
  getSession: vi.fn(),
  findFirstPolicy: vi.fn(),
  findFirstExec: vi.fn(),
  findFirstVersion: vi.fn(),
  runParityForExecutionNow: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/prisma', () => ({
  db: { query: {
    policies: { findFirst: findFirstPolicy },
    executions: { findFirst: findFirstExec },
    policyVersions: { findFirst: findFirstVersion },
  } },
  policies: { id: 'id', userId: 'userId', deletedAt: 'deletedAt' },
  executions: { id: 'id', policyId: 'policyId', userId: 'userId' },
  policyVersions: { id: 'id', policyId: 'policyId' },
}));
vi.mock('drizzle-orm', () => ({
  and: (...a: unknown[]) => a, eq: (c: unknown, v: unknown) => ({ c, v }), isNull: (c: unknown) => ({ c }),
}));
vi.mock('@/services/policy/runner-parity-from-execution', () => ({
  runParityForExecutionNow,
  RUNNER_LAUNCHER_HMAC_ROLE: 'ADMIN',
}));

const loadVersionExecutionVocabulary = vi.hoisted(() => vi.fn(async () => undefined as Record<string, unknown> | undefined));
vi.mock('@/lib/execution-input', () => ({ loadVersionExecutionVocabulary }));

import { POST } from '@/app/api/policies/[id]/executions/[execId]/verify-parity/route';

function call(id = 'p1', execId = 'e1') {
  return POST(new Request('http://localhost/x', { method: 'POST' }), {
    params: Promise.resolve({ id, execId }),
  });
}
const execRow = {
  id: 'e1', input: { a: 1 }, functionName: 'f', locale: 'en', aliasSetJson: null,
  policyVersionRowId: 'ver-1',   // 有冻结版本引用
  canonicalInputHash: 'in', canonicalOutputHash: 'out', canonicalizationVersion: 'v1',
  replayabilityStatus: 'REPLAYABLE', traceHash: 'th', runtimeToolchainId: 'tc',
};
const policyRow = { id: 'p1', teamId: null, userId: 'u1' };
const versionRow = { content: 'Rule x is 1.', aliasSet: null }; // ★当次冻结源码

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: 'u1' } });
  findFirstPolicy.mockResolvedValue(policyRow);
  findFirstExec.mockResolvedValue(execRow);
  findFirstVersion.mockResolvedValue(versionRow);
  runParityForExecutionNow.mockResolvedValue({ result: { status: 'match' }, persisted: true });
});

describe('POST verify-parity', () => {
  it('未认证 → 401', async () => {
    getSession.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    expect(runParityForExecutionNow).not.toHaveBeenCalled();
  });

  it('策略不属于用户 → 404', async () => {
    findFirstPolicy.mockResolvedValue(undefined);
    expect((await call()).status).toBe(404);
    expect(runParityForExecutionNow).not.toHaveBeenCalled();
  });

  it('execution 不存在 → 404', async () => {
    findFirstExec.mockResolvedValue(undefined);
    expect((await call()).status).toBe(404);
    expect(runParityForExecutionNow).not.toHaveBeenCalled();
  });

  it('★跨租户纵深隔离（Codex 抓 P0）：execution 查询 where 必含 executions.userId==会话用户', async () => {
    await call();
    // and/eq mock 把 where 捕获为 [{c,v}...]；断言含 userId 约束——不依赖跨表不变量。
    const where = findFirstExec.mock.calls[0][0].where as Array<{ c: string; v: string }>;
    expect(where).toContainEqual({ c: 'id', v: 'e1' });
    expect(where).toContainEqual({ c: 'policyId', v: 'p1' });
    expect(where).toContainEqual({ c: 'userId', v: 'u1' }); // ★关键：约束 execution 自身 userId
  });

  it('★policyId 匹配但 execution.userId 不匹配（脏行）→ 真库 findFirst 过滤掉 → 404，不跑 parity', async () => {
    // 真库下 userId 约束会过滤脏行 → findFirst 返 undefined。断言此时 404 且 side-B 不启动。
    findFirstExec.mockResolvedValue(undefined);
    const resp = await call();
    expect(resp.status).toBe(404);
    expect(runParityForExecutionNow).not.toHaveBeenCalled(); // 绝不读/触发/回写他人 execution
  });

  it('成功 → 200 + parity 结果 + persisted，复用行上 side-A + **当次冻结源码**（非当前 policy.content）', async () => {
    const resp = await call();
    expect(resp.status).toBe(200);
    const body = await resp.json() as { executionId: string; parity: { status: string }; persisted: boolean };
    expect(body).toEqual({ executionId: 'e1', parity: { status: 'match' }, persisted: true });
    const ctx = runParityForExecutionNow.mock.calls[0][0];
    expect(ctx.authorityReplay.canonicalInputHash).toBe('in'); // 复用行上 side-A
    expect(ctx.source).toBe('Rule x is 1.');                    // ★来自 version.content（冻结）非 policy.content
    expect(ctx.executionId).toBe('e1');
    expect(ctx.role).toBe('ADMIN');
    expect(findFirstVersion).toHaveBeenCalledOnce();            // 真取了冻结版本
  });

  it('★execution 缺 policyVersionRowId（历史行）→ authority-failure not-replayable，不跑 side-B', async () => {
    findFirstExec.mockResolvedValue({ ...execRow, policyVersionRowId: null });
    const resp = await call();
    expect(resp.status).toBe(200);
    const body = await resp.json() as { parity: { status: string }; note: string };
    expect(body.parity.status).toBe('authority-failure');
    expect(body.note).toBe('not-replayable');
    expect(runParityForExecutionNow).not.toHaveBeenCalled(); // 不跑 side-B（避免假 divergent）
  });

  it('★当次 PolicyVersion 不存在（已删/引用错）→ authority-failure not-replayable', async () => {
    findFirstVersion.mockResolvedValue(undefined);
    const resp = await call();
    const body = await resp.json() as { parity: { status: string }; note: string };
    expect(body.parity.status).toBe('authority-failure');
    expect(body.note).toBe('not-replayable');
    expect(runParityForExecutionNow).not.toHaveBeenCalled();
  });

  it('divergent 结果照实返回（parity 不 gate，仍 200）', async () => {
    runParityForExecutionNow.mockResolvedValue({ result: { status: 'divergent', divergentFields: ['traceHash'] }, persisted: true });
    const resp = await call();
    expect(resp.status).toBe(200);
    const body = await resp.json() as { parity: { status: string; divergentFields: string[] } };
    expect(body.parity).toEqual({ status: 'divergent', divergentFields: ['traceHash'] });
  });

  it('★persisted=false（回写失败）→ 200 但明示 persisted:false（Codex 抓：不误导管理员）', async () => {
    runParityForExecutionNow.mockResolvedValue({ result: { status: 'match' }, persisted: false });
    const resp = await call();
    expect(resp.status).toBe(200);
    const body = await resp.json() as { persisted: boolean };
    expect(body.persisted).toBe(false);
  });

  it('runParityForExecutionNow 抛 → 结构化 500（不裸 5xx 抛，parity 失败不污染响应）', async () => {
    runParityForExecutionNow.mockRejectedValue(new Error('launcher down'));
    const resp = await call();
    expect(resp.status).toBe(500);
    const text = await resp.text();
    // 原始错误只进日志，响应只带通用文案与 requestId（#662）。
    expect(text).not.toContain('launcher down');
    const body = JSON.parse(text) as { error: string; code: string; requestId: string };
    expect(body.error).toContain('Parity verification failed');
    expect(body.code).toBe('internal_error');
    expect(body.requestId).toBe(resp.headers.get('x-request-id'));
  });

  it('aliasSetJson 为对象 → 传为 aliasSet', async () => {
    findFirstExec.mockResolvedValue({ ...execRow, aliasSetJson: { greet: ['hi'] } });
    await call();
    expect(runParityForExecutionNow.mock.calls[0][0].aliasSet).toEqual({ greet: ['hi'] });
  });

  it('aliasSetJson 数组（非法）+ version.aliasSet 有值 → 回退 version.aliasSet 解析', async () => {
    findFirstExec.mockResolvedValue({ ...execRow, aliasSetJson: [] });
    findFirstVersion.mockResolvedValue({ content: 'Rule x is 1.', aliasSet: '{"greet":["hola"]}' });
    await call();
    expect(runParityForExecutionNow.mock.calls[0][0].aliasSet).toEqual({ greet: ['hola'] });
  });

  it('side-B 带当次版本的领域词汇（ADR 0051：与执行同一口径），无词汇时省略', async () => {
    const vocabulary = { id: 'grades', locale: 'de-DE', structs: [], fields: [], functions: [] };
    findFirstVersion.mockResolvedValue({ ...versionRow, status: 'APPROVED', createdBy: 'a1', vocabularySnapshotIds: [{ snapshotId: 's1' }] });
    loadVersionExecutionVocabulary.mockResolvedValueOnce(vocabulary);

    await call();

    expect(runParityForExecutionNow.mock.calls[0][0].vocabulary).toEqual(vocabulary);
    expect(loadVersionExecutionVocabulary).toHaveBeenCalledWith({
      status: 'APPROVED', vocabularySnapshotIds: [{ snapshotId: 's1' }], authorId: 'a1', source: 'Rule x is 1.', locale: 'en',
    });

    await call();
    expect(runParityForExecutionNow.mock.calls[1][0].vocabulary).toBeUndefined();
  });
});
