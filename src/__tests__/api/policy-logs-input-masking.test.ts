/**
 * GET /api/policies/[id]/logs 的输入打码（cloud#754，ADR 0042 §12 F9）。
 *
 * 路由与查询层用真实实现，只替换数据库：断言响应体里没有 `@pii` 字段与未声明键的原值——不论请求者是谁
 * （执行人本人、owner、其他成员都只拿到打码视图，日志面不提供解除）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetSession, state } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  state: {
    rows: [] as Array<Record<string, unknown>>,
    versions: [] as Array<Record<string, unknown>>,
    versionQueries: 0,
  },
}));

vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }));
vi.mock('@/lib/policy-access', async () => ({
  ...(await import('@/__tests__/helpers/policy-access-mock')).policyAccessModule(),
  executionDetailScope: () => ({ kind: 'all' }),
  executionAggregateScope: () => ({ kind: 'all' }),
  executionsOfTeam: vi.fn(),
}));
vi.mock('@/lib/prisma', async () => {
  const schema = await import('@/db/schema');
  return {
    ...schema,
    db: {
      query: {
        executions: { findMany: vi.fn(async () => state.rows) },
        policyVersions: {
          findMany: vi.fn(async () => {
            state.versionQueries++;
            return state.versions;
          }),
        },
      },
      select: () => ({ from: () => ({ where: async () => [{ count: state.rows.length }] }) }),
    },
  };
});

import { GET } from '@/app/api/policies/[id]/logs/route';
import { policyAccessState } from '@/__tests__/helpers/policy-access-mock';
import { clearExecutionInputClassificationCache } from '@/lib/execution-input/input-view';

const SOURCE = [
  'Module demo.logs.',
  '',
  'Define Applicant has amount as Int, email as @pii(L2, email) Text.',
  '',
  'Rule check given applicant as Applicant, produce Bool:',
  '  Return applicant.amount greater than 10.',
  '',
].join('\n');

const EMAIL = 'john.smith@example.com';
const SECRET_KEY = 'ssn-123-45-6789';

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    policyId: 'p1',
    userId: 'u1',
    policyVersion: 1,
    policyVersionRowId: 'v1',
    functionName: 'check',
    locale: 'en-US',
    aliasSetJson: {},
    input: { applicant: { amount: 100, email: EMAIL }, extra: SECRET_KEY },
    output: { allowed: true },
    error: null,
    success: true,
    decision: 'approved',
    durationMs: 5,
    source: 'dashboard',
    metadata: null,
    createdAt: new Date('2026-11-15T00:00:00Z'),
    runnerParityStatus: null,
    policy: { name: 'P', deletedAt: null },
    ...overrides,
  };
}

const call = (qs = '') =>
  GET(new Request(`https://x.test/api/policies/p1/logs${qs}`), { params: Promise.resolve({ id: 'p1' }) });

beforeEach(() => {
  vi.clearAllMocks();
  clearExecutionInputClassificationCache();
  mockGetSession.mockResolvedValue({ user: { id: 'u1' } });
  policyAccessState.policy = { id: 'p1', name: 'P', userId: 'u1', teamId: null };
  policyAccessState.teamRole = null;
  state.rows = [row('e1')];
  // 草稿、无作者：不带词汇，不触发词汇表查询
  state.versions = [{ id: 'v1', policyId: 'p1', content: SOURCE, aliasSet: null, status: 'DRAFT', createdBy: null, vocabularySnapshotIds: null }];
  state.versionQueries = 0;
});

describe('GET /api/policies/[id]/logs —— 输入打码（#754）', () => {
  it('★执行人本人请求：@pii 字段为 $pii 占位、未声明参数为 unknown，响应体不含原值', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain('"extra"');
    const body = JSON.parse(text);
    expect(body.items[0].input).toEqual({
      applicant: { amount: 100, email: { $pii: { level: 'L2', category: 'email' } } },
      $undeclared: { $pii: { level: 'unknown' } },
    });
    expect(body.items[0].inputMask).toEqual({ maskRules: 'v1', marksSource: 'version' });
  });

  it('团队其他成员请求：同一打码视图', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'u2' } });
    policyAccessState.policy = { id: 'p1', name: 'P', userId: 'u1', teamId: 't1' };
    policyAccessState.teamRole = 'member';
    const text = await (await call()).text();
    expect(text).not.toContain(EMAIL);
    expect(JSON.parse(text).items[0].input.applicant.email).toEqual({ $pii: { level: 'L2', category: 'email' } });
  });

  it('mode=recent 同样打码', async () => {
    const text = await (await call('?mode=recent')).text();
    expect(text).not.toContain(EMAIL);
    expect(JSON.parse(text).items[0].inputMask.marksSource).toBe('version');
  });

  it('历史行没有版本引用 → marksSource none：键名与值全部隐藏', async () => {
    state.rows = [row('e2', { policyVersionRowId: null, functionName: null })];
    const body = await (await call()).json();
    expect(body.items[0].input).toEqual({ $undeclared: { $pii: { level: 'unknown' } } });
    expect(body.items[0].inputMask).toEqual({ maskRules: 'v1', marksSource: 'none' });
  });

  it('版本行已不存在 / 源码解析失败 → none（fail-closed）', async () => {
    state.versions = [];
    const body = await (await call()).json();
    expect(body.items[0].inputMask.marksSource).toBe('none');
    expect(JSON.stringify(body)).not.toContain(EMAIL);
  });

  it('同一版本的多行只查一次版本表', async () => {
    state.rows = [row('e1'), row('e2'), row('e3')];
    await call();
    expect(state.versionQueries).toBe(1);
  });
});

describe('GET /api/policies/[id]/logs —— 输出字符串叶子过 PIIRedactor（#772）', () => {
  it('★由输入派生的输出（"Hello, " + 姓名 + 邮箱）在响应体里被打码，其他叶子不动', async () => {
    state.rows = [row('e1', { output: { greeting: `Hello, John Smith (${EMAIL})!`, allowed: true, score: 7 } })];
    for (const qs of ['', '?mode=recent']) {
      const text = await (await call(qs)).text();
      expect(text).not.toContain(EMAIL);
      expect(JSON.parse(text).items[0].output).toEqual({ greeting: 'Hello, John Smith (***@***.***)!', allowed: true, score: 7 });
    }
  });
});
