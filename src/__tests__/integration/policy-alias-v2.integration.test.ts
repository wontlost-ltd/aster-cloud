// ADR 0060 §5 / 计划 T12：别名规则 v2 经真实保存路由与 createVersion（真实 Postgres）。
// - 《静夜思》：zh-CN + 四个汉字单词结构词别名（含 FUNC_PRODUCE）+ 内嵌词汇，授权作者保存成功，envelope 工具链带 validator=2；
// - 无结构词授权时 FUNC_PRODUCE 别名被拒（400 alias_invalid）；
// - 别名与内嵌字面量触发词同形：保存路由按 §6.4 报 embedded_vocabulary_shadows_keyword 不落行；createVersion 本身判 collidesVocabulary；
// - aster-api 仍是 v1 校验器时（部署顺序错了）：上游以别名错误拒绝 → 400 compile_error（code alias_invalid），不落行（fail-closed）。
// aster-api 编译调用替换为可切换响应的桩（真实编译见 policy-embedded-vocabulary-compile.integration）。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts policy-alias-v2

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';

const current = vi.hoisted(() => ({ userId: '' }));
const compile = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  respond: null as null | ((request: Record<string, unknown>) => Promise<unknown>),
}));

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
      compile.calls.push(request);
      return compile.respond ? compile.respond(request) : { success: true, diagnostics: [] };
    },
  }),
}));

import { createDb } from '@/db';
import { policies, policyVersions, securityEvents, structuralAliasGrants, users } from '@/lib/prisma';
import { POST as POST_POLICY } from '@/app/api/policies/route';
import { PolicyApiError } from '@/services/policy/policy-api';
import { createVersion } from '@/services/policy/version-manager';
import { vocabularyScopesJson } from '@/lib/policy-alias';
import { buildAliasReservedFromVocabulary } from '@/lib/structural-alias-grants';
import { toDomainVocabulary, type EmbeddedVocabulary } from '@/lib/policy-embedded-vocabulary';

const P = 'it-pav2';
const U = { author: `${P}-author`, ungranted: `${P}-ungranted`, admin: `${P}-admin` } as const;
const LOCALE = 'zh-CN';
const SOURCE = '床前 明月光。\n疑是 地上霜，举头 望明月：\n  低头 思故乡。';
const ALIASES = { FUNC_PRODUCE: ['举头'], FUNC_TO: ['疑是'], MODULE_DECL: ['床前'], RETURN: ['低头'] };
const POEM = {
  v: 1,
  terms: [
    { kind: 'literal', localized: '思故乡', canonical: '静夜思' },
    { kind: 'struct', localized: '望明月', canonical: 'Text' },
  ],
};
/** aster-api 1.0.51（v1 校验器）对汉字单词别名的拒绝：编译通道返回 success:false 与一条 error 诊断。 */
const V1_ALIAS_REJECTION =
  "用户自定义别名校验失败: 别名 '低头'（RETURN）必须是多词短语；单词别名会占用标识符命名空间，破坏用户空间";

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

