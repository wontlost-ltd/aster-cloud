// 同步批量导入在真实 Postgres 上的行级语义（#606）。
//
// 必须用真库：缺陷的根因是「事务里某条语句触发唯一约束后，事务进入 aborted 状态，
// 后续语句全部失败」——这是 Postgres 的事务语义，mock 复现不了。
// 修复依赖两件事：链接插入用不带目标的 ON CONFLICT DO NOTHING（覆盖部分唯一索引
// UserDomainTerm_active_unique），以及每行一个 SAVEPOINT。

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db, lexiconBulkJobs, userDomainTerms, userVocabularyVersions, users } from '@/lib/prisma';
import { setupTestDb, teardownTestDb } from './setup-postgres';

vi.mock('@/lib/usage', () => ({
  getLexiconQuota: vi.fn().mockResolvedValue({ maxTerms: 5000, bulkAsync: true, allowed: true }),
}));
vi.mock('@/lib/audit-log', () => ({ logAuditEvent: vi.fn().mockResolvedValue(undefined) }));

import {
  addUserVocabularyTerm,
  bulkAddUserVocabularyTerms,
  countActiveUserVocabularyTerms,
  getUserVocabularyVersion,
  modifyUserVocabularyTerm,
  restoreUserVocabularyTerm,
  softDeleteUserVocabularyTerm,
  type TermInput,
} from '@/lib/domain-vocabulary';
import { processBulkJobChunk } from '@/lib/domain-vocabulary-job-runner';
import { cancelBulkJob, processQueuedBulkJobs } from '@/lib/domain-vocabulary-jobs';
import { purgeUserVocabulary } from '@/lib/domain-vocabulary-retention';
import { getLexiconQuota } from '@/lib/usage';

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

