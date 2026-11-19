// ADR 0060 §6.3–6.7 / 计划 T9：三条保存路由的 embeddedVocabulary 三态（与同一路由的 aliasSet 一致）、
// 400 错误码、上限、vocabularyShadowed、编译门禁收到合并词汇、不设能力 / 套餐门。
// 真实：路由、loadSaveVocabulary（校验 + 合并 + 封印词汇段）、makeCompileValidator、别名占用集。
// 替身：会话、DB、建版本（createVersion）、下层词汇加载与 aster-api 编译客户端（记录请求，不访问网络）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentifierKind, type DomainVocabulary } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';

const h = vi.hoisted(() => {
  const returning = vi.fn();
  const tx = {
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning })) })) })),
  };
  return {
    returning,
    tx,
    createVersion: vi.fn(),
    compile: vi.fn(),
    live: vi.fn(),
    resolveEntitlement: vi.fn(),
    activeVersionFindFirst: vi.fn(),
  };
});

vi.mock('@/lib/auth', () => ({ getSession: vi.fn(async () => ({ user: { id: 'user-1' } })) }));
vi.mock('@/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'user-1' } })) }));
vi.mock('@/services/policy/version-manager', () => {
  class PolicyCompileError extends Error {
    constructor(message: string, readonly diagnostics: unknown[] = []) {
      super(message);
    }
  }
  class PolicyCompileUnavailableError extends PolicyCompileError {
    constructor(readonly retryAfterSeconds: number, message = 'unavailable', readonly unavailableCode = 'compile_unavailable') {
      super(message);
    }
  }
  return {
    createVersion: h.createVersion,
    // 与真实 assertCompilable 同义的最小实现：有 error 诊断即拒绝
    assertCompilable: vi.fn(async (validator: (i: unknown) => Promise<{ diagnostics?: Array<{ severity: string }> }>, input: unknown) => {
      const result = await validator(input);
      if ((result.diagnostics ?? []).some((d) => d.severity === 'error')) throw new PolicyCompileError('compile error');
      return null;
    }),
    listVersions: vi.fn(),
    listExecutableVersions: vi.fn(),
    PolicyCompileError,
    PolicyCompileUnavailableError,
    DEFAULT_COMPILE_RETRY_AFTER_SECONDS: 5,
    VOCABULARY_UNAVAILABLE_CODE: 'vocabulary_unavailable',
  };
});
vi.mock('@/services/policy/policy-api', () => ({
  createPolicyApiClient: vi.fn(() => ({ compile: h.compile })),
  PolicyApiError: class PolicyApiError extends Error {},
}));
vi.mock('@/lib/domain-vocabulary-snapshot', () => ({ loadLiveVocabularyWithOrigins: h.live }));
vi.mock('@/db/fresh-read', () => ({ freshDb: {} }));
vi.mock('@/lib/structural-alias-grants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/structural-alias-grants')>()),
  getStructuralAliasGrant: vi.fn(async () => false),
}));
vi.mock('@/lib/capabilities/resolve', () => ({ resolveEntitlement: h.resolveEntitlement }));
vi.mock('@/lib/policy-layout/store', async () =>
  (await import('@/__tests__/helpers/policy-layout-store-mock')).policyLayoutStoreModule());
vi.mock('@/lib/policy-freeze', () => ({
  isPolicyFrozen: vi.fn(async () => ({ isFrozen: false })),
  getPolicyFreezeStatus: vi.fn(),
}));
vi.mock('@/lib/cache', () => ({ invalidatePolicyCache: vi.fn(async () => undefined) }));
vi.mock('@/lib/product-events/server', () => ({ recordProductEventAfterResponse: vi.fn() }));
vi.mock('@/services/pii/detector', () => ({ detectPII: vi.fn(() => ({ detectedTypes: [] })) }));
vi.mock('@/lib/policy-access', async () =>
  (await import('@/__tests__/helpers/policy-access-mock')).policyAccessModule());
vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      users: { findFirst: vi.fn(async () => undefined) },
      policyVersions: { findFirst: h.activeVersionFindFirst },
      policies: { findFirst: vi.fn() },
    },
    execute: vi.fn(async () => [{ test: 1 }]),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(h.tx)),
  },
  policies: { id: {}, userId: {}, deletedAt: {}, isPublic: {}, version: {} },
  policyVersions: { policyId: {}, version: {} },
  policyGroups: { id: {}, userId: {} },
  executions: { policyId: {} },
  users: { id: {} },
  structuralAliasGrants: {},
}));

