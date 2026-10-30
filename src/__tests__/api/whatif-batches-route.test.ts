import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * What-If 批次转发路由（ADR 0034 S4 接线）。
 *
 * ★这一层是**薄转发**，所以测试重点不是业务逻辑（那在 aster-api），
 * 而是三件转发本身容易做错的事：
 *   1. 未登录必须 401，且**不触碰** aster-api
 *   2. **状态码原样透传**——403（无权益）与 409（并发超限）不得被合并成泛化错误，
 *      否则前端无法区分「去升级」与「等一会儿」
 *   3. 缺版本行 id 直接 400，不给默认值（用假值掩盖「输入不存在」是上一版 `?? 0` 的同类错误）
 */

const getSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth', () => ({ getSession: () => getSession() }));

const createWhatIfBatch = vi.hoisted(() => vi.fn());
const getWhatIfBatch = vi.hoisted(() => vi.fn());
const clientArgs = vi.hoisted(() => [] as unknown[][]);

class FakePolicyApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

vi.mock('@/services/policy/policy-api', () => ({
  createPolicyApiClient: (...args: unknown[]) => {
    clientArgs.push(args);
    return { createWhatIfBatch, getWhatIfBatch };
  },
  PolicyApiError: FakePolicyApiError,
}));

vi.mock('@/lib/policy-access', async () =>
  (await import('@/__tests__/helpers/policy-access-mock')).policyAccessModule());

const { POST } = await import('@/app/api/v1/policies/[id]/whatif-batches/route');
const { policyAccessState } = await import('@/__tests__/helpers/policy-access-mock');
const { GET } = await import('@/app/api/v1/policies/[id]/whatif-batches/[batchId]/route');

const params = Promise.resolve({ id: 'p1' });
const batchParams = Promise.resolve({ id: 'p1', batchId: 'b1' });

function postReq(body: unknown) {
  return new Request('https://x.test/api/v1/policies/p1/whatif-batches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const validBody = {
  baseVersionId: 'row-1',
  targetVersionId: 'row-2',
  windowKind: 'LAST_MONTH',
};

describe('POST /api/v1/policies/:id/whatif-batches', () => {
  beforeEach(() => {
    policyAccessState.policy = { id: 'p1', userId: 'u1', teamId: null };
    policyAccessState.teamRole = null;
    getSession.mockReset();
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    createWhatIfBatch.mockReset();
    createWhatIfBatch.mockResolvedValue({ batchId: 'b1', status: 'PENDING' });
  });

  it('未登录 → 401，且不调 aster-api', async () => {
    getSession.mockResolvedValue(null);
    const res = await POST(postReq(validBody), { params });
    expect(res.status).toBe(401);
    expect(createWhatIfBatch).not.toHaveBeenCalled();
  });

  it('创建成功 → 202', async () => {
    const res = await POST(postReq(validBody), { params });
    expect(res.status).toBe(202);
    expect((await res.json()).batchId).toBe('b1');
  });

  it('★缺版本行 id → 400，不给默认值也不调 api', async () => {
    const res = await POST(postReq({ windowKind: 'LAST_MONTH' }), { params });
    expect(res.status).toBe(400);
    expect(createWhatIfBatch).not.toHaveBeenCalled();
  });

  it('非法 JSON → 400', async () => {
    const res = await POST(postReq('{bad'), { params });
    expect(res.status).toBe(400);
  });

  it('★403 原样透传——「无权益」不得变成泛化错误', async () => {
    createWhatIfBatch.mockRejectedValue(
      new FakePolicyApiError('needs pro', 403, 'whatif_not_entitled'),
    );
    const res = await POST(postReq(validBody), { params });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('whatif_not_entitled');
  });

  it('★503 plan_check_unavailable 原样透传——不得变成 403/502', async () => {
    createWhatIfBatch.mockRejectedValue(
      new FakePolicyApiError('plan lookup timed out', 503, 'plan_check_unavailable'),
    );
    const res = await POST(postReq(validBody), { params });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('plan_check_unavailable');
  });

  it('★409 原样透传——与 403 是不同的事', async () => {
    createWhatIfBatch.mockRejectedValue(
      new FakePolicyApiError('busy', 409, 'whatif_batch_in_progress'),
    );
    const res = await POST(postReq(validBody), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('whatif_batch_in_progress');
  });

  it('未知异常 → 502（而不是伪装成 200 或 400）', async () => {
    createWhatIfBatch.mockRejectedValue(new Error('socket hang up'));
    const res = await POST(postReq(validBody), { params });
    expect(res.status).toBe(502);
  });

  it('windowKind 缺省为 LAST_MONTH', async () => {
    await POST(postReq({ baseVersionId: 'a', targetVersionId: 'b' }), { params });
    expect(createWhatIfBatch).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ windowKind: 'LAST_MONTH' }),
    );
  });
});

