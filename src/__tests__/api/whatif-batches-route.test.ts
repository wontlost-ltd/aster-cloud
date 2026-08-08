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
  createPolicyApiClient: () => ({ createWhatIfBatch, getWhatIfBatch }),
  PolicyApiError: FakePolicyApiError,
}));

const { POST } = await import('@/app/api/v1/policies/[id]/whatif-batches/route');
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
});