function req(body: Record<string, unknown>) {
  return new Request('http://localhost/api/policies', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createPolicy(as: string, body: Record<string, unknown>) {
  current.userId = as;
  const res = await POST_POLICY(req({ name: `${P}-p`, content: SOURCE, locale: LOCALE, ...body }));
  return { status: res.status, body: await res.json() };
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('别名规则 v2 经保存路由（真实 Postgres）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db = createDb(undefined, { max: 4 });

  async function ownedPolicies() {
    return db.select({ id: policies.id }).from(policies).where(like(policies.name, `${P}%`));
  }

  async function cleanup() {
    const owned = db.select({ id: policies.id }).from(policies).where(like(policies.name, `${P}%`));
    await db.delete(securityEvents).where(inArray(securityEvents.policyId, owned));
    await db.delete(policyVersions).where(inArray(policyVersions.policyId, owned));
    await db.delete(policies).where(like(policies.name, `${P}%`));
    await db.delete(structuralAliasGrants).where(like(structuralAliasGrants.id, `${P}-%`));
    await db.delete(users).where(inArray(users.id, Object.values(U)));
  }

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
    await cleanup();
    await db.insert(users).values(Object.values(U).map((id) => ({ id, email: `${id}@example.test`, updatedAt: new Date() })));
    await db.insert(structuralAliasGrants).values({ id: `${P}-grant`, userId: U.author, grantedBy: U.admin });
  });

  beforeEach(async () => {
    compile.calls.length = 0;
    compile.respond = null;
    const owned = db.select({ id: policies.id }).from(policies).where(like(policies.name, `${P}%`));
    await db.delete(securityEvents).where(inArray(securityEvents.policyId, owned));
    await db.delete(policyVersions).where(inArray(policyVersions.policyId, owned));
    await db.delete(policies).where(like(policies.name, `${P}%`));
  });

  afterAll(async () => {
    await cleanup();
    globalForDb.__asterLocalDevDb = previous;
  });

  it('saves the poem with Han single-word structural aliases, FUNC_PRODUCE included', async () => {
    const res = await createPolicy(U.author, { aliasSet: ALIASES, embeddedVocabulary: POEM });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [version] = await db.select().from(policyVersions).where(eq(policyVersions.policyId, res.body.id));
    expect(version!.aliasSet).toBe('{"FUNC_PRODUCE":["举头"],"FUNC_TO":["疑是"],"MODULE_DECL":["床前"],"RETURN":["低头"]}');
    expect(version!.sourceToolchainId).toContain(';validator=2;');
    // 编译门禁收到同一组别名与授权
    expect(compile.calls).toHaveLength(1);
    expect(compile.calls[0]).toMatchObject({ locale: LOCALE, aliasSet: ALIASES, allowStructural: true });
  });

  it('rejects a FUNC_PRODUCE alias without the structural grant', async () => {
    const res = await createPolicy(U.ungranted, { aliasSet: { FUNC_PRODUCE: ['举头'] }, embeddedVocabulary: POEM });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'alias_invalid' });
    expect(await ownedPolicies()).toHaveLength(0);
  });

  it('alias equal to an embedded literal trigger is rejected as collidesVocabulary', async () => {
    const content = '床前 明月光。\n疑是 地上霜，举头 望明月：\n  思故乡 思故乡。';
    const aliasSet = { ...ALIASES, RETURN: ['思故乡'] };
    // 保存路由先按 §6.4 校验内嵌词条：与别名同形的内嵌词条报 embedded_vocabulary_shadows_keyword，不落行
    const res = await createPolicy(U.author, { content, aliasSet, embeddedVocabulary: POEM });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'embedded_vocabulary_shadows_keyword' });
    expect(await ownedPolicies()).toHaveLength(0);
    // createVersion 是所有入口的最后一道：占用集取合并后的有效词汇（含字面量触发词），别名校验 v2 判 collidesVocabulary
    const vocabulary = toDomainVocabulary(POEM as EmbeddedVocabulary, LOCALE);
    await expect(createVersion({
      policyId: `${P}-direct`,
      source: content,
      createdBy: U.author,
      locale: LOCALE,
      scopesJson: vocabularyScopesJson(vocabulary),
      aliasSet,
      aliasReserved: buildAliasReservedFromVocabulary(LOCALE, vocabulary),
      allowStructuralAliases: true,
      embeddedVocabulary: POEM as EmbeddedVocabulary,
    })).rejects.toThrow("别名 '思故乡'（RETURN）与领域词汇标识符同形");
    expect(compile.calls).toHaveLength(0);
  });

  it('rejected by an upstream v1 validator is surfaced as a compile error', async () => {
    compile.respond = async () => ({
      success: false,
      error: '编译失败',
      diagnostics: [{ severity: 'error', message: V1_ALIAS_REJECTION, startLine: 1, startColumn: 1 }],
    });
    const res = await createPolicy(U.author, { aliasSet: ALIASES, embeddedVocabulary: POEM });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'compile_error', code: 'alias_invalid' });
    expect(await ownedPolicies()).toHaveLength(0);
  });

  it('an upstream 4xx alias rejection is also a compile error and writes nothing', async () => {
    compile.respond = async () => {
      throw new PolicyApiError(V1_ALIAS_REJECTION, 400, 'BAD_REQUEST');
    };
    const res = await createPolicy(U.author, { aliasSet: ALIASES, embeddedVocabulary: POEM });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'compile_error', code: 'alias_invalid' });
    expect(await ownedPolicies()).toHaveLength(0);
  });
});
