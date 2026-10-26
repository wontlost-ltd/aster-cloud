// secure-execute（签名执行路径）关键词别名透传 + 哈希口径测试（ADR 0022 C1）。
//
// 修复前：executeSecurely 只把 locale/vocabulary 传执行端，丢弃 targetVersion.aliasSet
// → 别名策略经签名执行按无别名解析、编译失败；且哈希校验只用 sourceHash（不覆盖 aliasSet）。
// 本测试钉住：①冻结别名解析后透传 evaluateSource ②envelope 哈希接受 ③sourceHash 兼容接受
// ④损坏别名 JSON 安全降级。

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      policyVersions: { findFirst: vi.fn() },
      // ★2026-07-31 起 executeSecurely 会先做归属校验（assertPolicyOwnership），
      //   故必须桩上 policies.findFirst；返回非 null = 本测试的调用者是所有者。
      //   本文件测的是别名透传与哈希口径，不是归属，故一律放行。
      policies: { findFirst: vi.fn(async () => ({ id: 'p1' })) },
    },
  },
  policies: { id: {}, userId: {}, deletedAt: {} },
  policyVersions: { policyId: {}, version: {}, status: {}, isDefault: {} },
}));
vi.mock('@/services/security/policy-security', () => ({
  verifySignature: vi.fn(() => true),
  validateTimestamp: vi.fn(() => true),
}));
vi.mock('@/services/security/nonce-service', () => ({
  checkAndRecordNonce: vi.fn(async () => ({ valid: true })),
}));
vi.mock('@/services/security/security-event-service', () => ({
  logSecurityEvent: vi.fn(async () => {}),
}));
vi.mock('@/lib/domain-vocabulary-snapshot', () => ({
  loadExecutionVocabulary: vi.fn(async () => undefined),
}));
const mockEvaluateSource = vi.fn(
  async (
    _source: string,
    _input: Record<string, unknown>,
    _opts?: Record<string, unknown>,
  ): Promise<{ result: unknown; error: string | undefined }> => ({
    result: { allowed: true },
    error: undefined,
  }),
);
vi.mock('@/services/policy/policy-api', () => ({
  createPolicyApiClient: vi.fn(() => ({ evaluateSource: mockEvaluateSource })),
}));

import { executeSecurely } from '@/services/security/secure-executor';
import { db } from '@/lib/prisma';
import { loadExecutionVocabulary } from '@/lib/domain-vocabulary-snapshot';
import { computeSourceEnvelope } from '@/lib/policy-alias';

function version(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    policyId: 'p1',
    version: 3,
    source: 'Module X. Rule r given x as Int, produce Int: Return x multiplied by 2.',
    content: null,
    status: 'APPROVED',
    isDefault: true,
    sourceHash: 'HASH_SRC',
    sourceEnvelopeSha256: 'HASH_ENV',
    aliasSet: JSON.stringify({ TIMES: ['multiplied by'] }),
    vocabularySnapshotIds: null,
    policy: { id: 'p1', userId: 'user-1' },
    ...overrides,
  };
}

function opts(hash: string) {
  return {
    request: {
      policyId: 'p1',
      hash,
      input: { x: 5 },
      timestamp: 1_700_000_000_000,
      nonce: 'n1',
      signature: 'sig',
      version: 3,
    },
    userId: 'user-1',
    tenantId: 'user-1',
  } as Parameters<typeof executeSecurely>[0];
}