import { POST as POST_POLICY } from '@/app/api/policies/route';
import { PUT } from '@/app/api/policies/[id]/route';
import { POST as POST_VERSION } from '@/app/api/v1/policies/[id]/versions/route';
import { policyAccessState } from '@/__tests__/helpers/policy-access-mock';
import { vocabularyOriginKey } from '@/lib/domain-vocabulary-team-merge';
import { canonicalAliasJson, vocabularyScopesJson } from '@/lib/policy-alias';
import {
  serializeEmbeddedVocabulary,
  storedEmbeddedVocabulary,
  type EmbeddedTerm,
  type EmbeddedVocabulary,
} from '@/lib/policy-embedded-vocabulary';

const LOCALE = 'zh-CN';
/** 《静夜思》的规范关键词写法（v1 别名规则下结构词不能用汉字单词别名，见 ADR 0060 §5）。 */
const SOURCE = '模块 明月光。\n规则 地上霜，产出 望明月：\n  返回 思故乡。';
/** ADR §8 的内嵌词汇（规范序列化）。 */
const POEM_TEXT = '{"v":1,"terms":[{"kind":"literal","localized":"思故乡","canonical":"静夜思"},{"kind":"struct","localized":"望明月","canonical":"Text"}]}';
const POEM: EmbeddedVocabulary = JSON.parse(POEM_TEXT);
/** 活跃版本（v3）的内嵌词汇：只有字面量。 */
const ACTIVE_TEXT = '{"v":1,"terms":[{"kind":"literal","localized":"思故乡","canonical":"静夜思"}]}';
const ACTIVE_ALIAS = { TIMES: ['乘 以'] };
const SUBMITTED_ALIAS = { TIMES: ['相 乘'] };

/**
 * 下层（团队 + 作者）作用域内词汇：团队 struct 思故乡→Home 撞内嵌字面量触发词，作者 struct 望明月→Moon
 * 与内嵌 struct 同角色键而规范名不同——两者都被遮蔽；作者 struct 明月光→Moonlight 保留。
 */
const TEAM_HOME = { canonical: 'Home', localized: '思故乡', kind: IdentifierKind.STRUCT };
const AUTHOR_MOON = { canonical: 'Moon', localized: '望明月', kind: IdentifierKind.STRUCT };
const AUTHOR_LIGHT = { canonical: 'Moonlight', localized: '明月光', kind: IdentifierKind.STRUCT };
const LOWER: DomainVocabulary = {
  id: 'poem', name: 'poem', locale: LOCALE, version: 'user',
  structs: [TEAM_HOME, AUTHOR_MOON, AUTHOR_LIGHT], fields: [], functions: [], enumValues: [],
};

const POLICY_ROW = { id: 'p1', userId: 'user-1', teamId: 'team-1', name: 'p', content: SOURCE, version: 3, isPublic: false };

