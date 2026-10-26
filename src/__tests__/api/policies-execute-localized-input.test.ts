// #626 dashboard 执行：输入按策略语言书写。
//
// 生产复现：德语策略用 Fahrer/alter 编写、参数 person；执行页「生成示例」给出
// {"person":{"alter":21}}，修复前直接执行失败、只有规范 key 才成功。执行端用 aster-lang-ts 真引擎
// 替身（helpers/ts-engine），它与 aster-api 一样按收到的词汇规范化源码再用收到的 context 求值。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assembleDomainVocabularyFromLinks } from '@/lib/domain-vocabulary-assemble';
import { computeSourceEnvelope } from '@/lib/policy-alias';
import { evaluateWithTsEngine } from '../helpers/ts-engine';

const { mockDbExecute, mockGetSession, mockEvaluateSource, mockFindVersions, mockLoadFrozen, mockLoadLive, mockInsertValues } = vi.hoisted(() => ({
  mockDbExecute: vi.fn(),
  mockGetSession: vi.fn(),
  mockEvaluateSource: vi.fn(),
  mockFindVersions: vi.fn(),
  mockLoadFrozen: vi.fn(),
  mockLoadLive: vi.fn(),
  mockInsertValues: vi.fn(),
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
vi.mock('@/services/policy/policy-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/policy/policy-api')>()),
  createPolicyApiClient: () => ({ evaluateSource: mockEvaluateSource }),
}));
vi.mock('@/lib/policy-api-identity', () => ({ createPolicyApiClientForUser: vi.fn() }));
vi.mock('@/lib/guard-notifications', () => ({ notifyApprovalRequested: vi.fn() }));
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: vi.fn().mockRejectedValue(new Error('Not cloudflare')),
}));
// 词汇来源：冻结快照（已审批）与作者现行词汇（草稿）分别替身，验证切换点。
vi.mock('@/lib/domain-vocabulary-snapshot', () => ({
  loadExecutionVocabulary: mockLoadFrozen,
  loadLiveVocabularyForPolicy: mockLoadLive,
}));
vi.mock('@/lib/prisma', () => {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  mockInsertValues.mockReturnValue({ onConflictDoUpdate });
  return {
    db: {
      query: {
        users: { findFirst: vi.fn() },
        policies: { findMany: vi.fn().mockResolvedValue([{ id: 'p1' }]) },
        policyVersions: { findMany: mockFindVersions },
      },
      insert: vi.fn().mockReturnValue({ values: mockInsertValues }),
      execute: mockDbExecute,
    },
    policies: { id: {}, userId: {}, updatedAt: {} },
    policyVersions: { policyId: {} },
    executions: { id: {} },
    users: { id: {} },
    usageRecords: { userId: {}, type: {}, period: {}, count: {} },
  };
});

import { POST } from '@/app/api/policies/[id]/execute/route';

const DE_POLICY = `Modul e2e1027.vocab.

Definiere Fahrer hat alter als Ganzzahl.

Regel bewerten gegeben person als Fahrer liefert Ganzzahl:
  wenn person.alter mindestens 18:
    gib zurück 42.
  gib zurück 0.
`;

// 同一策略，但「gib zurück」写成作者的关键词别名（ADR 0022）。
const ALIAS_SET = { RETURN: ['ergebnis lautet'] };
const DE_POLICY_WITH_ALIAS = DE_POLICY.replaceAll('gib zurück', 'ergebnis lautet');

const EN_POLICY = `Module demo.

Define Driver has age as Int.

Rule check given person as Driver, produce Int:
  If person.age at least 18:
    Return 42.
  Return 0.
`;

function deVocab(fieldLocalized = 'alter', aliases: string[] = []) {
  return assembleDomainVocabularyFromLinks(
    [
      { domainTermId: 't-driver', domain: 'e2e1027', locale: 'de', kind: 'struct', canonical: 'Driver', localized: 'Fahrer' },
      { domainTermId: 't-age', domain: 'e2e1027', locale: 'de', kind: 'field', canonical: 'age', localized: fieldLocalized, parentCanonical: 'Driver', aliases },
    ],
    { domain: 'e2e1027', locale: 'de-DE' },
  ) as unknown as Record<string, unknown>;
}

const FROZEN_REFS = [{ snapshotId: 'snap-de', domain: 'e2e1027', locale: 'de' }];

function policyRow(
  content: string,
  opts: { aliasSet?: string | null; vocabRefs?: unknown; teamId?: string | null; toolchainId?: string | null } = {},
) {
  return {
    policy_id: 'p1', policy_name: 'e2e1027-vocab-de', policy_content: content,
    policy_alias_set: opts.aliasSet ?? null, policy_user_id: 'owner-1', policy_team_id: opts.teamId ?? null, policy_is_public: false,
    policy_version_row_id: 'pv-1', policy_version: 1, policy_source_toolchain_id: opts.toolchainId ?? null,
    policy_vocab_snapshot_ids: 'vocabRefs' in opts ? opts.vocabRefs : FROZEN_REFS,
    user_plan: 'pro', user_trial_ends_at: null, usage_count: 0, is_team_member: Boolean(opts.teamId),
  };
}

