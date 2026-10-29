import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCompile, mockLoadVocabulary } = vi.hoisted(() => ({
  mockCompile: vi.fn(),
  mockLoadVocabulary: vi.fn(),
}));

vi.mock('@/lib/domain-vocabulary-snapshot', () => ({
  loadLiveVocabularyForPolicy: mockLoadVocabulary,
}));

// PolicyApiError 真实类要用（instanceof 判 statusCode），只 mock compile 方法。
vi.mock('@/services/policy/policy-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/policy/policy-api')>();
  return {
    ...actual,
    createPolicyApiClient: vi.fn(() => ({ compile: mockCompile })),
  };
});

import { loadSaveVocabulary, makeCompileValidator } from '@/lib/policy-compile-validator';
import { vocabularyScopesJson } from '@/lib/policy-alias';
import { IdentifierKind } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
import { PolicyApiError } from '@/services/policy/policy-api';
import {
  assertCompilable,
  PolicyCompileError,
  PolicyCompileUnavailableError,
} from '@/services/policy/version-manager';

describe('makeCompileValidator / loadSaveVocabulary — 领域词汇（#602，ADR 0051 §7）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompile.mockResolvedValue({ success: true, diagnostics: [] });
  });
  const source = 'Modul x.\n\nDefiniere Fahrer hat alter als Ganzzahl.\n';
  const vocabulary = {
    id: 'e2e1026', name: 'e2e1026', locale: 'de-DE', version: '1',
    structs: [{ canonical: 'Driver', localized: 'Fahrer', kind: IdentifierKind.STRUCT }],
    fields: [{ canonical: 'age', localized: 'alter', kind: IdentifierKind.FIELD, parent: 'Driver' }],
    functions: [], enumValues: [],
  };

  it('按作者 + 源码 + 语言只加载一次，同一份词汇既算 envelope 词汇段也随编译请求发送', async () => {
    mockLoadVocabulary.mockResolvedValue(vocabulary);

    const save = await loadSaveVocabulary('u1', { source, locale: 'de-DE' });
    await makeCompileValidator('u1', save.vocabulary)({ source, locale: 'de-DE' });

    expect(mockLoadVocabulary).toHaveBeenCalledTimes(1);
    expect(mockLoadVocabulary).toHaveBeenCalledWith('u1', { source, locale: 'de-DE' });
    expect(save.scopesJson).toBe(vocabularyScopesJson(vocabulary));
    expect(save.scopesJson).not.toBe('');
    expect(mockCompile).toHaveBeenCalledWith(expect.objectContaining({ source, locale: 'de-DE', vocabulary }));
  });

  it('无作用域内词汇 → vocabulary 为 null、词汇段为空串', async () => {
    mockLoadVocabulary.mockResolvedValue(null);
    const save = await loadSaveVocabulary('u1', { source, locale: 'de-DE' });
    expect(save).toEqual({ vocabulary: null, scopesJson: '' });
    await makeCompileValidator('u1', save.vocabulary)({ source, locale: 'de-DE' });
    expect(mockCompile).toHaveBeenCalledWith(expect.objectContaining({ vocabulary: null }));
  });

  it('词汇加载失败 → 编译门禁与封印同一错误：编译检查暂不可用（503 可重试），不退化为无词汇', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockLoadVocabulary.mockRejectedValue(new Error('db down'));
    await expect(loadSaveVocabulary('u1', { source, locale: 'de-DE' })).rejects.toBeInstanceOf(
      PolicyCompileUnavailableError,
    );
    // 与编译服务不可用区分：界面据此提示「词汇暂时无法加载」
    await expect(loadSaveVocabulary('u1', { source, locale: 'de-DE' })).rejects.toMatchObject({
      unavailableCode: 'vocabulary_unavailable',
    });
    expect(mockCompile).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('词汇非法（枚举值缺 parent）→ 抛 VocabularyScopeError，不编译', async () => {
    mockLoadVocabulary.mockResolvedValue({
      ...vocabulary,
      enumValues: [{ canonical: 'High', localized: 'Hoch', kind: IdentifierKind.ENUM_VALUE }],
    });
    await expect(loadSaveVocabulary('u1', { source, locale: 'de-DE' })).rejects.toMatchObject({
      name: 'VocabularyScopeError',
      code: 'member_parent_required',
    });
    expect(mockCompile).not.toHaveBeenCalled();
  });
});