describe.skipIf(process.env.LICENSE_E2E !== '1')('bulk import / version / worker lease on real Postgres（#605 #606 #608）', () => {
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
      claimedBy: 'worker-a',
      claimedAt: new Date(),
    });

    const outcome = await processBulkJobChunk({
      id: jobId,
      userId: USER,
      rowCount: 3,
      processed: 0,
      rollup: {},
      errors: [],
      inputJson: [row('Driver'), row('Vehicle'), row('Accident')],
      claimedBy: 'worker-a',
    });

    expect(outcome.finished).toBe(true);
    expect(outcome.rollupDelta).toMatchObject({ added: 2, errorCount: 1 });
    expect(outcome.errorsDelta.map((e) => e.code)).toEqual(['duplicate_link']);
    expect(await activeCanonicalCount()).toBe(3);
  });

  async function version(): Promise<number> {
    return Number(await getUserVocabularyVersion(USER));
  }

  async function activeLinkIds(): Promise<string[]> {
    const rows = await db
      .select({ id: userDomainTerms.id })
      .from(userDomainTerms)
      .where(and(eq(userDomainTerms.userId, USER), isNull(userDomainTerms.deletedAt)))
      .orderBy(asc(userDomainTerms.createdAt));
    return rows.map((r) => r.id);
  }

  it('版本号单调递增：批量、编辑非最新行、删除、恢复都会改变（#608）', async () => {
    expect(await version()).toBe(0);

    await bulkAddUserVocabularyTerms(USER, [row('Driver'), row('Vehicle')]);
    const afterBulk = await version();
    expect(afterBulk).toBeGreaterThan(0);
    expect(await countActiveUserVocabularyTerms(USER)).toBe(2);

    // 编辑「不是最新 updatedAt」的那一行：旧的「条数 + max(updatedAt)」方案会漏掉。
    const [oldest] = await activeLinkIds();
    await modifyUserVocabularyTerm(USER, oldest, { ...row('Driver'), localized: 'Fahrer' });
    const afterEdit = await version();
    expect(afterEdit).toBeGreaterThan(afterBulk);

    await softDeleteUserVocabularyTerm(USER, oldest);
    const afterDelete = await version();
    expect(afterDelete).toBeGreaterThan(afterEdit);

    await restoreUserVocabularyTerm(USER, oldest);
    expect(await version()).toBeGreaterThan(afterDelete);
  });

  it('同一时刻删一条、加一条（条数与时间戳都不变）版本仍会变化（#608）', async () => {
    await bulkAddUserVocabularyTerms(USER, [row('Driver'), row('Vehicle')]);
    const [first, second] = await activeLinkIds();
    const [secondRow] = await db.select().from(userDomainTerms).where(eq(userDomainTerms.id, second));
    const before = await version();
    const fixed = new Date('2030-01-01T00:00:00.000Z');
    await db.transaction(async (tx) => {
      await tx
        .update(userDomainTerms)
        .set({ deletedAt: fixed, updatedAt: fixed })
        .where(eq(userDomainTerms.id, first));
      await tx.insert(userDomainTerms).values({
        ...secondRow,
        id: crypto.randomUUID(),
        termId: (await tx.select({ termId: userDomainTerms.termId }).from(userDomainTerms).where(eq(userDomainTerms.id, first)))[0].termId,
        createdAt: fixed,
        updatedAt: fixed,
        deletedAt: null,
      });
    });
    expect(await version()).toBe(before + 2);
  });

  it('删除用户时级联清掉版本行，不因触发器而失败', async () => {
    await bulkAddUserVocabularyTerms(USER, [row('Driver')]);
    expect(await version()).toBeGreaterThan(0);
    await db.delete(users).where(eq(users.id, USER));
    const rows = await db
      .select()
      .from(userVocabularyVersions)
      .where(eq(userVocabularyVersions.userId, USER));
    expect(rows).toEqual([]);
  });

  async function insertRunningJob(inputJson: TermInput[], claimedBy: string, claimedAt: Date) {
    const id = crypto.randomUUID();
    await db.insert(lexiconBulkJobs).values({
      id,
      userId: USER,
      status: 'running',
      mode: 'async',
      rowCount: inputJson.length,
      processed: 0,
      rollup: {},
      errors: [],
      inputJson,
      claimedBy,
      claimedAt,
    });
    return id;
  }

  async function loadJob(id: string) {
    const [job] = await db.select().from(lexiconBulkJobs).where(eq(lexiconBulkJobs.id, id));
    return job;
  }

  it('chunk 处理中被取消：worker 提交落空、链接回滚，任务保持 cancelled（复审 P1）', async () => {
    const id = await insertRunningJob([row('Vehicle'), row('Accident')], 'worker-a', new Date());
    const snapshot = await loadJob(id);

    await expect(cancelBulkJob(USER, id)).resolves.toEqual({ cancelled: true });
    const outcome = await processBulkJobChunk(snapshot);

    expect(outcome.lostClaim).toBe(true);
    const after = await loadJob(id);
    expect(after.status).toBe('cancelled');
    expect(after.processed).toBe(0);
    expect(await activeCanonicalCount()).toBe(0);
  });

  it('认领超时被回收后由另一 worker 完成；原 worker 迟到的提交落空（复审 P1）', async () => {
    const stale = new Date(Date.now() - 10 * 60_000);
    const id = await insertRunningJob([row('Vehicle'), row('Accident')], 'worker-a', stale);
    const staleSnapshot = await loadJob(id);

    const summary = await processQueuedBulkJobs({ workerId: 'worker-b', maxJobs: 4 });
    expect(summary).toMatchObject({ recovered: 1, completed: 1 });
    const completed = await loadJob(id);
    expect(completed).toMatchObject({ status: 'completed', processed: 2 });
    expect(completed.rollup).toMatchObject({ added: 2 });

    const late = await processBulkJobChunk(staleSnapshot);
    expect(late.lostClaim).toBe(true);
    const after = await loadJob(id);
    expect(after).toMatchObject({ status: 'completed', processed: 2 });
    expect(after.rollup).toEqual(completed.rollup);
    expect(await activeCanonicalCount()).toBe(2);
  });

  it('两个 worker 同时跑：同一任务只被处理一次', async () => {
    const id = crypto.randomUUID();
    await db.insert(lexiconBulkJobs).values({
      id,
      userId: USER,
      status: 'queued',
      mode: 'async',
      rowCount: 2,
      processed: 0,
      rollup: {},
      errors: [],
      inputJson: [row('Vehicle'), row('Accident')],
    });

    const [a, b] = await Promise.all([
      processQueuedBulkJobs({ workerId: 'worker-a', maxJobs: 4 }),
      processQueuedBulkJobs({ workerId: 'worker-b', maxJobs: 4 }),
    ]);

    expect(a.completed + b.completed).toBe(1);
    const job = await loadJob(id);
    expect(job).toMatchObject({ status: 'completed', processed: 2 });
    expect(job.rollup).toMatchObject({ added: 2, errorCount: 0 });
    expect(await activeCanonicalCount()).toBe(2);
  });

  it('语句级触发器：一次写 250 行的批量导入只让版本 +1（复审 P2）', async () => {
    const before = await version();
    const rows = Array.from({ length: 250 }, (_, i) => row(`Bulk${i}`));
    const result = await bulkAddUserVocabularyTerms(USER, rows);
    expect(result.rollup.added).toBe(250);
    expect(await version()).toBe(before + 1);
  });

  it('DSAR 清理（保留用户）同时删除版本行（复审 P2）', async () => {
    await bulkAddUserVocabularyTerms(USER, [row('Driver')]);
    expect(await version()).toBeGreaterThan(0);
    await purgeUserVocabulary(USER);
    const rows = await db
      .select()
      .from(userVocabularyVersions)
      .where(eq(userVocabularyVersions.userId, USER));
    expect(rows).toEqual([]);
    expect(await activeCanonicalCount()).toBe(0);
  });

  it('异步 chunk 与单条新增、同步批量并发时不会越过配额（复审 P1）', async () => {
    const MAX = 5;
    vi.mocked(getLexiconQuota).mockResolvedValue({ maxTerms: MAX, bulkAsync: true, allowed: true });
    try {
      for (let round = 0; round < 3; round += 1) {
        await db.delete(userDomainTerms).where(eq(userDomainTerms.userId, USER));
        const asyncRows = Array.from({ length: MAX }, (_, i) => row(`Async${round}x${i}`));
        const jobId = await insertRunningJob(asyncRows, `worker-${round}`, new Date());
        const job = await loadJob(jobId);

        await Promise.allSettled([
          processBulkJobChunk(job),
          bulkAddUserVocabularyTerms(USER, [row(`Sync${round}a`), row(`Sync${round}b`), row(`Sync${round}c`)]),
          ...[0, 1, 2].map((i) => addUserVocabularyTerm(USER, row(`Single${round}x${i}`))),
        ]);

        expect(await countActiveUserVocabularyTerms(USER)).toBe(MAX);
      }
    } finally {
      vi.mocked(getLexiconQuota).mockResolvedValue({ maxTerms: 5000, bulkAsync: true, allowed: true });
    }
  });
});