function versions(status: string, extra: { createdBy?: string | null; sourceEnvelopeSha256?: string | null } = {}) {
  return [{
    id: 'pv-1', version: 1, status, isDefault: false,
    createdBy: extra.createdBy === undefined ? 'author-1' : extra.createdBy,
    sourceEnvelopeSha256: extra.sourceEnvelopeSha256 ?? null,
  }];
}

async function execute(input: unknown) {
  const res = await POST(
    new Request('http://localhost/api/policies/p1/execute', {
      method: 'POST',
      body: JSON.stringify({ input }),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ id: 'p1' }) },
  );
  return { status: res.status, body: await res.json() };
}

/** 落库的执行记录（第一条 insert 是 Execution）。 */
function storedExecutionInput(): unknown {
  return (mockInsertValues.mock.calls[0]?.[0] as { input?: unknown } | undefined)?.input;
}

describe('POST /api/policies/[id]/execute — 策略语言输入（#626）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: 'owner-1' } });
    mockEvaluateSource.mockImplementation(evaluateWithTsEngine);
    mockFindVersions.mockResolvedValue(versions('APPROVED'));
    mockLoadFrozen.mockResolvedValue(deVocab());
    mockLoadLive.mockResolvedValue(null);
    mockDbExecute.mockResolvedValue([policyRow(DE_POLICY)]);
  });

  it('生产复现：本地化输入 {"person":{"alter":21}} → 42，引擎收到规范名，执行记录存规范输入', async () => {
    const { status, body } = await execute({ person: { alter: 21 } });

    expect(status).toBe(200);
    expect(body.output.result).toBe(42);
    expect(mockEvaluateSource.mock.calls[0]![1]).toEqual({ person: { age: 21 } });
    expect(storedExecutionInput()).toEqual({ person: { age: 21 } });
  });

  it('规范输入 {"person":{"age":21}} 仍然接受，结果相同', async () => {
    const { status, body } = await execute({ person: { age: 21 } });
    expect(status).toBe(200);
    expect(body.output.result).toBe(42);
  });

  it('本地化键与规范键并存 → 400 ambiguous_input_field，不调用引擎、不落库', async () => {
    const { status, body } = await execute({ person: { alter: 21, age: 30 } });

    expect(status).toBe(400);
    expect(body).toMatchObject({
      code: 'ambiguous_input_field',
      field: 'person.age',
      fields: ['person.alter', 'person.age'],
      policyField: 'alter',
    });
    expect(mockEvaluateSource).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('关键词别名只影响源码：带 aliasSet 的策略接受同样的本地化输入', async () => {
    mockDbExecute.mockResolvedValue([policyRow(DE_POLICY_WITH_ALIAS, { aliasSet: JSON.stringify(ALIAS_SET) })]);

    const { status, body } = await execute({ person: { alter: 21 } });

    expect(status).toBe(200);
    expect(body.output.result).toBe(42);
    expect(mockEvaluateSource.mock.calls[0]![1]).toEqual({ person: { age: 21 } });
  });

  it('英文策略、无词汇：输入原样交给引擎（同一形状），结果不变', async () => {
    mockDbExecute.mockResolvedValue([policyRow(EN_POLICY, { vocabRefs: [] })]);
    mockLoadFrozen.mockResolvedValue(undefined);

    const { status, body } = await execute({ person: { age: 21, Alter: 1 } });

    expect(status).toBe(200);
    expect(body.output.result).toBe(42);
    expect(mockEvaluateSource.mock.calls[0]![1]).toEqual({ person: { age: 21, Alter: 1 } });
  });

  it('已审批版本只用冻结快照，之后的词条编辑（现行词汇）不影响', async () => {
    mockLoadLive.mockResolvedValue(deVocab('jahre'));

    const { body } = await execute({ person: { alter: 21 } });

    expect(body.output.result).toBe(42);
    expect(mockLoadLive).not.toHaveBeenCalled();
    // 无 envelope 时取冻结快照引用的唯一 locale（与 secure-execute 同一解析器）。
    expect(mockLoadFrozen).toHaveBeenCalledWith(FROZEN_REFS, { source: DE_POLICY, locale: 'de' });
  });

  it('locale 与 secure-execute 同一解析器：版本记录的编译 locale 优先于源码识别', async () => {
    // 源码看起来是德语，但版本保存时按 en-US 编译（envelope 记录）：三条路径都应按 en-US 执行。
    const envelope = computeSourceEnvelope(DE_POLICY, null, 'en-US', 'tc-1');
    mockFindVersions.mockResolvedValue(versions('APPROVED', { sourceEnvelopeSha256: envelope }));
    mockDbExecute.mockResolvedValue([policyRow(DE_POLICY, { toolchainId: 'tc-1' })]);
    mockEvaluateSource.mockResolvedValue({ result: 0, executionTimeMs: 1, error: null });

    await execute({ person: { alter: 21 } });

    expect(mockLoadFrozen).toHaveBeenCalledWith(FROZEN_REFS, { source: DE_POLICY, locale: 'en-US' });
    expect(mockEvaluateSource.mock.calls[0]![2].locale).toBe('en-US');
  });
});

