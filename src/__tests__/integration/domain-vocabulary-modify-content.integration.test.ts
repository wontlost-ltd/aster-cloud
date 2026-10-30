// 编辑词条的别名 / 描述必须真正落库（真实 Postgres，外部 DATABASE_URL）。
// 2026-10-30 生产复测 F：PATCH 只改 aliases / description 返回 200，但响应与之后的 GET 里
// aliases 仍为 []、description 仍为 null——去重键不含二者，upsert 命中旧的全局词条后直接复用。
// 同时校验：共享同一全局词条的另一租户不受影响（别名 / 描述不跨租户泄漏）。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts domain-vocabulary-modify-content

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { inArray, sql } from 'drizzle-orm';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/usage', () => ({
  getLexiconQuota: vi.fn(async () => ({ maxTerms: 5000, bulkAsync: true, allowed: true })),
}));
vi.mock('@/lib/audit-log', () => ({ logAuditEvent: vi.fn(async () => undefined) }));

import { createDb } from '@/db';
import { domainTerms, userDomainTerms, users } from '@/lib/prisma';
import {
  addUserVocabularyTerm,
  getUserVocabularyTerm,
  modifyUserVocabularyTerm,
  type TermInput,
} from '@/lib/domain-vocabulary';

const AUTHOR = 'user-vocab-modify-content-it';
const OTHER = 'user-vocab-modify-content-other-it';
const DOMAIN = 'e2e1030.modify';

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

async function cleanup(db: Db): Promise<void> {
  await db.delete(userDomainTerms).where(inArray(userDomainTerms.userId, [AUTHOR, OTHER]));
  await db.delete(domainTerms).where(sql`${domainTerms.domain} = ${DOMAIN}`);
  await db.delete(users).where(inArray(users.id, [AUTHOR, OTHER]));
}

const AGE: TermInput = {
  domain: DOMAIN,
  locale: 'de',
  kind: 'field',
  canonical: 'age',
  localized: 'alter',
  parentCanonical: 'Driver',
};

describe.skipIf(process.env.LICENSE_E2E !== '1')('编辑词条的别名与描述落库（复测 F）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db = createDb(undefined, { max: 4 });
  let authorLink = '';
  let otherLink = '';

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
    await cleanup(db);
    await db.insert(users).values([AUTHOR, OTHER].map((id) => (
      { id, email: `${id}@example.test`, updatedAt: new Date() } as typeof users.$inferInsert
    )));
    authorLink = (await addUserVocabularyTerm(AUTHOR, AGE)).link.id;
    otherLink = (await addUserVocabularyTerm(OTHER, AGE)).link.id;
  });

  afterAll(async () => {
    await cleanup(db);
    globalForDb.__asterLocalDevDb = previous;
    await db.$client.end({ timeout: 1 });
  });

  it('两个租户的同一词条起初共享全局词条', async () => {
    const [a, b] = await Promise.all([getUserVocabularyTerm(AUTHOR, authorLink), getUserVocabularyTerm(OTHER, otherLink)]);
    expect(a!.termId).toBe(b!.termId);
  });

  it('只改别名：响应与再次读取都带新别名', async () => {
    const result = await modifyUserVocabularyTerm(AUTHOR, authorLink, { ...AGE, aliases: ['lebensalter'] });
    expect(result.link.aliases).toEqual(['lebensalter']);
    expect(result.repointed).toBe(true);
    expect((await getUserVocabularyTerm(AUTHOR, authorLink))!.aliases).toEqual(['lebensalter']);
  });

  it('只改描述：响应与再次读取都带新描述，别名随请求一并保留', async () => {
    const result = await modifyUserVocabularyTerm(AUTHOR, authorLink, {
      ...AGE,
      aliases: ['lebensalter'],
      description: 'Alter des Fahrers',
    });
    expect(result.link.description).toBe('Alter des Fahrers');
    const reread = await getUserVocabularyTerm(AUTHOR, authorLink);
    expect(reread!.description).toBe('Alter des Fahrers');
    expect(reread!.aliases).toEqual(['lebensalter']);
  });

  /* 第 4 轮生产复测：前端遗漏字段时不能误清空——未提供 = 保持不变，显式 null / [] = 清空 */
  it('★未提供 aliases / description：保持原值', async () => {
    const result = await modifyUserVocabularyTerm(AUTHOR, authorLink, { ...AGE });
    expect(result.link.aliases).toEqual(['lebensalter']);
    expect(result.link.description).toBe('Alter des Fahrers');
  });

  it('另一租户共享的旧全局词条不受影响', async () => {
    const other = await getUserVocabularyTerm(OTHER, otherLink);
    expect(other!.aliases).toEqual([]);
    expect(other!.description).toBeNull();
  });

  it('改回原内容（显式清空别名与描述）：重新指向原全局词条，不新建重复行', async () => {
    const result = await modifyUserVocabularyTerm(AUTHOR, authorLink, { ...AGE, aliases: [], description: null });
    expect(result.createdGlobalTerm).toBe(false);
    const [a, b] = await Promise.all([getUserVocabularyTerm(AUTHOR, authorLink), getUserVocabularyTerm(OTHER, otherLink)]);
    expect(a!.termId).toBe(b!.termId);
    expect(a!.aliases).toEqual([]);
  });
});
