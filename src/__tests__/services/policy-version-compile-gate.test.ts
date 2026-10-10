import { describe, it, expect, vi, beforeEach } from 'vitest';

// createVersion 的 compile 门禁在 DB 访问之前执行——error 路径不触达 DB。
// 为覆盖 pass/fail-open（会走到 DB insert），mock prisma 的 insert + query。
const { mockInsertReturning, mockVersionsFindFirst } = vi.hoisted(() => ({
  mockInsertReturning: vi.fn(),
  mockVersionsFindFirst: vi.fn(),
}));

vi.mock('@/lib/prisma', () => {
  const insert = vi.fn(() => ({
    values: vi.fn(() => ({ returning: mockInsertReturning })),
  }));
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
    await expect(assertCompilable(v, input)).resolves.toBeUndefined();
  });

  it('无 error 诊断 → 放行', async () => {
    const v: CompileValidator = vi
      .fn()
      .mockResolvedValue({ diagnostics: [{ severity: 'warning' }] });
    await expect(assertCompilable(v, input)).resolves.toBeUndefined();
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
    ).resolves.toBeUndefined();
  });
});
