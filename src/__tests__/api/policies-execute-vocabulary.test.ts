// dashboard 执行路由（/api/policies/[id]/execute）领域词汇回归（#602 / #610，ADR 0014 线C）。
//
// 复现 2026-10-26 生产用例：德语策略用 Fahrer/alter 编写，词汇把它们映射为 Driver/age；
// 已审批版本冻结了 e2e1026/de 与无关的 e2etest/en 两个快照。用规范字段名输入
// {"fahrer":{"age":21}} 执行时，路由必须把版本冻结、且在策略作用域内的词汇透传给
// aster-api（这里用替身模拟其「带词汇才能把 alter 规范化为 age」的行为），结果为 42。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assembleDomainVocabularyFromLinks } from '@/lib/domain-vocabulary-assemble';

const { mockDbExecute, mockGetSession, mockEvaluateSource, mockFindSnapshots, mockFindVersions } = vi.hoisted(() => ({
  mockDbExecute: vi.fn(),
  mockGetSession: vi.fn(),
  mockEvaluateSource: vi.fn(),
  mockFindSnapshots: vi.fn(),
  mockFindVersions: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ getSession: () => mockGetSession() }));

vi.mock('@/lib/cache', () => ({
  getCachedPolicyMeta: vi.fn().mockResolvedValue(null),
  cachePolicyMeta: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/team-permissions', () => ({
  checkTeamPermission: vi.fn().mockResolvedValue({ allowed: true }),
  TeamPermission: { POLICY_EXECUTE: 'policy.execute' },
}));

vi.mock('@/services/policy/runner-parity-from-execution', () => ({
  maybeRunParityForExecution: vi.fn().mockResolvedValue(null),
  RUNNER_LAUNCHER_HMAC_ROLE: 'runner-launcher',
}));

// 只替换 aster-api 客户端；cnl-executor 与词汇加载走真实实现。
vi.mock('@/services/policy/policy-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/policy/policy-api')>()),
  createPolicyApiClient: () => ({ evaluateSource: mockEvaluateSource }),
}));

vi.mock('@/lib/policy-api-identity', () => ({ createPolicyApiClientForUser: vi.fn() }));
vi.mock('@/lib/guard-notifications', () => ({ notifyApprovalRequested: vi.fn() }));

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: vi.fn().mockRejectedValue(new Error('Not cloudflare')),
}));

vi.mock('@/lib/prisma', () => {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  return {
    db: {
      query: {
        users: { findFirst: vi.fn() },
        policies: { findMany: vi.fn().mockResolvedValue([{ id: 'p1' }]) },
        policyVersions: { findMany: mockFindVersions },
        userVocabularySnapshots: { findMany: mockFindSnapshots },
      },
      insert: vi.fn().mockReturnValue({ values }),
      execute: mockDbExecute,
    },
    policies: { id: {}, userId: {}, updatedAt: {} },
    policyVersions: { policyId: {} },
    executions: { id: {} },
    users: { id: {} },
    usageRecords: { userId: {}, type: {}, period: {}, count: {} },
    domainTerms: {},
    userDomainTerms: {},
    userVocabularySnapshots: { id: {} },
  };
});

import { POST } from '@/app/api/policies/[id]/execute/route';

const DE_POLICY = `Modul e2e1026.vocab.

Definiere Fahrer hat alter als Ganzzahl.

Regel bewerten gegeben person als Fahrer liefert Ganzzahl:
  wenn person.alter mindestens 18:
    gib zurück 42.
  gib zurück 0.
`;

const vocab = (domain: string, locale: string, rows: Array<[string, string, string, string?]>) =>
  assembleDomainVocabularyFromLinks(
    rows.map(([kind, canonical, localized, parentCanonical], i) => ({
      domainTermId: `${domain}-${i}`, domain, locale, kind, canonical, localized, parentCanonical,
    })),
    { domain, locale },
  );

const FROZEN_REFS = [
  { snapshotId: 'snap-de', domain: 'e2e1026', locale: 'de' },
  { snapshotId: 'snap-en', domain: 'e2etest', locale: 'en' },
];

/** aster-api 替身：只有收到把 alter 映射为 Driver.age 的词汇时，规范输入才能命中字段。 */
function fakeEvaluateSource(_source: string, context: Record<string, unknown>, options?: { vocabulary?: { fields?: Array<{ canonical: string; localized: string }> } }) {
  const translates = options?.vocabulary?.fields?.some((f) => f.localized === 'alter' && f.canonical === 'age');
  const driver = context.fahrer as { age?: number } | undefined;
  if (!translates) {
    return Promise.resolve({ result: null, executionTimeMs: 1, error: '无法访问成员：alter。该对象的可用成员为 [age]' });
  }
  return Promise.resolve({ result: (driver?.age ?? 0) >= 18 ? 42 : 0, executionTimeMs: 1, error: null });
}

function request(body: unknown): Request {
  return new Request('http://localhost/api/policies/p1/execute', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const params = { params: Promise.resolve({ id: 'p1' }) };

function policyRow(vocabRefs: unknown) {
  return {
    policy_id: 'p1', policy_name: 'e2e1026-vocab-de', policy_content: DE_POLICY,
    policy_alias_set: null, policy_user_id: 'user-1', policy_team_id: null, policy_is_public: false,
    policy_version_row_id: 'pv-1', policy_version: 1, policy_source_toolchain_id: null,
    policy_vocab_snapshot_ids: vocabRefs,
    user_plan: 'pro', user_trial_ends_at: null, usage_count: 0, is_team_member: false,
  };
}

describe('POST /api/policies/[id]/execute — 版本冻结词汇', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
    mockFindVersions.mockResolvedValue([{ id: 'pv-1', version: 1, status: 'APPROVED', isDefault: false }]);
    mockEvaluateSource.mockImplementation(fakeEvaluateSource);
    mockFindSnapshots.mockResolvedValue([
      { vocabularyJson: vocab('e2e1026', 'de', [['struct', 'Driver', 'Fahrer'], ['field', 'age', 'alter', 'Driver']]) },
      { vocabularyJson: vocab('e2etest', 'en', [['struct', 'Applicant', 'Applicant']]) },
    ]);
  });

  it('de 策略 + 规范输入 {"fahrer":{"age":21}} → 42，并只透传作用域内的冻结词汇', async () => {
    mockDbExecute.mockResolvedValue([policyRow(FROZEN_REFS)]);

    const res = await POST(request({ input: { fahrer: { age: 21 } } }), params);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.output.result).toBe(42);

    expect(mockEvaluateSource).toHaveBeenCalledTimes(1);
    const [, , options] = mockEvaluateSource.mock.calls[0]!;
    expect(options.locale).toBe('de-DE');
    expect(options.vocabulary).toMatchObject({
      locale: 'de-DE',
      structs: [expect.objectContaining({ canonical: 'Driver', localized: 'Fahrer' })],
      fields: [expect.objectContaining({ canonical: 'age', localized: 'alter', parent: 'Driver' })],
    });
    // 无关的 e2etest/en 快照不会混进执行词汇。
    expect(JSON.stringify(options.vocabulary)).not.toContain('Applicant');
  });

  it('版本没有冻结快照时不携带词汇（与修复前的错误一致，证明替身有效）', async () => {
    mockDbExecute.mockResolvedValue([policyRow([])]);

    const res = await POST(request({ input: { fahrer: { age: 21 } } }), params);

    const body = await res.json();
    expect(body.output.result).not.toBe(42);
    expect(mockEvaluateSource.mock.calls[0]![2].vocabulary).toBeUndefined();
    expect(mockFindSnapshots).not.toHaveBeenCalled();
  });
});
