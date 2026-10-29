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
  // envelope 反推编译 locale 用的按 locale 词汇来源（本测试的 envelope 词汇段均为空）
  loadFrozenVocabularyForSource: async () => () => null,
  loadLiveVocabularyForSource: async () => () => null,
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
    const envelope = computeSourceEnvelope(DE_POLICY, null, 'en-US', 'tc-1', '');
    mockFindVersions.mockResolvedValue(versions('APPROVED', { sourceEnvelopeSha256: envelope }));
    mockDbExecute.mockResolvedValue([policyRow(DE_POLICY, { toolchainId: 'tc-1' })]);
    mockEvaluateSource.mockResolvedValue({ result: 0, executionTimeMs: 1, error: null });
    // 只验证 locale 选择：不带词汇（德语源码按 en-US 带词汇提取类型会失败，那是另一条用例）。
    mockLoadFrozen.mockResolvedValue(undefined);

    await execute({ person: { alter: 21 } });

    expect(mockLoadFrozen).toHaveBeenCalledWith(FROZEN_REFS, { source: DE_POLICY, locale: 'en-US' });
    expect(mockEvaluateSource.mock.calls[0]![2].locale).toBe('en-US');
  });
});

// #638 生产复现的词汇与源码：struct Driver↔Fahrer、Level↔Stufe，字段 age↔alter、rank↔niveau，
// 枚举值 High↔Hoch / Low↔Niedrig（字段规范名用 rank，避开只差大小写的组合，见 aster-lang-ts#243）。
function de638Vocab() {
  const row = (kind: string, canonical: string, localized: string, parentCanonical: string | null = null) =>
    ({ domainTermId: `${kind}-${canonical}`, domain: 'e2e1029', locale: 'de', kind, canonical, localized, parentCanonical });
  return assembleDomainVocabularyFromLinks(
    [
      row('struct', 'Driver', 'Fahrer'),
      row('struct', 'Level', 'Stufe'),
      row('field', 'age', 'alter', 'Driver'),
      row('field', 'rank', 'niveau', 'Driver'),
      row('enum_value', 'High', 'Hoch', 'Level'),
      row('enum_value', 'Low', 'Niedrig', 'Level'),
    ],
    { domain: 'e2e1029', locale: 'de-DE' },
  ) as unknown as Record<string, unknown>;
}

const POLICY_638_HEAD = `Modul e2e1029.vocab.

Definiere Stufe als eines von Hoch, Niedrig.

Definiere Fahrer hat alter als Ganzzahl, niveau als Stufe.

Regel einstufen gegeben person als Fahrer liefert Stufe:
  gib zurück person.niveau.
`;

// 构造表达式（执行端与 TS 解析器都支持的 `mit f setze auf v` 写法）。
const POLICY_638 = `${POLICY_638_HEAD}
Regel bauen gegeben person als Fahrer liefert Fahrer:
  gib zurück Fahrer mit alter setze auf person.alter und niveau setze auf Niedrig.
`;

// 生产源码里的 `mit f = v` 写法：TS 解析器不认这种函数体，修复前整份策略的类型提取失败、输入映射被静默跳过。
const POLICY_638_EQUALS = `${POLICY_638}
Regel nachbauen gegeben person als Fahrer liefert Fahrer:
  gib zurück Fahrer mit alter = person.alter, niveau = Niedrig.
`;

async function executeRule(input: unknown, functionName: string) {
  const res = await POST(
    new Request('http://localhost/api/policies/p1/execute', {
      method: 'POST',
      body: JSON.stringify({ input, functionName }),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ id: 'p1' }) },
  );
  return { status: res.status, body: await res.json() };
}

