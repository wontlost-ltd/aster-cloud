// 一致性关键读必须绕过 Hyperdrive 查询缓存（#614）。
//
// Hyperdrive 默认缓存非变更查询约 60s，写入不使缓存失效；含 NOW() 等 STABLE 函数的查询不缓存。
// 本地没有 Hyperdrive 可复现缓存，这里钉住「发到库上的 SQL 文本」：授权 / 回收站这几条读
// 必须带 NOW() 守卫，授予必须是单条 INSERT … ON CONFLICT DO NOTHING（不再先查后插）。
//
// 用真实 drizzle 方言 + 捕获 SQL 的假 postgres 客户端，不 mock 查询构造本身。

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', async () => {
  const schema = await import('@/db/schema');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const queries: string[] = [];
  const result = () => {
    // postgres.js 的查询对象既可直接 await（行对象），也可 .values()（行数组）；两者都返回空结果。
    return Object.assign(Promise.resolve([] as unknown[]), { values: () => Promise.resolve([] as unknown[]) });
  };
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe: (query: string) => {
      queries.push(query);
      return result();
    },
  };
  return { ...schema, db: drizzle(client as never, { schema }), __queries: queries };
});
vi.mock('@/lib/admin-auth', () => ({ requireAdmin: vi.fn(async () => ({ userId: 'admin-1' })) }));
vi.mock('@/lib/license-write-gate', () => ({ requireLicenseWriteOk: vi.fn(async () => null) }));

import * as prisma from '@/lib/prisma';
import { GET, POST } from '@/app/api/admin/structural-alias-grants/route';
import { getStructuralAliasGrant } from '@/lib/structural-alias-grants';
import { getTrashItems, getTrashStats } from '@/lib/policy-lifecycle';

const queries = (prisma as unknown as { __queries: string[] }).__queries;
const FRESH_GUARD = 'NOW() IS NOT NULL';

describe('一致性关键读绕过 Hyperdrive 缓存', () => {
  beforeEach(() => {
    queries.length = 0;
  });

  it('GET /api/admin/structural-alias-grants 的列表查询带 NOW() 守卫', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain(FRESH_GUARD);
  });

  it('getStructuralAliasGrant（编辑器 / 保存校验）带 NOW() 守卫', async () => {
    await expect(getStructuralAliasGrant('user-1')).resolves.toBe(false);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain(FRESH_GUARD);
  });

  it('POST 授予是单条 INSERT … ON CONFLICT DO NOTHING，不经可被缓存的预查', async () => {
    const res = await POST(
      new Request('http://localhost/api/admin/structural-alias-grants', {
        method: 'POST',
        body: JSON.stringify({ userId: 'user-1' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^insert into "StructuralAliasGrant"/);
    expect(queries[0]).toContain('on conflict do nothing');
  });

  it('回收站列表与统计带 NOW() 守卫', async () => {
    await getTrashItems('user-1');
    await getTrashStats('user-1');
    expect(queries).toHaveLength(4);
    for (const q of queries) expect(q).toContain(FRESH_GUARD);
  });
});
