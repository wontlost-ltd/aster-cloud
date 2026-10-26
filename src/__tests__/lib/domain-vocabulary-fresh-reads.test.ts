// 写后读必须绕过 Hyperdrive 查询缓存（复审 P1）：版本轮询、任务列表、任务进度。
// 用真实表定义 + PgDialect 把 WHERE 渲染成 SQL，断言其中带有 bypassQueryCache() 的 `NOW() IS NOT NULL`。
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const captured = vi.hoisted(() => ({ where: [] as unknown[] }));

vi.mock('@/lib/prisma', async () => {
  const schema = await vi.importActual<Record<string, unknown>>('@/db/schema');
  const selectChain = {
    from: () => selectChain,
    where: (cond: unknown) => {
      captured.where.push(cond);
      return Promise.resolve([{ version: 7 }]);
    },
  };
  return {
    ...schema,
    db: {
      select: () => selectChain,
      query: {
        lexiconBulkJobs: {
          findFirst: async (args: { where: unknown }) => {
            captured.where.push(args.where);
            return undefined;
          },
          findMany: async (args: { where: unknown }) => {
            captured.where.push(args.where);
            return [];
          },
        },
      },
    },
  };
});

import { getUserVocabularyVersion } from '@/lib/domain-vocabulary';
import { getBulkJob, listBulkJobs } from '@/lib/domain-vocabulary-jobs';

function lastWhereSql(): string {
  return new PgDialect().sqlToQuery(captured.where.at(-1) as SQL).sql;
}

describe('fresh reads bypass the Hyperdrive query cache', () => {
  it('getUserVocabularyVersion', async () => {
    await expect(getUserVocabularyVersion('user-1')).resolves.toBe('7');
    expect(lastWhereSql()).toContain('NOW() IS NOT NULL');
    expect(lastWhereSql()).toContain('"UserVocabularyVersion"."userId"');
  });

  it('listBulkJobs', async () => {
    await listBulkJobs('user-1', { activeOnly: true });
    expect(lastWhereSql()).toContain('NOW() IS NOT NULL');
  });

  it('getBulkJob', async () => {
    await getBulkJob('user-1', 'job-1');
    expect(lastWhereSql()).toContain('NOW() IS NOT NULL');
  });
});
