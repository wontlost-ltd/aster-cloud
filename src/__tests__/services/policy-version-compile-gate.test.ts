import { describe, it, expect, vi, beforeEach } from 'vitest';

// createVersion 的 compile 门禁在 DB 访问之前执行——error 路径不触达 DB。
// 为覆盖 pass/fail-open（会走到 DB insert），mock prisma 的 insert + query。
const { mockInsertReturning, mockInsertValues, mockVersionsFindFirst } = vi.hoisted(() => {
  const mockInsertReturning = vi.fn();
  return {
    mockInsertReturning,
    mockInsertValues: vi.fn(() => ({ returning: mockInsertReturning })),
    mockVersionsFindFirst: vi.fn(),
  };
});

vi.mock('@/lib/prisma', () => {
  const insert = vi.fn(() => ({ values: mockInsertValues }));
  return {
    db: {
      insert,
      query: { policyVersions: { findFirst: mockVersionsFindFirst } },
    },
    policyVersions: {
      policyId: {},
      version: {},
      sourceHash: {},
      sourceEnvelopeSha256: {},
    },
    policyApprovals: {},
  };
});

vi.mock('@/lib/metrics/aha-detection', () => ({
  recordAhaMomentIfFirst: vi.fn().mockResolvedValue(undefined),
}));

import {
  createVersion,
  assertCompilable,
  PolicyCompileError,
  PolicyCompileUnavailableError,
  type CompileValidator,
} from '@/services/policy/version-manager';

const baseParams = {
  policyId: 'p1',
  source: 'Module X.',
  createdBy: 'u1',
  locale: 'en-US',
};

describe('createVersion — 源码可编译性门禁', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVersionsFindFirst.mockResolvedValue(null);
    mockInsertReturning.mockResolvedValue([
      { id: 'v1', version: 1, sourceHash: 'h', sourceEnvelopeSha256: 'e' },
    ]);
  });

  it('有 error 诊断 → 抛 PolicyCompileError，不落库', async () => {
    const validateCompilable: CompileValidator = vi.fn().mockResolvedValue({
      diagnostics: [{ severity: 'error' }],
    });
    await expect(
      createVersion({ ...baseParams, validateCompilable }),
    ).rejects.toBeInstanceOf(PolicyCompileError);
    expect(mockInsertReturning).not.toHaveBeenCalled();
  });

  it('仅 warning 诊断 → 放行落库', async () => {
    const validateCompilable: CompileValidator = vi.fn().mockResolvedValue({
      diagnostics: [{ severity: 'warning' }],
    });
    const r = await createVersion({ ...baseParams, validateCompilable });
    expect(r.version).toBe(1);
    expect(mockInsertReturning).toHaveBeenCalled();
  });

  it('校验器传入的 aliasSet 与 source/locale 一致（前后端语义对齐）', async () => {
    const validateCompilable = vi
      .fn()
      .mockResolvedValue({ diagnostics: [] }) as unknown as CompileValidator;
    const aliasSet = { TIMES: ['multiplied by'] };
    await createVersion({
      ...baseParams,
      aliasSet,
      aliasReserved: {
        canonicalKeywordsLower: new Set<string>(),
        baseAliasesLower: new Set<string>(),
        vocabularyTermsLower: new Set<string>(),
      },
      validateCompilable,
    });
    expect(validateCompilable).toHaveBeenCalledWith({
      source: 'Module X.',
      locale: 'en-US',
      aliasSet,
    });
  });

  it('校验器自身抛异常（编译服务不可达）→ fail-open 放行落库', async () => {
    const validateCompilable: CompileValidator = vi
      .fn()
      .mockRejectedValue(new Error('aster-api unreachable'));
    const r = await createVersion({ ...baseParams, validateCompilable });
    expect(r.version).toBe(1);
    expect(mockInsertReturning).toHaveBeenCalled();
  });

  it('校验器抛 PolicyCompileUnavailableError（上游限流）→ fail-closed，不落库', async () => {
    const validateCompilable: CompileValidator = vi
      .fn()
      .mockRejectedValue(new PolicyCompileUnavailableError(30));
    await expect(
      createVersion({ ...baseParams, validateCompilable }),
    ).rejects.toBeInstanceOf(PolicyCompileUnavailableError);
    expect(mockInsertReturning).not.toHaveBeenCalled();
  });

  it('未提供 validateCompilable → 不校验（向后兼容），正常落库', async () => {
    const r = await createVersion(baseParams);
    expect(r.version).toBe(1);
    expect(mockInsertReturning).toHaveBeenCalled();
  });
});

describe('assertCompilable — 事务外 preflight', () => {
  const input = { source: 'Module X.', locale: 'en-US' };

  it('有 error 诊断 → 抛 PolicyCompileError', async () => {
    const v: CompileValidator = vi
      .fn()
      .mockResolvedValue({ diagnostics: [{ severity: 'error' }] });
    await expect(assertCompilable(v, input)).rejects.toBeInstanceOf(
      PolicyCompileError,
    );
  });

  it('校验器抛 PolicyCompileError（如上游 4xx）→ 上抛拒绝', async () => {
    const v: CompileValidator = vi
      .fn()
      .mockRejectedValue(new PolicyCompileError('bad input'));
    await expect(assertCompilable(v, input)).rejects.toBeInstanceOf(
      PolicyCompileError,
    );
  });

  it('校验器抛其它异常（5xx/网络）→ fail-open 不抛', async () => {
    const v: CompileValidator = vi
      .fn()
      .mockRejectedValue(new Error('503 unavailable'));
    await expect(assertCompilable(v, input)).resolves.toBeNull();
  });

  it('无 error 诊断 → 放行', async () => {
    const v: CompileValidator = vi
      .fn()
      .mockResolvedValue({ diagnostics: [{ severity: 'warning' }] });
    await expect(assertCompilable(v, input)).resolves.toBeNull();
  });
});