describe('POST /api/policies/[id]/execute — 类型提取与执行同一词汇（#638）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: 'owner-1' } });
    mockEvaluateSource.mockImplementation(evaluateWithTsEngine);
    mockFindVersions.mockResolvedValue(versions('APPROVED'));
    mockLoadFrozen.mockResolvedValue(de638Vocab());
    mockLoadLive.mockResolvedValue(null);
  });

  it('构造表达式 + 本地化输入：引擎收到规范输入，执行成功，结果按策略语言还原', async () => {
    mockDbExecute.mockResolvedValue([policyRow(POLICY_638)]);

    const { status, body } = await executeRule({ person: { alter: 35, niveau: 'Hoch' } }, 'bauen');

    expect(status).toBe(200);
    expect(mockEvaluateSource.mock.calls[0]![1]).toEqual({ person: { age: 35, rank: 'High' } });
    expect(storedExecutionInput()).toEqual({ person: { age: 35, rank: 'High' } });
    expect(body.output.error ?? null).toBeNull();
    expect(body.localizedResult).toMatchObject({ alter: 35, niveau: expect.anything() });
  });

  it('同一策略里有 TS 解析器不支持的函数体（`mit f = v`）：其它规则照常映射输入并执行成功', async () => {
    mockDbExecute.mockResolvedValue([policyRow(POLICY_638_EQUALS)]);
    // 执行端替身只回显：TS 解析器编不了整份源码，这里验证的是映射本身（修复前是原样透传）。
    mockEvaluateSource.mockResolvedValue({ result: 'High', executionTimeMs: 1, error: null });

    const { status, body } = await executeRule({ person: { alter: 35, niveau: 'Hoch' } }, 'einstufen');

    expect(status).toBe(200);
    expect(mockEvaluateSource.mock.calls[0]![1]).toEqual({ person: { age: 35, rank: 'High' } });
    expect(body.localizedResult).toBe('Hoch');
  });

  it('`mit f = v` 那条规则自身的签名也能取到：输入同样映射为规范名', async () => {
    mockDbExecute.mockResolvedValue([policyRow(POLICY_638_EQUALS)]);
    mockEvaluateSource.mockResolvedValue({ result: { age: 35, rank: 'Low' }, executionTimeMs: 1, error: null });

    const { status, body } = await executeRule({ person: { alter: 35, niveau: 'Hoch' } }, 'nachbauen');

    expect(status).toBe(200);
    expect(mockEvaluateSource.mock.calls[0]![1]).toEqual({ person: { age: 35, rank: 'High' } });
    expect(body.localizedResult).toEqual({ alter: 35, niveau: 'Niedrig' });
  });

  it('连签名都解析不了：422 input_type_extraction_failed，不调用引擎、不落库、不静默透传', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockDbExecute.mockResolvedValue([policyRow('Modul kaputt.\n\nRegel gegeben Fahrer liefert:\n  gib zurück 1.\n')]);

    const { status, body } = await executeRule({ person: { alter: 35 } }, 'einstufen');

    expect(status).toBe(422);
    expect(body.code).toBe('input_type_extraction_failed');
    expect(mockEvaluateSource).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refusing to execute'), expect.anything());
    warn.mockRestore();
  });

  it('未指定 Rule、只有一条 Rule：按这条 Rule 的参数映射输入', async () => {
    mockDbExecute.mockResolvedValue([policyRow(POLICY_638_HEAD)]);
    mockEvaluateSource.mockResolvedValue({ result: 'High', executionTimeMs: 1, error: null });

    const { status } = await execute({ person: { alter: 35, niveau: 'Hoch' } });

    expect(status).toBe(200);
    expect(mockEvaluateSource.mock.calls[0]![1]).toEqual({ person: { age: 35, rank: 'High' } });
  });

  it('未指定 Rule、多条 Rule 且无 @entry：422 entry_rule_required 并列出可选 Rule，不按空参数映射执行', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockDbExecute.mockResolvedValue([policyRow(POLICY_638)]);

    const { status, body } = await execute({ person: { alter: 35, niveau: 'Hoch' } });

    expect(status).toBe(422);
    expect(body).toMatchObject({ code: 'entry_rule_required', rules: ['einstufen', 'bauen'] });
    expect(mockEvaluateSource).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
    vi.mocked(console.warn).mockRestore();
  });

  it('无词汇的策略不做类型提取，源码无法解析也照常交给引擎（行为不变）', async () => {
    mockLoadFrozen.mockResolvedValue(undefined);
    mockDbExecute.mockResolvedValue([policyRow('Modul kaputt.\n\nRegel gegeben Fahrer liefert:\n  gib zurück 1.\n')]);
    mockEvaluateSource.mockResolvedValue({ result: null, executionTimeMs: 1, error: 'compile failed' });

    await executeRule({ person: { alter: 35 } }, 'einstufen');

    expect(mockEvaluateSource).toHaveBeenCalledTimes(1);
  });

  it('#639：规则直接返回输入结构时，cloud 原样透传引擎结果并按策略语言还原', async () => {
    mockDbExecute.mockResolvedValue([policyRow(`${POLICY_638}
Regel echo gegeben person als Fahrer liefert Fahrer:
  gib zurück person.
`)]);

    const { status, body } = await executeRule({ person: { alter: 35, niveau: 'Hoch' } }, 'echo');

    expect(status).toBe(200);
    expect(body.output.result).toMatchObject({ age: 35, rank: 'High' });
    expect(body.localizedResult).toMatchObject({ alter: 35, niveau: 'Hoch' });
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

  it('版本没有作者时不带词汇（审批冻结此时同样不冻结任何词汇），不回退到所有者，并留调试日志', async () => {
    mockFindVersions.mockResolvedValue(versions('DRAFT', { createdBy: null }));
    mockLoadLive.mockResolvedValue(deVocab());
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    await execute({ person: { alter: 21 } });

    expect(debug).toHaveBeenCalledWith(expect.stringContaining('has no author'));
    debug.mockRestore();

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