function json(url: string, method: string, body: Record<string, unknown>) {
  return new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
const params = { params: Promise.resolve({ id: 'p1' }) };

const ROUTES = {
  'POST /api/policies': (body: Record<string, unknown>) =>
    POST_POLICY(json('http://localhost/api/policies', 'POST', { name: 'n', content: SOURCE, locale: LOCALE, ...body })),
  // 源码与活跃版本不同 → 总会建新版本，三态只看两个字段本身
  'PUT /api/policies/[id]': (body: Record<string, unknown>) =>
    PUT(json('http://localhost/api/policies/p1', 'PUT', { content: `${SOURCE}\n`, locale: LOCALE, ...body }), params),
  'POST /api/v1/policies/[id]/versions': (body: Record<string, unknown>) =>
    POST_VERSION(json('http://localhost/api/v1/policies/p1/versions', 'POST', { source: SOURCE, locale: LOCALE, ...body }) as never, params),
} as const;
type Route = keyof typeof ROUTES;
const ROUTE_NAMES = Object.keys(ROUTES) as Route[];

const createArgs = () => h.createVersion.mock.calls[0]![0] as Record<string, unknown>;
/**
 * 编译门禁发给 aster-api 的词汇。POST / PUT 在事务外预检；v1 版本入口把校验器交给 createVersion（这里是替身），
 * 由测试代为调用一次。
 */
async function compiledVocabulary(): Promise<DomainVocabulary | null> {
  if (h.compile.mock.calls.length === 0) {
    const validate = createArgs().validateCompilable as (i: unknown) => Promise<unknown>;
    await validate({ source: SOURCE, locale: LOCALE });
  }
  return (h.compile.mock.calls[0]![0] as { vocabulary: DomainVocabulary | null }).vocabulary;
}
const forms = (mappings: ReadonlyArray<{ localized: string; canonical: string }> | undefined) =>
  (mappings ?? []).map((m) => `${m.localized}→${m.canonical}`).sort();

beforeEach(() => {
  vi.clearAllMocks();
  policyAccessState.policy = { ...POLICY_ROW };
  policyAccessState.teamRole = 'member';
  policyAccessState.loader = null;
  h.returning.mockResolvedValue([{ ...POLICY_ROW }]);
  h.activeVersionFindFirst.mockResolvedValue({
    id: 'ver-3', aliasSet: canonicalAliasJson(ACTIVE_ALIAS), sourceScopesJson: null, embeddedVocabulary: ACTIVE_TEXT,
  });
  h.live.mockResolvedValue({ vocabulary: LOWER, teamTermKeys: new Set([vocabularyOriginKey(TEAM_HOME)]) });
  h.compile.mockResolvedValue({ success: true, diagnostics: [] });
  h.resolveEntitlement.mockResolvedValue({ allowed: false, denial: 'plan_required', sources: [] });
  h.createVersion.mockResolvedValue({
    id: 'ver-4', version: 4, sourceHash: 'h', sourceEnvelopeSha256: 'e', layoutSha256: null, layoutDropped: false,
  });
});

/** 每个字段在新版本里的去向：沿用活跃版本 / 无 / 采用提交值。 */
type Fate = 'active' | 'none' | 'submitted';
function aliasFate(value: unknown): Fate {
  if (value === null || value === undefined) return 'none';
  return canonicalAliasJson(value as Record<string, string[]>) === canonicalAliasJson(ACTIVE_ALIAS) ? 'active' : 'submitted';
}
function embeddedFate(value: unknown): Fate {
  const text = storedEmbeddedVocabulary(value as EmbeddedVocabulary | null);
  if (text === null) return 'none';
  return text === ACTIVE_TEXT ? 'active' : 'submitted';
}

const STATES = {
  omitted: {},
  null: { aliasSet: null, embeddedVocabulary: null },
  object: { aliasSet: SUBMITTED_ALIAS, embeddedVocabulary: POEM },
} as const;
const EXPECTED: Record<Route, Record<keyof typeof STATES, Fate>> = {
  'PUT /api/policies/[id]': { omitted: 'active', null: 'none', object: 'submitted' },
  'POST /api/policies': { omitted: 'none', null: 'none', object: 'submitted' },
  'POST /api/v1/policies/[id]/versions': { omitted: 'none', null: 'none', object: 'submitted' },
};

describe('tri-state matrix: embeddedVocabulary follows the aliasSet of the same route (ADR 0060 §6.5)', () => {
  describe.each(ROUTE_NAMES)('%s', (route) => {
    it.each(Object.keys(STATES) as (keyof typeof STATES)[])('field %s', async (state) => {
      const res = await ROUTES[route]({ ...STATES[state] });
      expect(res.status).toBeLessThan(300);
      const args = createArgs();
      expect({ alias: aliasFate(args.aliasSet), embedded: embeddedFate(args.embeddedVocabulary) })
        .toEqual({ alias: EXPECTED[route][state], embedded: EXPECTED[route][state] });
    });
  });
});

describe('PUT /api/policies/[id]: carry forward and change detection', () => {
  it('carries embedded vocabulary forward when the field is omitted (content-only edit by a teammate)', async () => {
    const res = await ROUTES['PUT /api/policies/[id]']({});
    expect(res.status).toBe(200);
    expect(storedEmbeddedVocabulary(createArgs().embeddedVocabulary as EmbeddedVocabulary)).toBe(ACTIVE_TEXT);
    // 沿用的词条照样进编译门禁
    expect(forms((await compiledVocabulary())?.literals)).toEqual(['思故乡→静夜思']);
  });

  it('null clears it', async () => {
    await ROUTES['PUT /api/policies/[id]']({ embeddedVocabulary: null });
    expect(createArgs().embeddedVocabulary).toBeNull();
    expect((await compiledVocabulary())?.literals ?? []).toEqual([]);
  });

  it('changing only the embedded vocabulary creates a new version', async () => {
    const res = await PUT(json('http://localhost/api/policies/p1', 'PUT', { content: SOURCE, embeddedVocabulary: POEM, locale: LOCALE }), params);
    expect(res.status).toBe(200);
    expect(h.createVersion).toHaveBeenCalledTimes(1);
    expect(storedEmbeddedVocabulary(createArgs().embeddedVocabulary as EmbeddedVocabulary)).toBe(POEM_TEXT);
    // 别名省略 → 沿用活跃版本的，与内嵌词汇的变更互不影响
    expect(createArgs().aliasSet).toEqual(ACTIVE_ALIAS);
  });

  it('the same embedded vocabulary (other term order, NFD input) creates no version', async () => {
    h.activeVersionFindFirst.mockResolvedValue({ id: 'ver-3', aliasSet: null, sourceScopesJson: null, embeddedVocabulary: POEM_TEXT });
    const same = { v: 1, terms: [POEM.terms[1], { ...POEM.terms[0], localized: '思故乡'.normalize('NFD') }] };
    const res = await PUT(json('http://localhost/api/policies/p1', 'PUT', { content: SOURCE, embeddedVocabulary: same, locale: LOCALE }), params);
    expect(res.status).toBe(200);
    expect(h.createVersion).not.toHaveBeenCalled();
  });

  it('null while the active version has none creates no version; {terms: []} equals null', async () => {
    h.activeVersionFindFirst.mockResolvedValue({ id: 'ver-3', aliasSet: null, sourceScopesJson: null, embeddedVocabulary: null });
    await PUT(json('http://localhost/api/policies/p1', 'PUT', { content: SOURCE, embeddedVocabulary: null, locale: LOCALE }), params);
    await PUT(json('http://localhost/api/policies/p1', 'PUT', { content: SOURCE, embeddedVocabulary: { v: 1, terms: [] }, locale: LOCALE }), params);
    expect(h.createVersion).not.toHaveBeenCalled();
  });

  it('a name-only edit never parses the stored value; a source edit carrying a corrupt stored value is a 400', async () => {
    h.activeVersionFindFirst.mockResolvedValue({ id: 'ver-3', aliasSet: null, sourceScopesJson: null, embeddedVocabulary: '{"v":1,"terms":[]} ' });
    const rename = await PUT(json('http://localhost/api/policies/p1', 'PUT', { name: 'renamed' }), params);
    expect(rename.status).toBe(200);
    const edit = await ROUTES['PUT /api/policies/[id]']({});
    expect(edit.status).toBe(400);
    expect(await edit.json()).toMatchObject({ code: 'embedded_vocabulary_invalid_format' });
    expect(h.createVersion).not.toHaveBeenCalled();
  });
});

describe.each(ROUTE_NAMES)('%s: merged vocabulary, shadowing and gating', (route) => {
  it('the compile gate, the seal and the alias reserved set all receive the merged vocabulary', async () => {
    const res = await ROUTES[route]({ embeddedVocabulary: POEM, aliasSet: SUBMITTED_ALIAS });
    expect(res.status).toBeLessThan(300);
    const compiled = (await compiledVocabulary())!;
    expect(forms(compiled.literals)).toEqual(['思故乡→静夜思']);
    // 内嵌 Text 胜出，作者 Moon 与团队 Home 被丢弃，作者 Moonlight 保留
    expect(forms(compiled.structs)).toEqual(['明月光→Moonlight', '望明月→Text']);
    const args = createArgs();
    expect(args.scopesJson).toBe(vocabularyScopesJson(compiled));
    const reserved = (args.aliasReserved as { vocabularyTermsLower: Set<string> }).vocabularyTermsLower;
    expect([...reserved]).toEqual(expect.arrayContaining(['思故乡', '望明月', '明月光', 'text', 'moonlight']));
    expect(reserved.has('静夜思')).toBe(false);
    expect(reserved.has('moon')).toBe(false);
  });

  it('response lists vocabularyShadowed with the source of each shadowed term', async () => {
    const res = await ROUTES[route]({ embeddedVocabulary: POEM });
    const body = await res.json();
    expect(body.vocabularyShadowed).toHaveLength(2);
    expect(body.vocabularyShadowed).toEqual(expect.arrayContaining([
      { kind: 'struct', localized: '思故乡', canonical: 'Home', source: 'team' },
      { kind: 'struct', localized: '望明月', canonical: 'Moon', source: 'author' },
    ]));
  });

  it('without embedded terms the lower vocabulary is compiled unchanged and nothing is shadowed', async () => {
    const res = await ROUTES[route]({ embeddedVocabulary: null });
    expect(await compiledVocabulary()).toBe(LOWER);
    expect((await res.json()).vocabularyShadowed).toEqual([]);
  });

  it('saving needs neither structured_authoring nor customLexicon (no capability or plan lookup)', async () => {
    const res = await ROUTES[route]({ embeddedVocabulary: POEM });
    expect(res.status).toBeLessThan(300);
    expect(h.resolveEntitlement).not.toHaveBeenCalled();
    expect(h.createVersion).toHaveBeenCalledTimes(1);
  });
});

/** 32 条、每条都在单项上限内的字面量，序列化后恰好 total 字节（前 31 条固定，最后一条补齐）。 */
function sized(total: number): EmbeddedVocabulary {
  const fixed: EmbeddedTerm[] = Array.from({ length: 31 }, (_, i) => ({ kind: 'literal', localized: `宏${String.fromCodePoint(0x4e00 + i)}`, canonical: 'y'.repeat(200) }));
  const bytes = (terms: EmbeddedTerm[]) => new TextEncoder().encode(serializeEmbeddedVocabulary({ v: 1, terms })!).length;
  const head = bytes([...fixed, { kind: 'literal', localized: '宏尾', canonical: '' }]);
  const terms: EmbeddedTerm[] = [...fixed, { kind: 'literal', localized: '宏尾', canonical: 'y'.repeat(total - head) }];
  expect(bytes(terms)).toBe(total);
  return { v: 1, terms };
}
const literals = (n: number): EmbeddedVocabulary => ({
  v: 1,
  terms: Array.from({ length: n }, (_, i) => ({ kind: 'literal' as const, localized: `宏${String.fromCodePoint(0x4e00 + i)}`, canonical: `文案${i}` })),
});

const ERROR_CASES: Array<{ code: string; input: unknown; aliasSet?: Record<string, string[]> }> = [
  { code: 'embedded_vocabulary_invalid_format', input: { v: 2, terms: [] } },
  { code: 'embedded_vocabulary_invalid_format', input: { v: 1, terms: [{ kind: 'field', localized: '字段', canonical: 'f' }] } },
  { code: 'embedded_vocabulary_invalid_format', input: [] },
  { code: 'embedded_vocabulary_too_large', input: literals(33) },
  { code: 'embedded_vocabulary_too_large', input: sized(8193) },
  { code: 'embedded_vocabulary_invalid', input: { v: 1, terms: [{ kind: 'struct', localized: '文本类', canonical: '文本' }] } },
  { code: 'embedded_vocabulary_duplicate', input: { v: 1, terms: [{ kind: 'struct', localized: '望明月', canonical: 'A' }, { kind: 'struct', localized: '望明月', canonical: 'B' }] } },
  { code: 'embedded_vocabulary_shadows_keyword', input: { v: 1, terms: [{ kind: 'literal', localized: '返回', canonical: 'x' }] } },
  { code: 'embedded_vocabulary_shadows_keyword', input: { v: 1, terms: [{ kind: 'literal', localized: '相 乘', canonical: 'x' }] }, aliasSet: SUBMITTED_ALIAS },
];

describe.each(ROUTE_NAMES)('%s: invalid embedded vocabulary → 400 { error, code, detail }', (route) => {
  it.each(ERROR_CASES)('$code', async ({ code, input, aliasSet }) => {
    const res = await ROUTES[route]({ embeddedVocabulary: input, ...(aliasSet ? { aliasSet } : {}) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'Invalid embedded vocabulary', code });
    expect(typeof body.detail).toBe('string');
    expect(h.compile).not.toHaveBeenCalled();
    expect(h.createVersion).not.toHaveBeenCalled();
  });

  it('accepts exactly 32 terms and exactly 8192 serialized bytes (Free included: one cap for every plan)', async () => {
    for (const input of [literals(32), sized(8192)]) {
      vi.clearAllMocks();
      h.compile.mockResolvedValue({ success: true, diagnostics: [] });
      const res = await ROUTES[route]({ embeddedVocabulary: input });
      expect(res.status).toBeLessThan(300);
      expect(storedEmbeddedVocabulary(createArgs().embeddedVocabulary as EmbeddedVocabulary)).toBe(serializeEmbeddedVocabulary(input));
    }
  });
});