describe('assertCompilable — 治理档案诊断（ADR 0046 §4）', () => {
  it('E705（severity error）→ 抛 PolicyCompileError', async () => {
    const validator: CompileValidator = vi.fn().mockResolvedValue({
      diagnostics: [{ severity: 'error', code: 'E705' }],
    });
    await expect(
      assertCompilable(validator, { source: 'Module X.', locale: 'en-US' }),
    ).rejects.toBeInstanceOf(PolicyCompileError);
  });

  it('只含 W700（warning）→ 不抛', async () => {
    const validator: CompileValidator = vi.fn().mockResolvedValue({
      diagnostics: [{ severity: 'warning', code: 'W700' }],
    });
    await expect(
      assertCompilable(validator, { source: 'Module X.', locale: 'en-US' }),
    ).resolves.toBeNull();
  });

  it('E706 → 抛档案专用文案，并附首条档案诊断消息', async () => {
    const validator: CompileValidator = vi.fn().mockResolvedValue({
      diagnostics: [
        { severity: 'warning', code: 'W700', message: 'warn' },
        { severity: 'error', code: 'E706', message: 'rule r lacks EU_AI_ACT control' },
        { severity: 'error', code: 'E705', message: 'second' },
      ],
    });
    const caught = await assertCompilable(validator, {
      source: 'Module X.',
      locale: 'en-US',
    }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(PolicyCompileError);
    const message = (caught as Error).message;
    expect(message).not.toContain('解析错误');
    expect(message).toContain('治理档案');
    expect(message).toContain('rule r lacks EU_AI_ACT control');
    expect(message).not.toContain('second');
  });

  it('档案码与普通解析错误并存 → 仍用档案文案（取档案码的诊断）', async () => {
    const validator: CompileValidator = vi.fn().mockResolvedValue({
      diagnostics: [
        { severity: 'error', code: 'E001', message: 'syntax' },
        { severity: 'error', code: 'E705', message: 'unknown profile "X"' },
      ],
    });
    const caught = await assertCompilable(validator, {
      source: 'Module X.',
      locale: 'en-US',
    }).catch((e: unknown) => e);
    expect((caught as Error).message).toContain('unknown profile "X"');
    expect((caught as Error).message).not.toContain('syntax');
  });

  it('无档案码的 error → 仍是默认解析错误文案', async () => {
    const validator: CompileValidator = vi.fn().mockResolvedValue({
      diagnostics: [{ severity: 'error', code: 'E001', message: 'syntax' }],
    });
    const caught = await assertCompilable(validator, {
      source: 'Module X.',
      locale: 'en-US',
    }).catch((e: unknown) => e);
    expect((caught as Error).message).toBe(new PolicyCompileError().message);
  });

  it('上游不可用（PolicyCompileUnavailableError）→ 上抛，不 fail-open', async () => {
    const validator: CompileValidator = vi
      .fn()
      .mockRejectedValue(new PolicyCompileUnavailableError(5));
    await expect(
      assertCompilable(validator, { source: 'Module X.', locale: 'en-US' }),
    ).rejects.toBeInstanceOf(PolicyCompileUnavailableError);
  });
});

describe('治理档案落库（ADR 0046 §6）：取自保存时的编译结果', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVersionsFindFirst.mockResolvedValue(null);
    mockInsertReturning.mockResolvedValue([
      { id: 'v1', version: 1, sourceHash: 'h', sourceEnvelopeSha256: 'e' },
    ]);
  });

  const input = { source: 'Module X.', locale: 'en-US' };

  it('assertCompilable 返回编译响应中的 profile', async () => {
    const v: CompileValidator = vi
      .fn()
      .mockResolvedValue({ diagnostics: [], profile: 'governed' });
    await expect(assertCompilable(v, input)).resolves.toBe('governed');
  });

  it('编译响应不带 profile → 返回 null', async () => {
    const v: CompileValidator = vi.fn().mockResolvedValue({ diagnostics: [] });
    await expect(assertCompilable(v, input)).resolves.toBeNull();
  });

  it('createVersion 自跑门禁时把编译得到的 profile 写入版本行', async () => {
    const validateCompilable: CompileValidator = vi
      .fn()
      .mockResolvedValue({ diagnostics: [], profile: 'eu-ai-act-high-risk' });
    await createVersion({ ...baseParams, validateCompilable });
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ profile: 'eu-ai-act-high-risk' }),
    );
  });

  it('调用方事务外已跑门禁时传入 profile，原样写入', async () => {
    await createVersion({ ...baseParams, profile: 'governed' });
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ profile: 'governed' }),
    );
  });

  it('未声明档案或未编译 → profile 写 null', async () => {
    await createVersion(baseParams);
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ profile: null }),
    );
  });
});
