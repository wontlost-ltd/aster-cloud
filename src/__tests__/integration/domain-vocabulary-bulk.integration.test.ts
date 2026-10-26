// 同步批量导入在真实 Postgres 上的行级语义（#606）。
//
// 必须用真库：缺陷的根因是「事务里某条语句触发唯一约束后，事务进入 aborted 状态，
// 后续语句全部失败」——这是 Postgres 的事务语义，mock 复现不了。
// 修复依赖两件事：链接插入用不带目标的 ON CONFLICT DO NOTHING（覆盖部分唯一索引
// UserDomainTerm_active_unique），以及每行一个 SAVEPOINT。

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { db, userDomainTerms, users } from '@/lib/prisma';
import { setupTestDb, teardownTestDb } from './setup-postgres';

vi.mock('@/lib/usage', () => ({
  getLexiconQuota: vi.fn().mockResolvedValue({ maxTerms: 5000, bulkAsync: true, allowed: true }),
}));
vi.mock('@/lib/audit-log', () => ({ logAuditEvent: vi.fn().mockResolvedValue(undefined) }));

import {
  bulkAddUserVocabularyTerms,
  countActiveUserVocabularyTerms,
  getUserVocabularyVersion,
  softDeleteUserVocabularyTerm,
  type TermInput,
} from '@/lib/domain-vocabulary';
import { processBulkJobChunk } from '@/lib/domain-vocabulary-job-runner';

const USER = 'vocab-bulk-it-user';
// 全局 DomainTerm 不随用户删除而清理；每个用例用独立 domain，「新增 vs 复用」才可断言。
let domain = 'insurance.auto';
const row = (canonical: string): TermInput => ({
  domain,
  locale: 'de',
  kind: 'struct',
  canonical,
  localized: canonical,
});

async function activeCanonicalCount(): Promise<number> {
  const rows = await db
    .select({ id: userDomainTerms.id })
    .from(userDomainTerms)
    .where(and(eq(userDomainTerms.userId, USER), isNull(userDomainTerms.deletedAt)));
  return rows.length;
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('bulk import on real Postgres（#606）', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 120_000);

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, USER));
    await teardownTestDb();
  });

  beforeEach(async () => {
    domain = `insurance.r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await db.delete(users).where(eq(users.id, USER));
    await db.insert(users).values({ id: USER, updatedAt: new Date() } as typeof users.$inferInsert);
  });

  it('同步：已有的 Driver 报 duplicate_link，9bad 报 validation_failed，其余两行照常导入', async () => {
    await bulkAddUserVocabularyTerms(USER, [row('Driver')]);

    const result = await bulkAddUserVocabularyTerms(USER, [
      row('Policyholder'),
      row('premium'),
      row('9bad'),
      row('Driver'),
    ]);

    expect(result.rollup).toMatchObject({ added: 2, skipped: 2, errorCount: 2 });
    expect(result.errors.map((e) => [e.row, e.code])).toEqual([
      [2, 'validation_failed'],
      [3, 'duplicate_link'],
    ]);
    expect(JSON.stringify(result.errors)).not.toMatch(/constraint|UserDomainTerm_active_unique/);
    expect(await activeCanonicalCount()).toBe(3);
  });

  it('同一批里出现两次同一词条：第二次报 duplicate_link，第一次正常落库', async () => {
    const result = await bulkAddUserVocabularyTerms(USER, [row('Claim'), row('Claim')]);
    expect(result.rollup).toMatchObject({ added: 1, errorCount: 1 });
    expect(result.errors).toEqual([
      { row: 1, code: 'duplicate_link', message: 'You already have this term in your vocabulary' },
    ]);
    expect(await activeCanonicalCount()).toBe(1);
  });

  it('异步 worker 同样按行处理重复', async () => {
    await bulkAddUserVocabularyTerms(USER, [row('Driver')]);
    const jobId = crypto.randomUUID();
    const { lexiconBulkJobs } = await import('@/lib/prisma');
    await db.insert(lexiconBulkJobs).values({
      id: jobId,
      userId: USER,
      status: 'running',
      mode: 'async',
      rowCount: 3,
      processed: 0,
      rollup: {},
      errors: [],
      inputJson: [row('Driver'), row('Vehicle'), row('Accident')],
    });

    const outcome = await processBulkJobChunk({
      id: jobId,
      userId: USER,
      rowCount: 3,
      processed: 0,
      rollup: {},
      errors: [],
      inputJson: [row('Driver'), row('Vehicle'), row('Accident')],
    });

    expect(outcome.finished).toBe(true);
    expect(outcome.rollupDelta).toMatchObject({ added: 2, errorCount: 1 });
    expect(outcome.errorsDelta.map((e) => e.code)).toEqual(['duplicate_link']);
    expect(await activeCanonicalCount()).toBe(3);
  });

  it('版本号随新增/删除变化，并可按 domain/locale 收窄（#608）', async () => {
    const empty = await getUserVocabularyVersion(USER);
    expect(empty).toBe('0-0');

    await bulkAddUserVocabularyTerms(USER, [row('Driver'), row('Vehicle')]);
    const afterAdd = await getUserVocabularyVersion(USER);
    expect(afterAdd).toMatch(/^2-\d{13}$/);
    expect(await getUserVocabularyVersion(USER, { domain, locale: 'de' })).toBe(afterAdd);
    expect(await getUserVocabularyVersion(USER, { domain: 'finance' })).toBe('0-0');
    expect(await countActiveUserVocabularyTerms(USER)).toBe(2);

    const [link] = await db
      .select({ id: userDomainTerms.id })
      .from(userDomainTerms)
      .where(eq(userDomainTerms.userId, USER))
      .limit(1);
    await softDeleteUserVocabularyTerm(USER, link.id);
    const afterDelete = await getUserVocabularyVersion(USER);
    expect(afterDelete).not.toBe(afterAdd);
    expect(afterDelete.startsWith('1-')).toBe(true);
  });
});
