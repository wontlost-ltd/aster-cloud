// @vitest-environment node
// 显示排版的隐藏转义（ADR 0059 修订 5 L10，ADR 0058 修订 3 E8）：cloud 三个执行点都把版本的编译上下文交给 L10b。
// - prepareLayout（保存、沿用、导出复跑）：带上下文时按去反引号不变性判定，不带时失败封闭；
// - createVersion：给了保存词汇才带上下文；
// - runNodeCheck（Node 导出复核）：checkPackageLayout 的 l10b 用重编译的同一组编译输入。
// 向量取自 ADR 0059 修订 5 §6（E1、E2、E3、E5），ts 与 core 同判。
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ db: {}, policies: {}, policyVersions: {}, policyApprovals: {}, teamMembers: {}, policyVersionLayouts: {} }));
vi.mock('@/db/fresh-read', () => ({ freshDb: {} }));

import { compile, ZH_CN, EN_US, type DomainVocabulary } from '@aster-cloud/aster-lang-ts/browser';
import { serializeLayout, type LayoutSpan, type PolicyLayout } from '@aster-cloud/aster-lang-ts/layout';
import { TS_VERSION, compileSourcePositionFreeSha256 } from '@aster-cloud/aster-lang-ts/package-check';
import { ESCAPE_SOURCE, VERSION_FIELD_HIDDEN, VERSION_FIELD_SOURCE } from '@/__tests__/fixtures/layout-error-cases';
import { LayoutSaveError } from '@/lib/policy-layout/errors';
import { prepareLayout, type LayoutContext } from '@/lib/policy-layout/store';
import { runNodeCheck } from '@/lib/package-node-check';
import { createVersion } from '@/services/policy/version-manager';
import type { PackageExportPrepareResponse } from '@/services/policy/policy-api';

const tick: LayoutSpan = { canonical: '`', display: '' };
const layout = (spans: LayoutSpan[]): PolicyLayout => ({ v: 1, spans });

/** E3：en 冗余转义 `count` 的两处都隐藏——去掉反引号是同一程序，可以隐藏。 */
const COUNT_HIDDEN = layout([
  { text: 'Module demo.layout.\n\nRule decide given ' }, tick, { text: 'count' }, tick,
  { text: ' as Int, produce Int:\n  Return ' }, tick, { text: 'count' }, tick, { text: '.\n' },
]);

/** E1：zh 形参 `如果`（结构关键词）两处都隐藏——去掉反引号即编译失败（E901），可以隐藏。 */
const IF_SOURCE = '模块 探针.样例。\n\n规则 取值 给定 `如果` 作为 整数，产出 整数：\n  返回 `如果`。\n';
const IF_HIDDEN = layout([
  { text: '模块 探针.样例。\n\n规则 取值 给定 ' }, tick, { text: '如果' }, tick,
  { text: ' 作为 整数，产出 整数：\n  返回 ' }, tick, { text: '如果' }, tick, { text: '。\n' },
]);

/** E5：词汇字面量 思故乡 → "静夜思"；`思故乡` 作局部变量，定义与使用都隐藏——只去掉使用处会返回字面量，必须拒绝。 */
const POEM_VOCABULARY = {
  id: 'policy.embedded', name: 'policy', locale: 'zh-CN', version: '1',
  structs: [], fields: [], functions: [], enumValues: [],
  literals: [{ localized: '思故乡', canonical: '静夜思', kind: 'literal' }],
} as unknown as DomainVocabulary;
const LITERAL_SOURCE = '模块 探针.样例。\n\n规则 取值，产出 文本：\n  令 `思故乡` 定义为 「床前」。\n  返回 `思故乡`。\n';
const LITERAL_HIDDEN = layout([
  { text: '模块 探针.样例。\n\n规则 取值，产出 文本：\n  令 ' }, tick, { text: '思故乡' }, tick,
  { text: ' 定义为 「床前」。\n  返回 ' }, tick, { text: '思故乡' }, tick, { text: '。\n' },
]);

const ctx = (source: string, locale: string, compile?: LayoutContext['compile']): LayoutContext => ({
  source, locale, aliasSet: null, ...(compile ? { compile } : {}),
});
const NO_VOCAB = { allowStructural: false, vocabulary: null };

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof LayoutSaveError) return e.code;
    throw e;
  }
}

