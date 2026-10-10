import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCompile } = vi.hoisted(() => ({ mockCompile: vi.fn() }));

// PolicyApiError 真实类要用（instanceof 判 statusCode），只 mock compile 方法。
vi.mock('@/services/policy/policy-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/policy/policy-api')>();
  return {
    ...actual,
    createPolicyApiClient: vi.fn(() => ({ compile: mockCompile })),
  };
});

import { makeCompileValidator } from '@/lib/policy-compile-validator';
import { PolicyApiError } from '@/services/policy/policy-api';
import {
  assertCompilable,
  PolicyCompileError,
  PolicyCompileUnavailableError,
} from '@/services/policy/version-manager';

describe('makeCompileValidator — 异常分类', () => {
  beforeEach(() => vi.clearAllMocks());
  const input = { source: 'Module X.', locale: 'en-US' };

  it('成功 → 返回上游 diagnostics', async () => {
    mockCompile.mockResolvedValue({ success: false, diagnostics: [{ severity: 'error' }] });
    const v = makeCompileValidator('u1');
    const r = await v(input);
    expect(r.diagnostics).toEqual([{ severity: 'error' }]);
  });

  it('成功 → 透传编译响应中的 profile（供保存时落库）', async () => {
    mockCompile.mockResolvedValue({ success: true, diagnostics: [], profile: 'governed' });
    const r = await makeCompileValidator('u1')(input);
    expect(r.profile).toBe('governed');
  });

  it('上游 4xx（如 aliasSet 超限）→ 抛 PolicyCompileError（拒绝，不 fail-open）', async () => {
    mockCompile.mockRejectedValue(new PolicyApiError('alias_set_too_large', 400));
    const v = makeCompileValidator('u1');
    await expect(v(input)).rejects.toBeInstanceOf(PolicyCompileError);
  });

  it('上游 5xx → 原样上抛（由 createVersion fail-open）', async () => {
    const err = new PolicyApiError('server error', 503);
    mockCompile.mockRejectedValue(err);
    const v = makeCompileValidator('u1');
    await expect(v(input)).rejects.toBe(err);
  });

  it('408/TIMEOUT（超时）→ 原样上抛 fail-open，不当 4xx 用户错误拒绝', async () => {
    const err = new PolicyApiError('Request timeout', 408, 'TIMEOUT');
    mockCompile.mockRejectedValue(err);
    const v = makeCompileValidator('u1');
    // 不应被转成 PolicyCompileError（那会误拒合法保存）；原样上抛走 fail-open。
    await expect(v(input)).rejects.toBe(err);
  });

  it('408 回归：仍原样上抛，不转成任何 PolicyCompileError（含不可用）', async () => {
    const err = new PolicyApiError('Request timeout', 408, 'TIMEOUT');
    mockCompile.mockRejectedValue(err);
    const v = makeCompileValidator('u1');
    const caught = await v(input).catch((e: unknown) => e);
    expect(caught).toBe(err);
    expect(caught).not.toBeInstanceOf(PolicyCompileError);
  });

  it('429（限流）→ 抛 PolicyCompileUnavailableError，带上游 retryAfter，不是解析错误', async () => {
    mockCompile.mockRejectedValue(
      new PolicyApiError('Too Many Requests', 429, 'Too Many Requests', undefined, {
        error: 'Too Many Requests',
        retryAfter: 17,
      }),
    );
    const v = makeCompileValidator('u1');
    const caught = await v(input).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(PolicyCompileUnavailableError);
    expect((caught as PolicyCompileUnavailableError).retryAfterSeconds).toBe(17);
    expect((caught as Error).message).not.toContain('解析错误');
  });

  it('429 且错误体无 retryAfter → 使用默认重试秒数', async () => {
    mockCompile.mockRejectedValue(new PolicyApiError('HTTP 429', 429));
    const v = makeCompileValidator('u1');
    const caught = await v(input).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(PolicyCompileUnavailableError);
    expect((caught as PolicyCompileUnavailableError).retryAfterSeconds).toBe(60);
  });

  it('网络/超时（非 PolicyApiError）→ 原样上抛', async () => {
    const err = new Error('network down');
    mockCompile.mockRejectedValue(err);
    const v = makeCompileValidator('u1');
    await expect(v(input)).rejects.toBe(err);
  });

  it('有别名时透传 aliasSet 给 client.compile', async () => {
    mockCompile.mockResolvedValue({ success: true, diagnostics: [] });
    const v = makeCompileValidator('u1');
    await v({ ...input, aliasSet: { TIMES: ['multiplied by'] } });
    expect(mockCompile).toHaveBeenCalledWith(
      expect.objectContaining({ aliasSet: { TIMES: ['multiplied by'] } }),
    );
  });
});

// success:false 却没有 error 诊断 = 上游没把编译做成（兜底异常），不是「源码没有错误」。
describe('makeCompileValidator — success:false 且无 error 诊断视为编译不可用', () => {
  beforeEach(() => vi.clearAllMocks());
  const profiled = { source: 'Module a.\nProfile "governed".\n', locale: 'en-US' };
  const plain = { source: 'Module a.\n', locale: 'en-US' };

  it.each([
    ['空诊断', { success: false, diagnostics: [] }],
    ['缺 diagnostics 字段', { success: false }],
    ['只有 warning', { success: false, diagnostics: [{ severity: 'warning', code: 'W600' }] }],
  ])('%s → 抛非 PolicyCompileError 的普通错误', async (_name, response) => {
    mockCompile.mockResolvedValue(response);
    const caught = await makeCompileValidator('u1')(plain).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(PolicyCompileError);
  });

  it('success:false 带 error 诊断 → 照常返回诊断（由门禁按编译错误拒绝）', async () => {
    const diagnostics = [{ severity: 'error', message: 'bad' }];
    mockCompile.mockResolvedValue({ success: false, diagnostics });
    await expect(makeCompileValidator('u1')(plain)).resolves.toEqual({ diagnostics, profile: undefined });
  });

  it('声明了档案的源码 → assertCompilable 按不可用拒绝（503 compile_unavailable）', async () => {
    mockCompile.mockResolvedValue({ success: false, diagnostics: [] });
    const caught = await assertCompilable(makeCompileValidator('u1'), profiled).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(PolicyCompileUnavailableError);
  });

  it('未声明档案的源码 → 维持现状放行', async () => {
    mockCompile.mockResolvedValue({ success: false, diagnostics: [] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(assertCompilable(makeCompileValidator('u1'), plain)).resolves.toBeNull();
  });
});
