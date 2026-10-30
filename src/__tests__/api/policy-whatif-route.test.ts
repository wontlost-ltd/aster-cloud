// What-if 端点测试（Phase 4）。
//
// ★本端点当前**一律返回 409 REPLAY_REQUIRED**，故这里只验三件事：
//   1. 鉴权与租户隔离仍然成立（拒答不能变成「策略是否存在」的探针）
//   2. 409 契约稳定（调用方据此判断能力未上线，而不是拿到一个假结论）
//   3. 不返回任何数字字段
//
// 为什么不测「成功路径」：当前数据模型下它**在合法数据上不可能出现**。
// `Execution.id` 是主键、`policyVersion` 是普通列，一行只属于一个版本，
// 故两个版本的 executionId 交集恒为空。此前那版测试之所以绿，是把同一个
// executionId 同时塞进 base 与 target 两个 mock 结果集 —— 制造了一个数据库
// 产生不出来的状态，属于自证。删掉比留着更诚实。
//
// 解锁后（真回放 / 影子执行 / A-B cohort，见 route 头注释）再补成功路径测试。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const getSession = vi.fn();
vi.mock('@/lib/auth', () => ({ getSession: () => getSession() }));

vi.mock('@/lib/policy-access', async () =>
  (await import('@/__tests__/helpers/policy-access-mock')).policyAccessModule());

const { GET } = await import('@/app/api/policies/[id]/whatif/route');
const { policyAccessState } = await import('@/__tests__/helpers/policy-access-mock');

const params = Promise.resolve({ id: 'p1' });
const req = (qs = 'baseVersion=1&targetVersion=2') =>
  new NextRequest(`http://localhost/api/policies/p1/whatif?${qs}`);

describe('GET /api/policies/:id/whatif（当前一律 409）', () => {
  beforeEach(() => {
    policyAccessState.policy = { id: 'p1', userId: 'u1', teamId: null };
    policyAccessState.teamRole = null;
    getSession.mockReset();
  });

  it('未登录 → 401（先于 409，不泄露任何信息）', async () => {
    getSession.mockResolvedValue(null);
    const res = await GET(req(), { params });
    expect(res.status).toBe(401);
  });

  it('★不是自己的策略 → 404，而不是 409', async () => {
    // 若先返回 409 再校验归属，本端点会退化成「策略是否存在」的探针：
    // 任意登录用户拿别人的 policyId 来打，就能从状态码差异推断存在性。
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    policyAccessState.policy = { id: 'p1', userId: 'someone-else', teamId: null };
    const res = await GET(req(), { params });
    expect(res.status).toBe(404);
  });

  it('★团队策略：团队外用户 / 已离队的创建者 → 404；任一成员 → 409', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    policyAccessState.policy = { id: 'p1', userId: 'u1', teamId: 't1' };
    expect((await GET(req(), { params })).status).toBe(404);
    policyAccessState.teamRole = 'viewer';
    expect((await GET(req(), { params })).status).toBe(409);
  });

  it('★自己的策略 → 409 REPLAY_REQUIRED', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    const res = await GET(req(), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('REPLAY_REQUIRED');
  });

  it('★响应不得包含任何会被读成结论的数字字段', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    const res = await GET(req(), { params });
    const body = await res.json();
    for (const k of [
      'changed',
      'newlyApproved',
      'newlyRejected',
      'estimatedValueDelta',
      'baselinePositiveRate',
      'confidence',
      'comparable',
    ]) {
      expect(body[k]).toBeUndefined();
    }
  });

  it('版本参数不影响结论（能力未上线，与参数无关）', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    const res = await GET(req('baseVersion=7&targetVersion=9'), { params });
    expect(res.status).toBe(409);
  });
});
