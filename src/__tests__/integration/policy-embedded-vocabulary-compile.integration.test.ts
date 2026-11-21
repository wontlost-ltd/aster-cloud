// ADR 0060 §6.3、§7.4 / 计划 T9：保存时的编译门禁拿到合并后的有效词汇——用字面量宏的策略经真实 aster-api
// `POST /api/v1/policies/compile` 编译通过并落库；省略内嵌词汇时同一源码被编译门禁拒绝（E800 / E802）。
// 真实 Postgres + 本地 aster-api 容器（只许 localhost，绝不访问 *.aster-lang.dev，见 #824）。
//
// Run（本地栈见 PR 正文）:
//   LICENSE_E2E=1 DATABASE_URL=… ASTER_LOCAL_POLICY_API_URL=http://localhost:8961 \
//     pnpm exec vitest run --config vitest.integration.config.ts policy-embedded-vocabulary-compile

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';

const current = vi.hoisted(() => ({ userId: 'it-pevc-author' }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ getSession: vi.fn(async () => ({ user: { id: current.userId } })) }));
vi.mock('@/lib/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cache')>()),
  invalidatePolicyCache: vi.fn(async () => undefined),
}));
vi.mock('@/lib/metrics/aha-detection', () => ({ recordAhaMomentIfFirst: vi.fn(async () => false) }));
vi.mock('@/lib/product-events/server', () => ({ recordProductEventAfterResponse: vi.fn() }));

import { createDb } from '@/db';
import { policies, policyVersions, securityEvents, users } from '@/lib/prisma';
import { POST as POST_POLICY } from '@/app/api/policies/route';

const LOCAL_API = process.env.ASTER_LOCAL_POLICY_API_URL ?? '';
const LOCAL_ONLY = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const P = 'it-pevc';
const USER = current.userId;
const SOURCE = '模块 明月光。\n规则 地上霜，产出 望明月：\n  返回 思故乡。';
const POEM_TEXT = '{"v":1,"terms":[{"kind":"literal","localized":"思故乡","canonical":"静夜思"},{"kind":"struct","localized":"望明月","canonical":"Text"}]}';

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

async function create(body: Record<string, unknown>) {
  const res = await POST_POLICY(new Request('http://localhost/api/policies', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `${P}-poem`, content: SOURCE, locale: 'zh-CN', ...body }),
  }));
  return { status: res.status, body: await res.json() };
}

describe.skipIf(process.env.LICENSE_E2E !== '1' || !LOCAL_ONLY.test(LOCAL_API))('编译门禁经本地 aster-api 编译字面量宏策略', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const previousUrl = process.env.ASTER_POLICY_API_INTERNAL_URL;
  const db = createDb(undefined, { max: 4 });
  const realFetch = globalThis.fetch;
  const compileRequests: Array<Record<string, unknown>> = [];

  async function cleanup() {
    const owned = db.select({ id: policies.id }).from(policies).where(like(policies.name, `${P}%`));
    await db.delete(securityEvents).where(inArray(securityEvents.policyId, owned));
    await db.delete(policyVersions).where(inArray(policyVersions.policyId, owned));
    await db.delete(policies).where(like(policies.name, `${P}%`));
    await db.delete(users).where(eq(users.id, USER));
  }

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
    process.env.ASTER_POLICY_API_INTERNAL_URL = LOCAL_API;
    // 只放行本地 aster-api：任何其他出站请求直接失败（#824）
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(`${LOCAL_API}/`)) throw new Error(`unexpected outbound request: ${url}`);
      if (url.endsWith('/api/v1/policies/compile')) compileRequests.push(JSON.parse(String(init?.body)));
      return realFetch(input, init);
    });
    await cleanup();
    await db.insert(users).values({ id: USER, email: `${USER}@example.test`, updatedAt: new Date() });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await cleanup();
    if (previousUrl === undefined) delete process.env.ASTER_POLICY_API_INTERNAL_URL;
    else process.env.ASTER_POLICY_API_INTERNAL_URL = previousUrl;
    globalForDb.__asterLocalDevDb = previous;
    await db.$client.end();
  });

  it('without the embedded vocabulary the poem does not compile and nothing is stored', async () => {
    const res = await create({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('compile_error');
    expect(JSON.stringify(res.body)).toMatch(/E80[02]/);
    expect(await db.select().from(policies).where(like(policies.name, `${P}%`))).toHaveLength(0);
  });

  it('a policy using a literal macro saves after compiling through aster-api with the merged vocabulary', async () => {
    compileRequests.length = 0;
    const res = await create({ embeddedVocabulary: JSON.parse(POEM_TEXT) });
    expect(res.status).toBe(201);
    expect(compileRequests).toHaveLength(1);
    const vocabulary = compileRequests[0]!.vocabulary as { literals: Array<{ localized: string; canonical: string }> };
    expect(vocabulary.literals).toEqual([expect.objectContaining({ localized: '思故乡', canonical: '静夜思', kind: 'literal' })]);
    const [row] = await db.select().from(policyVersions).where(eq(policyVersions.policyId, res.body.id));
    expect(row!.embeddedVocabulary).toBe(POEM_TEXT);
  });
});