describe('GET /api/v1/policies/:id/whatif-batches/:batchId', () => {
  beforeEach(() => {
    policyAccessState.policy = { id: 'p1', userId: 'u1', teamId: null };
    policyAccessState.teamRole = null;
    getSession.mockReset();
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    getWhatIfBatch.mockReset();
    getWhatIfBatch.mockResolvedValue({ batchId: 'b1', status: 'RUNNING' });
  });

  it('未登录 → 401，且不调 aster-api', async () => {
    getSession.mockResolvedValue(null);
    const res = await GET(new Request('https://x.test'), { params: batchParams });
    expect(res.status).toBe(401);
    expect(getWhatIfBatch).not.toHaveBeenCalled();
  });

  it('查询成功 → 200', async () => {
    const res = await GET(new Request('https://x.test'), { params: batchParams });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('RUNNING');
  });

  it('★404 原样透传——租户隔离由 api 侧保证，cloud 不重复判断', async () => {
    // 不属于本用户的批次在 api 侧返回 404（而非 403），避免成为存在性探针。
    // cloud 若自己再判一次归属，两套规则会漂移。
    getWhatIfBatch.mockRejectedValue(new FakePolicyApiError('not found', 404));
    const res = await GET(new Request('https://x.test'), { params: batchParams });
    expect(res.status).toBe(404);
  });
  // ── BFF 必须转发 includeToday（生产实测漏传）─────────────────────
  //
  // ★这一层是**逐字段重建**请求体，不是透传。新增入参若忘了加，
  //   会被静默丢弃：前端发了、后端收不到、**两边都不报错**，
  //   表现为"功能上线后毫无效果"。实测就是这么丢的。
  //   故对每个入参都要有一条"确实转发了"的断言。
  describe('includeToday 转发', () => {
    it('★includeToday: true 必须原样转发给 api', async () => {
      getSession.mockResolvedValue({ user: { id: 'u1' } });
      createWhatIfBatch.mockResolvedValue({ batchId: 'b1' });

      await POST(
        postReq({ baseVersionId: 'a', targetVersionId: 'b', includeToday: true }),
        { params },
      );

      expect(createWhatIfBatch).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ includeToday: true }),
      );
    });

    it('★includeToday: false 同样要转发（不能被当成"没传"而丢掉）', async () => {
      getSession.mockResolvedValue({ user: { id: 'u1' } });
      createWhatIfBatch.mockResolvedValue({ batchId: 'b1' });

      await POST(
        postReq({ baseVersionId: 'a', targetVersionId: 'b', includeToday: false }),
        { params },
      );

      expect(createWhatIfBatch).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ includeToday: false }),
      );
    });
  });

});

