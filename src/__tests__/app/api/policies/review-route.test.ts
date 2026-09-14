import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 复核路由的**写入层四条约束**（ADR 0037 §14/§15）。
 *
 * <p>这四条是整条证据链可信的前提，缺任一条 Proof 就不再是证据：
 *
 * <ol>
 *   <li><b>非授权人不得提交</b>——包括策略**拥有者本人**（除非也被授予资格）</li>
 *   <li><b>机器不得代签</b>——subjectKind 不得为 verifier</li>
 *   <li><b>理由非空</b>——没有理由的批准等于没有复核</li>
 *   <li><b>只 INSERT</b>——撤销＝追加覆盖，不得 UPDATE/DELETE</li>
 * </ol>
 *
 * ★第 1 条里"拥有者也不能签"是刻意的：防"自己写策略、自己签字确认"。
 */

const {
  mockGetSession,
  mockPolicyFindFirst,
  mockReviewerFindFirst,
  mockProofFindMany,
  mockInsertValues,
  mockUpdateWhere,
  mockDeleteWhere,
  mockCheckTeamPermission,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockPolicyFindFirst: vi.fn(),
  mockReviewerFindFirst: vi.fn(),
  mockProofFindMany: vi.fn(),
  mockInsertValues: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockDeleteWhere: vi.fn(),
  mockCheckTeamPermission: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...xs: unknown[]) => ({ op: 'and', xs }),
  desc: (col: unknown) => ({ op: 'desc', col }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  inArray: (col: unknown, vals: unknown) => ({ op: 'inArray', col, vals }),
}));

vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      policies: { findFirst: mockPolicyFindFirst },
      policyReviewers: { findFirst: mockReviewerFindFirst },
      policyProofs: { findMany: mockProofFindMany },
    },
    insert: () => ({ values: mockInsertValues }),
    update: () => ({ set: () => ({ where: mockUpdateWhere }) }),
    delete: () => ({ where: mockDeleteWhere }),
  },
  policies: { id: 'p.id', userId: 'p.userId', teamId: 'p.teamId' },
  policyReviewers: { policyId: 'pr.policyId', userId: 'pr.userId', createdAt: 'pr.createdAt' },
  policyProofs: { policyId: 'pp.policyId', createdAt: 'pp.createdAt' },
  REVIEWER_SUBJECT_KINDS: ['domain_expert', 'engineer'],
}));

vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }));
vi.mock('@/lib/team-permissions', () => ({
  checkTeamPermission: mockCheckTeamPermission,
  TeamPermission: { POLICY_CREATE: 'POLICY_CREATE' },
}));

const PARAMS = { params: Promise.resolve({ id: 'pol1' }) };

