// ADR 0060 §6.2–6.7、§7.1 / 计划 T9：三条保存路由写入版本内嵌词汇（真实 Postgres，真实路由与 createVersion）。
// - 版本行存规范序列化；封印词汇段 = 作者词汇并入内嵌词条，且与草稿执行读路径复算的一致；
// - envelope 不加段：内嵌词条与「同样有效词条的个人词汇」得到同一 sourceEnvelopeSha256；
// - PUT 三态（省略沿用 / null 清空 / 对象使用）与变化判定；POST v1 版本入口省略即无；
// - 五个错误码 400，不落行；
// - 团队策略：遮蔽回报带来源，别名占用集取团队词条、不取作者其他语种的词条；
// - 免费套餐、无任何能力即可保存。
// aster-api 编译调用替换为记录请求的桩（真实编译见 policy-embedded-vocabulary-compile.integration）。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts policy-save-embedded-vocabulary

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq, inArray, like } from 'drizzle-orm';

const current = vi.hoisted(() => ({ userId: '' }));
const compileCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ getSession: vi.fn(async () => ({ user: { id: current.userId } })) }));
vi.mock('@/auth', () => ({ auth: vi.fn(async () => ({ user: { id: current.userId } })) }));
vi.mock('@/lib/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cache')>()),
  invalidatePolicyCache: vi.fn(async () => undefined),
}));
vi.mock('@/lib/metrics/aha-detection', () => ({ recordAhaMomentIfFirst: vi.fn(async () => false) }));
vi.mock('@/lib/product-events/server', () => ({ recordProductEventAfterResponse: vi.fn() }));
vi.mock('@/services/policy/policy-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/policy/policy-api')>()),
  createPolicyApiClient: () => ({
    compile: async (request: Record<string, unknown>) => {
      compileCalls.push(request);
      return { success: true, diagnostics: [] };
    },
  }),
}));

import type { DomainVocabulary } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
import { createDb } from '@/db';
import {
  domainTerms,
  policies,
  policyVersions,
  securityEvents,
  teamMembers,
  teams,
  userDomainTerms,
  users,
} from '@/lib/prisma';
import { POST as POST_POLICY } from '@/app/api/policies/route';
import { PUT } from '@/app/api/policies/[id]/route';
import { POST as POST_VERSION } from '@/app/api/v1/policies/[id]/versions/route';
import { loadLiveVocabularyForPolicy } from '@/lib/domain-vocabulary-snapshot';
import { loadVersionExecutionVocabulary } from '@/lib/execution-input';
import { vocabularyScopesJson } from '@/lib/policy-alias';
import { loadSaveVocabulary } from '@/lib/policy-compile-validator';
import { buildAliasReservedFromVocabulary } from '@/lib/structural-alias-grants';
import { mergeEmbeddedVocabulary, toDomainVocabulary, type EmbeddedVocabulary } from '@/lib/policy-embedded-vocabulary';

const P = 'it-pse';
const U = { author: `${P}-author`, twin: `${P}-twin`, plain: `${P}-plain`, member: `${P}-member` } as const;
const TEAM = `${P}-team`;
const TEAM_POLICY = `${P}-pol-team`;
const LOCALE = 'zh-CN';
const SOURCE = '模块 明月光。\n规则 地上霜，产出 望明月：\n  返回 思故乡。';
const POEM_TEXT = '{"v":1,"terms":[{"kind":"literal","localized":"思故乡","canonical":"静夜思"},{"kind":"struct","localized":"望明月","canonical":"Text"}]}';
const POEM: EmbeddedVocabulary = JSON.parse(POEM_TEXT);
/** 同一内容：词条倒序、写法为 NFD——存储与比较都按规范序列化。 */
const POEM_REORDERED = { v: 1, terms: [POEM.terms[1], { ...POEM.terms[0], localized: '思故乡'.normalize('NFD') }] };
const LITERAL_ONLY_TEXT = '{"v":1,"terms":[{"kind":"literal","localized":"思故乡","canonical":"静夜思"}]}';
const STRUCT_ONLY_TEXT = '{"v":1,"terms":[{"kind":"struct","localized":"望明月","canonical":"Text"}]}';

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