describe('POST /api/policies/[id]/execute — 团队策略的草稿词汇归属（与审批冻结同口径）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: 'member-9' } });
    mockEvaluateSource.mockImplementation(evaluateWithTsEngine);
    mockLoadFrozen.mockResolvedValue(undefined);
    mockDbExecute.mockResolvedValue([policyRow(DE_POLICY, { vocabRefs: null, teamId: 'team-1' })]);
  });

  it('版本作者（createdBy）≠ 策略所有者 / 执行者：取版本作者的现行词汇', async () => {
    mockFindVersions.mockResolvedValue(versions('DRAFT', { createdBy: 'member-2' }));
    mockLoadLive.mockResolvedValue(deVocab());

    const { body } = await execute({ person: { alter: 21 } });

    expect(mockLoadLive).toHaveBeenCalledTimes(1);
    expect(mockLoadLive).toHaveBeenCalledWith('member-2', { source: DE_POLICY, locale: 'de-DE' });
    expect(body.output.result).toBe(42);
  });

  it('版本没有作者时不带词汇（审批冻结此时同样不冻结任何词汇），不回退到所有者', async () => {
    mockFindVersions.mockResolvedValue(versions('DRAFT', { createdBy: null }));
    mockLoadLive.mockResolvedValue(deVocab());

    await execute({ person: { alter: 21 } });

    expect(mockLoadLive).not.toHaveBeenCalled();
    expect(mockEvaluateSource.mock.calls[0]![2].vocabulary).toBeUndefined();
  });
});

describe('POST /api/policies/[id]/execute — 草稿按作者现行词汇执行（#626 选项 A）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: 'owner-1' } });
    mockEvaluateSource.mockImplementation(evaluateWithTsEngine);
    mockFindVersions.mockResolvedValue(versions('DRAFT'));
    mockLoadFrozen.mockResolvedValue(undefined);
    mockDbExecute.mockResolvedValue([policyRow(DE_POLICY, { vocabRefs: null })]);
  });

  it('草稿用版本作者的现行词汇（作用域按源码 + 语言），本地化输入 → 42', async () => {
    mockLoadLive.mockResolvedValue(deVocab());

    const { status, body } = await execute({ person: { alter: 21 } });

    expect(status).toBe(200);
    expect(body.output.result).toBe(42);
    expect(mockLoadLive).toHaveBeenCalledWith('author-1', { source: DE_POLICY, locale: 'de-DE' });
    expect(mockLoadFrozen).not.toHaveBeenCalled();
    // 同一份词汇也透传给引擎规范化源码。
    expect(mockEvaluateSource.mock.calls[0]![2].vocabulary).toMatchObject({ fields: [expect.objectContaining({ localized: 'alter' })] });
  });

  it('编辑词条后下一次执行立即按新词汇映射', async () => {
    mockLoadLive.mockResolvedValueOnce(deVocab());
    const before = await execute({ person: { lebensalter: 21 } });
    // 还没有这个同义词：键原样透传，引擎找不到字段。
    expect(mockEvaluateSource.mock.calls[0]![1]).toEqual({ person: { lebensalter: 21 } });
    expect(before.body.output.result).not.toBe(42);

    // 作者给 age 加同义词 lebensalter：下一次执行立即生效。
    mockLoadLive.mockResolvedValue(deVocab('alter', ['lebensalter']));
    const after = await execute({ person: { lebensalter: 21 } });
    expect(mockEvaluateSource.mock.calls[1]![1]).toEqual({ person: { age: 21 } });
    expect(after.body.output.result).toBe(42);
    expect(mockLoadLive).toHaveBeenCalledTimes(2);
  });

  it('作者无作用域内词汇时输入原样透传（与修复前一致）', async () => {
    mockLoadLive.mockResolvedValue(null);

    const { body } = await execute({ person: { alter: 21 } });

    expect(mockEvaluateSource.mock.calls[0]![1]).toEqual({ person: { alter: 21 } });
    expect(mockEvaluateSource.mock.calls[0]![2].vocabulary).toBeUndefined();
    expect(body.output.result).toBe(42);
  });
});