describe('prepareLayout：L10b 用版本的编译上下文（E8）', () => {
  it('向量源码本身都能编译', () => {
    expect(compile(ESCAPE_SOURCE, { lexicon: EN_US }).success).toBe(true);
    expect(compile(IF_SOURCE, { lexicon: ZH_CN }).success).toBe(true);
    expect(compile(LITERAL_SOURCE, { lexicon: ZH_CN, vocabulary: POEM_VOCABULARY }).success).toBe(true);
  });

  it('E3 冗余转义、E1 结构关键词作名字：带上下文时通过', () => {
    expect(prepareLayout(COUNT_HIDDEN, ctx(ESCAPE_SOURCE, 'en-US', NO_VOCAB)).serialized).toBe(serializeLayout(COUNT_HIDDEN));
    expect(codeOf(() => prepareLayout(IF_HIDDEN, ctx(IF_SOURCE, 'zh-CN', NO_VOCAB)))).toBeNull();
  });

  it('不带上下文（调用方给不出完整编译输入）：同样的排版一律失败封闭', () => {
    expect(codeOf(() => prepareLayout(COUNT_HIDDEN, ctx(ESCAPE_SOURCE, 'en-US')))).toBe('layout_hidden_escape_changes_program');
    expect(codeOf(() => prepareLayout(IF_HIDDEN, ctx(IF_SOURCE, 'zh-CN')))).toBe('layout_hidden_escape_changes_program');
  });

  it('E2 静默改名的字段 `版本`：带上下文也拒绝（去掉反引号编译成字段 version）', () => {
    expect(codeOf(() => prepareLayout(VERSION_FIELD_HIDDEN, ctx(VERSION_FIELD_SOURCE, 'zh-CN', NO_VOCAB))))
      .toBe('layout_hidden_escape_changes_program');
  });

  it('E5 字面量触发词：带上版本词汇才判得出「只去掉使用处是另一个程序」——词汇是编译输入的一部分', () => {
    const withVocab = { allowStructural: false, vocabulary: POEM_VOCABULARY };
    expect(codeOf(() => prepareLayout(LITERAL_HIDDEN, ctx(LITERAL_SOURCE, 'zh-CN', withVocab))))
      .toBe('layout_hidden_escape_changes_program');
    // 漏掉词汇时 思故乡 不展开，去反引号前后是同一程序——会错误放行。所以 createVersion / 导出必须传真实词汇
    expect(codeOf(() => prepareLayout(LITERAL_HIDDEN, ctx(LITERAL_SOURCE, 'zh-CN', NO_VOCAB)))).toBeNull();
  });

  it('没有隐藏转义的排版：带不带上下文结论相同（不做额外编译）', () => {
    const plain = layout([{ text: ESCAPE_SOURCE }]);
    expect(prepareLayout(plain, ctx(ESCAPE_SOURCE, 'en-US')).serialized)
      .toBe(prepareLayout(plain, ctx(ESCAPE_SOURCE, 'en-US', NO_VOCAB)).serialized);
  });
});

describe('createVersion：给了保存词汇才带上下文（排版在开事务之前校验）', () => {
  /** 走到数据库就说明排版校验已通过。 */
  const reachedDb = new Error('reached db');
  const dbClient = { execute: vi.fn(async () => { throw reachedDb; }) } as never;
  const params = (vocabulary?: DomainVocabulary | null) => ({
    policyId: 'p-1', source: ESCAPE_SOURCE, createdBy: 'u-1', locale: 'en-US', scopesJson: '',
    layout: COUNT_HIDDEN, allowLayout: true, dbClient, ...(vocabulary !== undefined ? { vocabulary } : {}),
  });

  it('vocabulary 省略 → 失败封闭', async () => {
    await expect(createVersion(params())).rejects.toMatchObject({ code: 'layout_hidden_escape_changes_program' });
  });

  it('vocabulary 为 null（无词汇）→ 按 L10b 判定，通过后才写库', async () => {
    await expect(createVersion(params(null))).rejects.toBe(reachedDb);
  });
});

describe('runNodeCheck：包排版 L10b 用重编译的同一组编译输入', () => {
  const input = { source: ESCAPE_SOURCE, locale: 'en-US', aliasSet: null, allowStructural: false };
  const coreIr = compile(ESCAPE_SOURCE, { lexicon: EN_US }).coreJson!;
  const prepared: PackageExportPrepareResponse = {
    exportable: true, diagnostics: [], entry: 'decide', coreIr, coreIrSha256: 'aa'.repeat(32),
    positionFreeSha256: compileSourcePositionFreeSha256(ESCAPE_SOURCE, { locale: 'en-US', aliasSetJson: 'null', allowStructural: false }),
    probes: null, probesJson: '{"probes":[{"entry":"decide","expected":{"ok":true,"value":3},"input":{"count":3}}]}',
    probesSha256: 'bb'.repeat(32), probeCount: 1,
    runtime: { cliName: '@aster-cloud/aster-lang-ts', cliVersion: TS_VERSION, ecosystem: '1.0.57' },
  };

  it('E3 的隐藏转义通过 L1–L10；不带排版照常', () => {
    expect(runNodeCheck(prepared, input)).toMatchObject({ ok: true, layoutOk: true });
    expect(runNodeCheck(prepared, input, serializeLayout(COUNT_HIDDEN))).toMatchObject({ ok: true, layoutOk: true });
  });

  it('只隐藏一个反引号（不成对，L10a）→ layoutOk:false', () => {
    const broken = layout([
      { text: 'Module demo.layout.\n\nRule decide given ' }, tick, { text: 'count` as Int, produce Int:\n  Return `count`.\n' },
    ]);
    expect(runNodeCheck(prepared, input, serializeLayout(broken))).toMatchObject({ ok: true, layoutOk: false });
  });
});