function post(body: unknown): Request {
  return new Request('http://cloud.test/api/policies/pol1/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 一条各字段都合法的结论——各用例只改要测的那一项。 */
const VALID = {
  nodeId: '$.decls{r}.body.statements[0].expr',
  contentHash: 'a'.repeat(64),
  verdict: 'VERIFIED',
  reason: '已与财务核对，金额与业务规则一致。',
  text: '10000',
  span: { start: 0, end: 5 },
};

function reset() {
  mockGetSession.mockReset().mockResolvedValue({ user: { id: 'u1' } });
  mockPolicyFindFirst.mockReset().mockResolvedValue({ id: 'pol1', userId: 'owner1', teamId: null });
  mockReviewerFindFirst.mockReset().mockResolvedValue({
    policyId: 'pol1', userId: 'u1', subjectKind: 'domain_expert',
  });
  mockProofFindMany.mockReset().mockResolvedValue([]);
  mockInsertValues.mockReset().mockResolvedValue(undefined);
  mockUpdateWhere.mockReset().mockResolvedValue(undefined);
  mockDeleteWhere.mockReset().mockResolvedValue(undefined);
  mockCheckTeamPermission.mockReset().mockResolvedValue({ allowed: false });
}

describe('复核结论写入 — 四条约束', () => {
  beforeEach(() => { vi.resetModules(); reset(); });
  afterEach(() => vi.restoreAllMocks());

  it('★合法请求应写入一条 Proof（前置：正常路径可用）', async () => {
    const { POST } = await import('@/app/api/policies/[id]/review/route');
    const res = await POST(post(VALID), PARAMS);

    expect(res.status).toBe(200);
    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    const row = mockInsertValues.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.subjectUserId).toBe('u1');
    expect(row.verdict).toBe('VERIFIED');
    expect(row.contentHash).toBe('a'.repeat(64));
  });

  it('★约束1：非复核人不得提交 —— **即使是策略拥有者**', async () => {
    // 拥有者能看队列，但除非也被授予复核资格，否则不能签字。
    // ★这防的是"自己写策略、自己签字确认"。
    mockGetSession.mockResolvedValue({ user: { id: 'owner1' } });
    mockReviewerFindFirst.mockResolvedValue(undefined);

    const { POST } = await import('@/app/api/policies/[id]/review/route');
    const res = await POST(post(VALID), PARAMS);

    expect(res.status).toBe(403);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('★约束2：机器不得代签 —— subjectKind=verifier 必须被拒', async () => {
    const { POST } = await import('@/app/api/policies/[id]/review/route');
    const res = await POST(post({ ...VALID, subjectKind: 'verifier' }), PARAMS);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('机器不得代签') });
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('★约束3：理由为空/纯空白必须被拒', async () => {
    const { POST } = await import('@/app/api/policies/[id]/review/route');
    for (const reason of ['', '   ', '\n\t']) {
      mockInsertValues.mockClear();
      const res = await POST(post({ ...VALID, reason }), PARAMS);
      expect(res.status, `reason=${JSON.stringify(reason)} 应被拒`).toBe(400);
      expect(mockInsertValues).not.toHaveBeenCalled();
    }
  });

  it('★约束4：只 INSERT —— 永不 UPDATE/DELETE（撤销＝追加覆盖）', async () => {
    const { POST } = await import('@/app/api/policies/[id]/review/route');
    await POST(post(VALID), PARAMS);
    await POST(post({ ...VALID, verdict: 'REJECTED', reason: '复查后推翻。' }), PARAMS);

    expect(mockInsertValues).toHaveBeenCalledTimes(2);
    // ★两次结论都落成新行；旧行不得被改写或删除，否则历史就没了。
    expect(mockUpdateWhere).not.toHaveBeenCalled();
    expect(mockDeleteWhere).not.toHaveBeenCalled();
  });
});

describe('复核结论写入 — 字段完整性', () => {
  beforeEach(() => { vi.resetModules(); reset(); });
  afterEach(() => vi.restoreAllMocks());

  it('★contentHash 必须是 64 位十六进制（时效性判据）', async () => {
    // contentHash 决定 isApplicableTo 能否算出 CONTENT_CHANGED。
    // 格式不对说明调用方没拿到真实指纹——那条 proof 将永远无法判定时效。
    const { POST } = await import('@/app/api/policies/[id]/review/route');
    for (const bad of ['', 'abc', 'A'.repeat(64), 'z'.repeat(64), 'a'.repeat(63)]) {
      mockInsertValues.mockClear();
      const res = await POST(post({ ...VALID, contentHash: bad }), PARAMS);
      expect(res.status, `contentHash=${bad.slice(0, 8)} 应被拒`).toBe(400);
      expect(mockInsertValues).not.toHaveBeenCalled();
    }
  });

  it('★text 长度必须与 span 宽度自洽', async () => {
    // 不自洽说明 span 指向的根本不是这段文本——双向导航会跳错位置。
    const { POST } = await import('@/app/api/policies/[id]/review/route');
    const res = await POST(post({ ...VALID, text: '10000', span: { start: 0, end: 3 } }), PARAMS);

    expect(res.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('★verdict 只能是 VERIFIED / REJECTED（REVIEW_REQUIRED 是机器的档）', async () => {
    const { POST } = await import('@/app/api/policies/[id]/review/route');
    for (const bad of ['REVIEW_REQUIRED', 'APPROVED', '']) {
      mockInsertValues.mockClear();
      const res = await POST(post({ ...VALID, verdict: bad }), PARAMS);
      expect(res.status, `verdict=${bad} 应被拒`).toBe(400);
      expect(mockInsertValues).not.toHaveBeenCalled();
    }
  });

  it('未登录必须 401，且不触碰数据库', async () => {
    mockGetSession.mockResolvedValue(null);
    const { POST } = await import('@/app/api/policies/[id]/review/route');
    const res = await POST(post(VALID), PARAMS);

    expect(res.status).toBe(401);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });
});