describe('executeSecurely — 别名透传 + 哈希口径（C1 secure-execute）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEvaluateSource.mockResolvedValue({ result: { allowed: true }, error: undefined });
  });

  it('冻结别名解析后透传 evaluateSource（envelope 哈希匹配）', async () => {
    vi.mocked(db.query.policyVersions.findFirst).mockResolvedValue(version() as never);

    const r = await executeSecurely(opts('HASH_ENV'));

    expect(r.success).toBe(true);
    expect(mockEvaluateSource).toHaveBeenCalledWith(
      expect.any(String),
      { x: 5 },
      expect.objectContaining({ aliasSet: { TIMES: ['multiplied by'] } }),
    );
  });

  it('兼容旧客户端：sourceHash 仍被接受', async () => {
    vi.mocked(db.query.policyVersions.findFirst).mockResolvedValue(version() as never);

    const r = await executeSecurely(opts('HASH_SRC'));

    expect(r.success).toBe(true);
    expect(mockEvaluateSource).toHaveBeenCalled();
  });

  it('哈希两者都不匹配 → HASH_MISMATCH', async () => {
    vi.mocked(db.query.policyVersions.findFirst).mockResolvedValue(version() as never);

    const r = await executeSecurely(opts('WRONG'));

    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('HASH_MISMATCH');
    expect(mockEvaluateSource).not.toHaveBeenCalled();
  });

  it('无别名版本（aliasSet=null）→ 不传 aliasSet', async () => {
    vi.mocked(db.query.policyVersions.findFirst).mockResolvedValue(
      version({ aliasSet: null }) as never,
    );

    await executeSecurely(opts('HASH_ENV'));

    const passedOpts = mockEvaluateSource.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(passedOpts.aliasSet).toBeUndefined();
  });

  it('损坏别名 JSON → 安全降级为无别名，不阻断执行', async () => {
    vi.mocked(db.query.policyVersions.findFirst).mockResolvedValue(
      version({ aliasSet: '{broken' }) as never,
    );

    const r = await executeSecurely(opts('HASH_ENV'));

    expect(r.success).toBe(true);
    const passedOpts = mockEvaluateSource.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(passedOpts.aliasSet).toBeUndefined();
  });

  // #602：locale 从源码识别（旧实现按快照 locale 推断，冻结多语言词汇时退回 en-US），
  // 词汇按版本冻结快照 + 策略作用域加载后透传。
  it('德语版本（无可匹配 envelope、快照 locale 不唯一）：locale 退到源码识别，透传作用域内冻结词汇', async () => {
    const source = 'Modul x.\n\nDefiniere Fahrer hat alter als Ganzzahl.\n';
    const refs = [
      { snapshotId: 's-de', domain: 'e2e1026', locale: 'de' },
      { snapshotId: 's-en', domain: 'e2etest', locale: 'en' },
    ];
    const frozen = { id: 'e2e1026', locale: 'de-DE', fields: [{ canonical: 'age', localized: 'alter' }] };
    vi.mocked(loadExecutionVocabulary).mockResolvedValueOnce(frozen);
    vi.mocked(db.query.policyVersions.findFirst).mockResolvedValue(
      version({ source, aliasSet: null, vocabularySnapshotIds: refs }) as never,
    );

    await executeSecurely(opts('HASH_ENV'));

    expect(loadExecutionVocabulary).toHaveBeenCalledWith(refs, { source, locale: 'de-DE' });
    const passedOpts = mockEvaluateSource.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(passedOpts.locale).toBe('de-DE');
    expect(passedOpts.vocabulary).toEqual(frozen);
  });

  // #626：签名按原始输入校验后，策略语言的字段名映射为规范名再交给引擎；与 execute 端点同口径。
  describe('#626 策略语言输入', () => {
    const source = `Modul e2e1027.vocab.

Definiere Fahrer hat alter als Ganzzahl.

Regel bewerten gegeben person als Fahrer liefert Ganzzahl:
  wenn person.alter mindestens 18:
    gib zurück 42.
  gib zurück 0.
`;
    const frozen = {
      id: 'e2e1027', locale: 'de-DE',
      structs: [{ canonical: 'Driver', localized: 'Fahrer', kind: 'struct' }],
      fields: [{ canonical: 'age', localized: 'alter', kind: 'field', parent: 'Driver' }],
      functions: [],
    };
    function withInput(input: unknown) {
      const o = opts('HASH_ENV');
      return { ...o, request: { ...o.request, input } };
    }

    beforeEach(() => {
      vi.mocked(loadExecutionVocabulary).mockResolvedValue(frozen);
      vi.mocked(db.query.policyVersions.findFirst).mockResolvedValue(
        version({ source, aliasSet: null, vocabularySnapshotIds: [{ snapshotId: 's', domain: 'e2e1027', locale: 'de' }] }) as never,
      );
    });

    it('本地化与规范输入都以规范名交给引擎', async () => {
      await executeSecurely(withInput({ person: { alter: 21 } }));
      await executeSecurely(withInput({ person: { age: 21 } }));

      expect(mockEvaluateSource.mock.calls[0]?.[1]).toEqual({ person: { age: 21 } });
      expect(mockEvaluateSource.mock.calls[1]?.[1]).toEqual({ person: { age: 21 } });
    });

    it('两者并存 → AMBIGUOUS_INPUT_FIELD，不调用引擎', async () => {
      const r = await executeSecurely(withInput({ person: { alter: 21, age: 30 } }));

      expect(r.success).toBe(false);
      expect(r.errorCode).toBe('AMBIGUOUS_INPUT_FIELD');
      expect(r.ambiguous).toMatchObject({ field: 'person.age', policyName: 'alter' });
      expect(mockEvaluateSource).not.toHaveBeenCalled();
    });
  });

  // #602 复审：locale 优先取版本保存时记录的编译 locale，旧版本执行口径不被源码启发式改变。
  it('locale 优先取 envelope 记录的编译 locale（即使源码看起来是德语）', async () => {
    const source = 'Modul x.\n\nDefiniere Fahrer hat alter als Ganzzahl.\n';
    const envelope = computeSourceEnvelope(source, null, 'en-US', 'tc-1');
    vi.mocked(db.query.policyVersions.findFirst).mockResolvedValue(
      version({
        source, aliasSet: null, sourceToolchainId: 'tc-1', sourceEnvelopeSha256: envelope,
        vocabularySnapshotIds: [{ snapshotId: 's-de', domain: 'e2e1026', locale: 'de' }],
      }) as never,
    );

    await executeSecurely(opts(envelope));

    const passedOpts = mockEvaluateSource.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(passedOpts.locale).toBe('en-US');
    expect(loadExecutionVocabulary).toHaveBeenCalledWith(expect.anything(), { source, locale: 'en-US' });
  });

  it('无可匹配 envelope 时沿用快照引用的唯一 locale（旧口径）', async () => {
    vi.mocked(db.query.policyVersions.findFirst).mockResolvedValue(
      version({
        aliasSet: null, sourceEnvelopeSha256: null,
        vocabularySnapshotIds: [{ snapshotId: 's-de', domain: 'e2e1026', locale: 'de' }],
      }) as never,
    );

    await executeSecurely(opts('HASH_SRC'));

    const passedOpts = mockEvaluateSource.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(passedOpts.locale).toBe('de');
  });
});