describe('makeCompileValidator — 异常分类', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadVocabulary.mockResolvedValue(null);
  });
  const input = { source: 'Module X.', locale: 'en-US' };

  it('成功 → 返回上游 diagnostics', async () => {
    mockCompile.mockResolvedValue({ success: false, diagnostics: [{ severity: 'error' }] });
    const v = makeCompileValidator('u1', null);
    const r = await v(input);
    expect(r.diagnostics).toEqual([{ severity: 'error' }]);
  });

  it('成功 → 透传编译响应中的 profile（供保存时落库）', async () => {
    mockCompile.mockResolvedValue({ success: true, diagnostics: [], profile: 'governed' });
    const r = await makeCompileValidator('u1', null)(input);
    expect(r.profile).toBe('governed');
  });

  it('上游 4xx（如 aliasSet 超限）→ 抛 PolicyCompileError（拒绝，不 fail-open）', async () => {
    mockCompile.mockRejectedValue(new PolicyApiError('alias_set_too_large', 400));
    const v = makeCompileValidator('u1', null);
    await expect(v(input)).rejects.toBeInstanceOf(PolicyCompileError);
  });

  it('上游 4xx 含错误诊断时保留 code、message 和起始位置', async () => {
    const diagnostics = [{
      severity: 'error',
      code: 'E001',
      message: 'Unexpected token',
      startLine: 3,
      startColumn: 8,
    }];
    mockCompile.mockRejectedValue(new PolicyApiError(
      'compile failed', 400, 'INVALID_SOURCE', undefined, { diagnostics },
    ));

    const caught = await makeCompileValidator('u1', null)(input).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(PolicyCompileError);
    expect((caught as PolicyCompileError).diagnostics).toMatchObject(diagnostics);
  });

  // #649：4xx 但只带 api 内部故障码 = 编译没做成，与 success:false 分支同口径（hasSourceError），不当源码错误拒绝
  it('上游 4xx 只有 COMPILE_INTERNAL_ERROR 诊断 → 抛普通错误（编译不可用），不是 PolicyCompileError', async () => {
    mockCompile.mockRejectedValue(new PolicyApiError('compile failed', 400, 'COMPILE_FAILED', undefined, {
      diagnostics: [{ severity: 'error', code: 'COMPILE_INTERNAL_ERROR', message: 'internal' }],
    }));
    const caught = await makeCompileValidator('u1', null)(input).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(PolicyCompileError);
  });

  it('上游 4xx 同时含源码错误与内部故障码 → 仍按源码错误拒绝', async () => {
    mockCompile.mockRejectedValue(new PolicyApiError('compile failed', 400, 'COMPILE_FAILED', undefined, {
      diagnostics: [
        { severity: 'error', code: 'COMPILE_INTERNAL_ERROR', message: 'internal' },
        { severity: 'error', code: 'E001', message: 'Unexpected token' },
      ],
    }));
    const caught = await makeCompileValidator('u1', null)(input).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(PolicyCompileError);
    expect((caught as PolicyCompileError).diagnostics?.map((d) => d.code)).toContain('E001');
  });

  it('上游 4xx 只有内部故障码、源码声明了档案 → assertCompilable 按不可用拒绝（503）', async () => {
    mockCompile.mockRejectedValue(new PolicyApiError('compile failed', 400, 'COMPILE_FAILED', undefined, {
      diagnostics: [{ severity: 'error', code: 'COMPILE_INTERNAL_ERROR', message: 'internal' }],
    }));
    const caught = await assertCompilable(
      makeCompileValidator('u1', null),
      { source: 'Module a.\nProfile "governed".\n', locale: 'en-US' },
    ).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(PolicyCompileUnavailableError);
  });

  it('上游 5xx → 原样上抛（由 createVersion fail-open）', async () => {
    const err = new PolicyApiError('server error', 503);
    mockCompile.mockRejectedValue(err);
    const v = makeCompileValidator('u1', null);
    await expect(v(input)).rejects.toBe(err);
  });

  it('408/TIMEOUT（超时）→ 原样上抛 fail-open，不当 4xx 用户错误拒绝', async () => {
    const err = new PolicyApiError('Request timeout', 408, 'TIMEOUT');
    mockCompile.mockRejectedValue(err);
    const v = makeCompileValidator('u1', null);
    // 不应被转成 PolicyCompileError（那会误拒合法保存）；原样上抛走 fail-open。
    await expect(v(input)).rejects.toBe(err);
  });

  it('408 回归：仍原样上抛，不转成任何 PolicyCompileError（含不可用）', async () => {
    const err = new PolicyApiError('Request timeout', 408, 'TIMEOUT');
    mockCompile.mockRejectedValue(err);
    const v = makeCompileValidator('u1', null);
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
    const v = makeCompileValidator('u1', null);
    const caught = await v(input).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(PolicyCompileUnavailableError);
    expect((caught as PolicyCompileUnavailableError).retryAfterSeconds).toBe(17);
    expect((caught as Error).message).not.toContain('解析错误');
  });

  it('429 且错误体无 retryAfter → 使用默认重试秒数', async () => {
    mockCompile.mockRejectedValue(new PolicyApiError('HTTP 429', 429));
    const v = makeCompileValidator('u1', null);
    const caught = await v(input).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(PolicyCompileUnavailableError);
    expect((caught as PolicyCompileUnavailableError).retryAfterSeconds).toBe(60);
  });

  it('网络/超时（非 PolicyApiError）→ 原样上抛', async () => {
    const err = new Error('network down');
    mockCompile.mockRejectedValue(err);
    const v = makeCompileValidator('u1', null);
    await expect(v(input)).rejects.toBe(err);
  });

  it('有别名时透传 aliasSet 给 client.compile', async () => {
    mockCompile.mockResolvedValue({ success: true, diagnostics: [] });
    const v = makeCompileValidator('u1', null);
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
    const caught = await makeCompileValidator('u1', null)(plain).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(PolicyCompileError);
  });

  it('success:false 带 error 诊断 → 照常返回诊断（由门禁按编译错误拒绝）', async () => {
    const diagnostics = [{ severity: 'error', message: 'bad' }];
    mockCompile.mockResolvedValue({ success: false, diagnostics });
    await expect(makeCompileValidator('u1', null)(plain)).resolves.toEqual({ diagnostics, profile: undefined });
  });

  it('声明了档案的源码 → assertCompilable 按不可用拒绝（503 compile_unavailable）', async () => {
    mockCompile.mockResolvedValue({ success: false, diagnostics: [] });
    const caught = await assertCompilable(makeCompileValidator('u1', null), profiled).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(PolicyCompileUnavailableError);
  });

  it('未声明档案的源码 → 维持现状放行', async () => {
    mockCompile.mockResolvedValue({ success: false, diagnostics: [] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(assertCompilable(makeCompileValidator('u1', null), plain)).resolves.toBeNull();
  });
});

describe('makeCompileValidator — 结构词授权透传（#604）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('allowStructural=true 时随 source/locale/aliasSet 一起传给 aster-api compile', async () => {
    mockCompile.mockResolvedValue({ success: true, diagnostics: [] });
    const aliasSet = { IF: ['provided that'] };
    await makeCompileValidator('u1', null)({
      source: 'Module X.',
      locale: 'en-US',
      aliasSet,
      allowStructural: true,
    });
    expect(mockCompile).toHaveBeenCalledWith({
      source: 'Module X.',
      locale: 'en-US',
      aliasSet,
      allowStructural: true,
      // 结构词授权与作用域内领域词汇（#602）并行透传；本用例无作用域词汇。
      vocabulary: null,
    });
  });

  it('assertCompilable 原样把 allowStructural 交给校验器', async () => {
    const validator = vi.fn().mockResolvedValue({ diagnostics: [] });
    await assertCompilable(validator, {
      source: 'Module X.',
      locale: 'en-US',
      aliasSet: { IF: ['provided that'] },
      allowStructural: true,
    });
    expect(validator).toHaveBeenCalledWith(expect.objectContaining({ allowStructural: true }));
  });
});
