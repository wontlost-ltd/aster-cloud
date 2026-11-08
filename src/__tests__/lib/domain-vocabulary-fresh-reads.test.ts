// 写后读必须绕过 Hyperdrive 查询缓存（复审 P1）：版本轮询、任务列表、任务进度。
// 断言这些读落在 freshDb（关闭缓存的 HYPERDRIVE_FRESH，#624）上；WHERE 仍用真实表定义 + PgDialect 渲染核对过滤条件。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const captured = vi.hoisted(() => ({
  where: [] as unknown[],
  from: [] as unknown[],
  // 每次查询所用连接：'cached'（全局 db）或 'fresh'（freshDb）。
  conn: [] as string[],
  // 依次消费的查询结果；元素为 Error 时该次查询抛错（模拟迁移窗口内缺表）。
  results: [] as unknown[],
}));

// 全局 db 与 freshDb 各一个桩，记录每次查询落在哪条连接上（#624：一致性敏感读走关闭缓存的绑定）。
function makeDb(conn: 'cached' | 'fresh') {
  const selectChain = {
    from: (table: unknown) => {
      captured.from.push(table);
      return selectChain;
    },
    where: (cond: unknown) => {
      captured.where.push(cond);
      captured.conn.push(conn);
      const next = captured.results.length > 0 ? captured.results.shift() : [{ version: 7 }];
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
  const record = async (args: { where: unknown }, rows: unknown) => {
    captured.where.push(args.where);
    captured.conn.push(conn);
    return rows;
  };
  return {
    select: () => selectChain,
    query: {
      lexiconBulkJobs: {
        findFirst: (args: { where: unknown }) => record(args, undefined),
        findMany: (args: { where: unknown }) => record(args, []),
      },
    },
  };
}

vi.mock('@/lib/prisma', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@/db/schema')),
  db: makeDb('cached'),
}));
vi.mock('@/db/fresh-read', () => ({ freshDb: makeDb('fresh') }));

import { getUserVocabularyVersion } from '@/lib/domain-vocabulary';
import { userDomainTerms, userVocabularyVersions } from '@/db/schema';
import { getBulkJob, listBulkJobs } from '@/lib/domain-vocabulary-jobs';

function lastWhereSql(): string {
  return new PgDialect().sqlToQuery(captured.where.at(-1) as SQL).sql;
}

beforeEach(() => {
  captured.where.length = 0;
  captured.from.length = 0;
  captured.conn.length = 0;
  captured.results.length = 0;
});

describe('fresh reads go through freshDb (uncached Hyperdrive binding)', () => {
  it('getUserVocabularyVersion', async () => {
    await expect(getUserVocabularyVersion('user-1')).resolves.toBe('7');
    expect(captured.conn.at(-1)).toBe('fresh');
    expect(lastWhereSql()).toContain('"UserVocabularyVersion"."userId"');
  });

  it('listBulkJobs', async () => {
    await listBulkJobs('user-1', { activeOnly: true });
    expect(captured.conn.at(-1)).toBe('fresh');
  });

  it('getBulkJob', async () => {
    await getBulkJob('user-1', 'job-1');
    expect(captured.conn.at(-1)).toBe('fresh');
  });
});

// 迁移窗口容错：Worker 先于 k3s PostSync 迁移 Job 部署时 UserVocabularyVersion 尚不存在。
describe('getUserVocabularyVersion — 迁移 0059 未应用（42P01）', () => {
  const undefinedTable = () =>
    Object.assign(new Error('Failed query: select "version" from "UserVocabularyVersion"'), {
      cause: Object.assign(new Error('relation "UserVocabularyVersion" does not exist'), { code: '42P01' }),
    });

  it('退回 UserDomainTerm 指纹，且同样绕过缓存、按用户过滤', async () => {
    captured.results.push(undefinedTable(), [{ count: 3, lastChange: '1761480000000' }]);
    await expect(getUserVocabularyVersion('user-1')).resolves.toBe('fp:3:1761480000000');
    expect(captured.from).toEqual([userVocabularyVersions, userDomainTerms]);
    expect(captured.conn.at(-1)).toBe('fresh');
    expect(lastWhereSql()).toContain('"UserDomainTerm"."userId"');
  });

  it('没有任何词条的用户得到稳定的空指纹', async () => {
    captured.results.push(undefinedTable(), [{ count: 0, lastChange: null }]);
    await expect(getUserVocabularyVersion('user-1')).resolves.toBe('fp:0:0');
  });

  it('指纹带 fp: 前缀，不会与真实数字版本相撞（迁移落地后客户端刷新一次即可）', async () => {
    captured.results.push(undefinedTable(), [{ count: 7, lastChange: '7' }]);
    const fallback = await getUserVocabularyVersion('user-1');
    captured.results.push([{ version: 7 }]);
    const real = await getUserVocabularyVersion('user-1');
    expect(real).toBe('7');
    expect(fallback).not.toBe(real);
  });

  it('42P01 以外的错误不吞，照常抛出', async () => {
    captured.results.push(Object.assign(new Error('connection reset'), { code: '08006' }));
    await expect(getUserVocabularyVersion('user-1')).rejects.toThrow('connection reset');
    expect(captured.from).toEqual([userVocabularyVersions]);
  });
});
