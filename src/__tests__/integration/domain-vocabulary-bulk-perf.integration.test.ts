// 250 行 chunk 的耗时与数据库往返次数（#606 复审 P2）。只做测量与上限断言，结果打印到日志。
//
// 往返次数 = drizzle 发出的语句数 + 每个 SAVEPOINT 的 2 次（SAVEPOINT / RELEASE）。
// 生产经 Hyperdrive 连库，单次往返远比本地贵，所以这里关心的是「次数」而不是本地毫秒数。

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { PostgresJsPreparedQuery, PostgresJsTransaction } from 'drizzle-orm/postgres-js';
import { db, users } from '@/lib/prisma';
import { setupTestDb, teardownTestDb } from './setup-postgres';

vi.mock('@/lib/usage', () => ({
  getLexiconQuota: vi.fn().mockResolvedValue({ maxTerms: -1, bulkAsync: true, allowed: true }),
}));
vi.mock('@/lib/audit-log', () => ({ logAuditEvent: vi.fn().mockResolvedValue(undefined) }));

import { bulkAddUserVocabularyTerms, type TermInput } from '@/lib/domain-vocabulary';

const USER = 'vocab-bulk-perf-user';
const CHUNK = 250;

describe.skipIf(process.env.LICENSE_E2E !== '1')('bulk chunk cost（250 行）', () => {
  beforeAll(async () => {
    await setupTestDb();
    await db.delete(users).where(eq(users.id, USER));
    await db.insert(users).values({ id: USER, updatedAt: new Date() } as typeof users.$inferInsert);
  }, 120_000);

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, USER));
    await teardownTestDb();
  });

  it('一个 250 行 chunk（其中 10% 重复）的耗时与往返次数', async () => {
    const domain = `perf.r${Date.now().toString(36)}`;
    const rows: TermInput[] = Array.from({ length: CHUNK }, (_, i) => ({
      domain,
      locale: 'en',
      kind: 'struct',
      canonical: `Term${i % 225}`,
      localized: `Term ${i % 225}`,
    }));

    const executeSpy = vi.spyOn(PostgresJsPreparedQuery.prototype, 'execute');
    const savepointSpy = vi.spyOn(PostgresJsTransaction.prototype, 'transaction');
    const started = performance.now();
    const result = await bulkAddUserVocabularyTerms(USER, rows);
    const elapsedMs = Math.round(performance.now() - started);
    const statements = executeSpy.mock.calls.length;
    const savepoints = savepointSpy.mock.calls.length;
    executeSpy.mockRestore();
    savepointSpy.mockRestore();

    const roundTrips = statements + savepoints * 2;
    console.log(
      `[bulk-perf] rows=${CHUNK} elapsedMs=${elapsedMs} statements=${statements} savepoints=${savepoints} roundTrips≈${roundTrips}`,
    );
    expect(result.rollup.added).toBe(225);
    expect(result.errors.filter((e) => e.code === 'duplicate_link')).toHaveLength(25);
    expect(roundTrips).toBeLessThan(Number(process.env.BULK_PERF_MAX_ROUND_TRIPS ?? 50));
  });
});