let termSeq = 0;
/** 个人（ownerType user）或团队（ownerType team）词条。 */
function termRows(owner: { userId: string; teamId?: string }, locale: string, kind: string, canonical: string, localized: string) {
  const id = `dt-${P}-${++termSeq}`;
  return {
    term: {
      id, domain: 'poem', locale, kind, canonical, canonicalNorm: canonical.toLowerCase(),
      localized, localizedNorm: localized.toLowerCase(), parentCanonical: null, source: 'user', dedupKey: `${P}-${termSeq}`,
    } as typeof domainTerms.$inferInsert,
    link: {
      id: `udt-${P}-${termSeq}`, userId: owner.userId, termId: id, domain: 'poem', locale, kind,
      ownerType: owner.teamId ? 'team' : 'user', teamId: owner.teamId ?? null,
    } as typeof userDomainTerms.$inferInsert,
  };
}

function req(url: string, method: string, body: Record<string, unknown>) {
  return new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function createPolicy(as: string, body: Record<string, unknown>) {
  current.userId = as;
  const res = await POST_POLICY(req('http://localhost/api/policies', 'POST', { name: `${P}-p`, content: SOURCE, locale: LOCALE, ...body }));
  return { status: res.status, body: await res.json() };
}

async function put(as: string, id: string, body: Record<string, unknown>) {
  current.userId = as;
  const res = await PUT(req(`http://localhost/api/policies/${id}`, 'PUT', { locale: LOCALE, ...body }), { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('保存路由写入内嵌词汇（真实 Postgres）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db = createDb(undefined, { max: 6 });

  async function versions(policyId: string) {
    return db.select().from(policyVersions).where(eq(policyVersions.policyId, policyId)).orderBy(asc(policyVersions.version));
  }
  async function latest(policyId: string) {
    const rows = await versions(policyId);
    return rows[rows.length - 1]!;
  }

  async function cleanup() {
    const owned = db.select({ id: policies.id }).from(policies).where(like(policies.name, `${P}%`));
    await db.delete(securityEvents).where(inArray(securityEvents.policyId, owned));
    await db.delete(policyVersions).where(inArray(policyVersions.policyId, owned));
    await db.delete(policies).where(like(policies.name, `${P}%`));
    await db.delete(userDomainTerms).where(like(userDomainTerms.id, `udt-${P}-%`));
    await db.delete(domainTerms).where(like(domainTerms.id, `dt-${P}-%`));
    await db.delete(teamMembers).where(eq(teamMembers.teamId, TEAM));
    await db.delete(teams).where(eq(teams.id, TEAM));
    await db.delete(users).where(inArray(users.id, Object.values(U)));
  }

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
    await cleanup();
    await db.insert(users).values(Object.values(U).map((id) => ({ id, email: `${id}@example.test`, updatedAt: new Date() })));
    await db.insert(teams).values({ id: TEAM, name: TEAM, slug: TEAM, ownerId: U.member } as typeof teams.$inferInsert);
    await db.insert(teamMembers).values({ id: `${TEAM}-m`, teamId: TEAM, userId: U.member, role: 'owner' } as typeof teamMembers.$inferInsert);
    const rows = [
      // 作者个人词条：明月光 → Moonlight 与内嵌词条不冲突，留在有效词汇里
      termRows({ userId: U.author }, 'zh', 'struct', 'Moonlight', '明月光'),
      // twin 的个人词汇恰好等于内嵌 struct：与 author 的内嵌写法有效词条相同
      termRows({ userId: U.twin }, 'zh', 'struct', 'Text', '望明月'),
      // 团队：明月光 → Moonlight 保留；思故乡 → Home 撞内嵌字面量触发词，被遮蔽（team）
      termRows({ userId: U.member, teamId: TEAM }, 'zh', 'struct', 'Moonlight', '明月光'),
      termRows({ userId: U.member, teamId: TEAM }, 'zh', 'struct', 'Home', '思故乡'),
      // member 个人：望明月 → Moon 与内嵌 struct 同键异名，被遮蔽（author）；德语词条不在 zh 策略的作用域
      termRows({ userId: U.member }, 'zh', 'struct', 'Moon', '望明月'),
      termRows({ userId: U.member }, 'de', 'struct', 'Driver', 'Fahrer'),
    ];
    await db.insert(domainTerms).values(rows.map((r) => r.term));
    await db.insert(userDomainTerms).values(rows.map((r) => r.link));
    await db.insert(policies).values({
      id: TEAM_POLICY, userId: U.member, teamId: TEAM, name: `${P}-team`, content: SOURCE, version: 0, updatedAt: new Date(),
    } as typeof policies.$inferInsert);
  });
  beforeEach(() => {
    compileCalls.length = 0;
  });
  afterAll(async () => {
    await cleanup();
    globalForDb.__asterLocalDevDb = previous;
    await db.$client.end();
  });

  let poemPolicy = '';

  it('stores the serialized embedded vocabulary and seals scopesJson from author vocabulary plus embedded terms (Free plan, no capability)', async () => {
    const [{ plan }] = await db.select({ plan: users.plan }).from(users).where(eq(users.id, U.author));
    expect(plan).toBe('free');
    const created = await createPolicy(U.author, { embeddedVocabulary: POEM_REORDERED });
    expect(created.status).toBe(201);
    expect(created.body.vocabularyShadowed).toEqual([]);
    poemPolicy = created.body.id;

    const row = await latest(poemPolicy);
    expect(row.embeddedVocabulary).toBe(POEM_TEXT);
    const lower = await loadLiveVocabularyForPolicy(U.author, { source: SOURCE, locale: LOCALE });
    const effective = mergeEmbeddedVocabulary(toDomainVocabulary(POEM, LOCALE), lower).vocabulary;
    expect(row.sourceScopesJson).toBe(vocabularyScopesJson(effective));
    expect(row.sourceScopesJson).not.toBe(vocabularyScopesJson(lower));
    // 编译门禁收到的就是封印所用的同一份有效词汇
    const sent = compileCalls[0]!.vocabulary as DomainVocabulary;
    expect(vocabularyScopesJson(sent)).toBe(row.sourceScopesJson);
    expect(sent.literals?.map((m) => `${m.localized}→${m.canonical}`)).toEqual(['思故乡→静夜思']);
    // 草稿执行的读路径复算出同一词汇段：写入与读取同一口径
    const executed = await loadVersionExecutionVocabulary({
      status: row.status, vocabularySnapshotIds: row.vocabularySnapshotIds, authorId: row.createdBy, teamId: null,
      source: row.content, locale: LOCALE, embeddedVocabulary: row.embeddedVocabulary, sourceScopesJson: row.sourceScopesJson,
    });
    expect(vocabularyScopesJson(executed as unknown as DomainVocabulary)).toBe(row.sourceScopesJson);
  });

  it('envelope is byte-identical to a version whose user vocabulary has the same effective terms', async () => {
    const embedded = await createPolicy(U.plain, { embeddedVocabulary: JSON.parse(STRUCT_ONLY_TEXT) });
    const personal = await createPolicy(U.twin, {});
    expect([embedded.status, personal.status]).toEqual([201, 201]);
    const a = await latest(embedded.body.id);
    const b = await latest(personal.body.id);
    expect(a.embeddedVocabulary).toBe(STRUCT_ONLY_TEXT);
    expect(b.embeddedVocabulary).toBeNull();
    expect(a.sourceScopesJson).not.toBe('');
    expect(a.sourceScopesJson).toBe(b.sourceScopesJson);
    expect(a.sourceEnvelopeSha256).toBe(b.sourceEnvelopeSha256);
  });

  it('carries embedded vocabulary forward when the field is omitted (PUT changes only content)', async () => {
    const res = await put(U.author, poemPolicy, { content: `${SOURCE}\n` });
    expect(res.status).toBe(200);
    const rows = await versions(poemPolicy);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.embeddedVocabulary).toBe(POEM_TEXT);
    expect((compileCalls[0]!.vocabulary as DomainVocabulary).literals).toHaveLength(1);
  });

  it('same embedded vocabulary (other order, NFD) creates no version', async () => {
    const res = await put(U.author, poemPolicy, { content: `${SOURCE}\n`, embeddedVocabulary: POEM_REORDERED });
    expect(res.status).toBe(200);
    expect(await versions(poemPolicy)).toHaveLength(2);
  });

  it('changing only the embedded vocabulary creates a new version', async () => {
    const res = await put(U.author, poemPolicy, { content: `${SOURCE}\n`, embeddedVocabulary: JSON.parse(LITERAL_ONLY_TEXT) });
    expect(res.status).toBe(200);
    const rows = await versions(poemPolicy);
    expect(rows).toHaveLength(3);
    expect(rows[2]!.embeddedVocabulary).toBe(LITERAL_ONLY_TEXT);
    expect(rows[2]!.content).toBe(rows[1]!.content);
    expect(rows[2]!.sourceScopesJson).not.toBe(rows[1]!.sourceScopesJson);
  });

  it('POST /api/v1/policies/[id]/versions treats omission as none even when the active version has terms', async () => {
    current.userId = U.author;
    const res = await POST_VERSION(
      req(`http://localhost/api/v1/policies/${poemPolicy}/versions`, 'POST', { source: SOURCE, locale: LOCALE }) as never,
      { params: Promise.resolve({ id: poemPolicy }) },
    );
    expect(res.status).toBe(201);
    expect((await res.json()).vocabularyShadowed).toEqual([]);
    expect((await latest(poemPolicy)).embeddedVocabulary).toBeNull();
  });

  it('null clears it', async () => {
    // v1 入口不回填 Policy.version：活跃版本仍是 v3（只有字面量），PUT null 建出无内嵌词条的新版本
    const res = await put(U.author, poemPolicy, { content: `${SOURCE}\n`, embeddedVocabulary: null });
    expect(res.status).toBe(200);
    const rows = await versions(poemPolicy);
    expect(rows).toHaveLength(5);
    expect(rows[4]!.embeddedVocabulary).toBeNull();
  });

  it.each([
    ['embedded_vocabulary_invalid_format', { v: 1, terms: [{ kind: 'macro', localized: '甲乙', canonical: 'x' }] }],
    ['embedded_vocabulary_too_large', { v: 1, terms: Array.from({ length: 33 }, (_, i) => ({ kind: 'literal', localized: `宏${String.fromCodePoint(0x4e00 + i)}`, canonical: 'x' })) }],
    ['embedded_vocabulary_invalid', { v: 1, terms: [{ kind: 'function', localized: '计算器', canonical: '计算' }] }],
    ['embedded_vocabulary_duplicate', { v: 1, terms: [{ kind: 'literal', localized: '甲乙', canonical: 'x' }, { kind: 'struct', localized: '甲乙', canonical: 'X' }] }],
    ['embedded_vocabulary_shadows_keyword', { v: 1, terms: [{ kind: 'struct', localized: '返回', canonical: 'Back' }] }],
  ])('rejects %s with 400 and writes nothing', async (code, embeddedVocabulary) => {
    const before = await versions(poemPolicy);
    const res = await put(U.author, poemPolicy, { content: `${SOURCE}\n\n`, embeddedVocabulary });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid embedded vocabulary', code });
    expect(await versions(poemPolicy)).toHaveLength(before.length);
    expect(compileCalls).toHaveLength(0);
  });

  it('team policy: response lists vocabularyShadowed with team and author sources', async () => {
    const res = await put(U.member, TEAM_POLICY, { content: `${SOURCE}\n`, embeddedVocabulary: POEM });
    expect(res.status).toBe(200);
    expect(res.body.vocabularyShadowed).toHaveLength(2);
    expect(res.body.vocabularyShadowed).toEqual(expect.arrayContaining([
      { kind: 'struct', localized: '思故乡', canonical: 'Home', source: 'team' },
      { kind: 'struct', localized: '望明月', canonical: 'Moon', source: 'author' },
    ]));
    const row = await latest(TEAM_POLICY);
    expect(row.embeddedVocabulary).toBe(POEM_TEXT);
    const sent = compileCalls[0]!.vocabulary as DomainVocabulary;
    expect(sent.structs.map((m) => `${m.localized}→${m.canonical}`).sort()).toEqual(['明月光→Moonlight', '望明月→Text']);
  });

  it('alias reserved set uses team terms of a team policy and ignores author terms of other locales', async () => {
    const save = await loadSaveVocabulary(U.member, { source: SOURCE, locale: LOCALE }, { teamId: TEAM, embedded: POEM });
    const reserved = buildAliasReservedFromVocabulary(LOCALE, save.vocabulary).vocabularyTermsLower!;
    expect([...reserved]).toEqual(expect.arrayContaining(['明月光', 'moonlight', '思故乡', '望明月', 'text']));
    expect(reserved.has('fahrer')).toBe(false);
    expect(reserved.has('moon')).toBe(false);
    expect(reserved.has('home')).toBe(false);
    // 无内嵌词汇时只有团队与作者的有效词条
    const plain = await loadSaveVocabulary(U.member, { source: SOURCE, locale: LOCALE }, { teamId: TEAM });
    const lowerReserved = buildAliasReservedFromVocabulary(LOCALE, plain.vocabulary).vocabularyTermsLower!;
    expect([...lowerReserved].sort()).toEqual(['home', 'moon', 'moonlight', '思故乡', '明月光', '望明月'].sort());
  });
});