// ADR 0034 §4.3 属主限定 + 团队角色（#670）：授权在转发之前，被拒时不触碰 aster-api。
describe('What-If 批次授权', () => {
  beforeEach(() => {
    getSession.mockReset();
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    createWhatIfBatch.mockReset();
    createWhatIfBatch.mockResolvedValue({ batchId: 'b1', status: 'PENDING' });
    getWhatIfBatch.mockReset();
    getWhatIfBatch.mockResolvedValue({ batchId: 'b1', status: 'PENDING' });
  });

  it('团队策略的非创建者（即便是 owner）→ 403 whatif_owner_only', async () => {
    policyAccessState.policy = { id: 'p1', userId: 'creator', teamId: 't1' };
    policyAccessState.teamRole = 'owner';
    const res = await POST(postReq(validBody), { params });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'whatif_owner_only' });
    expect(createWhatIfBatch).not.toHaveBeenCalled();
  });

  it('创建者仍有执行权限 → 转发', async () => {
    policyAccessState.policy = { id: 'p1', userId: 'u1', teamId: 't1' };
    policyAccessState.teamRole = 'member';
    expect((await POST(postReq(validBody), { params })).status).toBe(202);
  });

  it('创建者被降为 viewer → 403；被移除 → 404', async () => {
    policyAccessState.policy = { id: 'p1', userId: 'u1', teamId: 't1' };
    policyAccessState.teamRole = 'viewer';
    expect((await POST(postReq(validBody), { params })).status).toBe(403);
    policyAccessState.teamRole = null;
    expect((await POST(postReq(validBody), { params })).status).toBe(404);
    expect((await GET(new Request('https://x.test'), { params: batchParams })).status).toBe(404);
    expect(createWhatIfBatch).not.toHaveBeenCalled();
    expect(getWhatIfBatch).not.toHaveBeenCalled();
  });

  it('他人的个人策略 → 404', async () => {
    policyAccessState.policy = { id: 'p1', userId: 'someone-else', teamId: null };
    expect((await POST(postReq(validBody), { params })).status).toBe(404);
  });
});

// ADR 0016 §2（H1）：批次租户 = 策略租户；创建与查询同一租户，userId 为当前用户（创建者）。
describe('What-If 批次租户', () => {
  beforeEach(() => {
    clientArgs.length = 0;
    getSession.mockReset();
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    createWhatIfBatch.mockReset();
    createWhatIfBatch.mockResolvedValue({ batchId: 'b1', status: 'PENDING' });
    getWhatIfBatch.mockReset();
    getWhatIfBatch.mockResolvedValue({ batchId: 'b1', status: 'PENDING' });
  });

  it('团队策略：创建与查询都以 teamId 为租户、当前用户为 userId', async () => {
    policyAccessState.policy = { id: 'p1', userId: 'u1', teamId: 't1' };
    policyAccessState.teamRole = 'member';
    expect((await POST(postReq(validBody), { params })).status).toBe(202);
    expect((await GET(new Request('https://x.test'), { params: batchParams })).status).toBe(200);
    expect(clientArgs).toEqual([['t1', 'u1'], ['t1', 'u1']]);
  });

  it('个人策略：租户为所有者本人', async () => {
    policyAccessState.policy = { id: 'p1', userId: 'u1', teamId: null };
    await POST(postReq(validBody), { params });
    expect(clientArgs).toEqual([['u1', 'u1']]);
  });
});

// #680：aster-api 的中文提示与窗口标签按错误码 / windowKind 换成英文（界面另按错误码本地化）
describe('What-If 转发的英文提示', () => {
  beforeEach(() => {
    getSession.mockReset();
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    policyAccessState.policy = { id: 'p1', userId: 'u1', teamId: null };
    policyAccessState.teamRole = null;
    createWhatIfBatch.mockReset();
    getWhatIfBatch.mockReset();
  });

  it('★无权益的中文 message 换成英文', async () => {
    createWhatIfBatch.mockRejectedValue(new FakePolicyApiError('What-If 影响估算需 Pro 及以上套餐', 403, 'whatif_not_entitled'));
    const body = await (await POST(postReq(validBody), { params })).json();
    expect(body.message).toBe('What-If impact estimates require a Pro or higher plan.');
  });

  it('★批次 windowLabel 按 windowKind 给英文', async () => {
    getWhatIfBatch.mockResolvedValue({ batchId: 'b1', status: 'COMPLETED', windowKind: 'LAST_MONTH', windowLabel: '最近一个月' });
    const body = await (await GET(new Request('https://x.test'), { params: batchParams })).json();
    expect(body.windowLabel).toBe('Last month');
  });
});
