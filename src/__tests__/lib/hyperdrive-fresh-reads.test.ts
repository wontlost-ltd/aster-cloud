// 一致性关键读必须绕过 Hyperdrive 查询缓存（#614 → #624）。
//
// Hyperdrive 默认配置缓存非变更查询约 60s，写入不使缓存失效。#624 起这些读改走关闭缓存的
// 第二个绑定 HYPERDRIVE_FRESH（@/db/fresh-read 的 freshDb），不再逐条并入 NOW() 守卫。
// 本地没有 Hyperdrive，这里钉住「SQL 发到了哪条连接」：全局 db 与 freshDb 各接一个捕获 SQL 的
// 假 postgres 客户端，授权 / 回收站这几条读必须全部落在 fresh 连接上；授予必须是单条
// INSERT … ON CONFLICT DO NOTHING（不再先查后插）。
//
// 用真实 drizzle 方言，不 mock 查询构造本身。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ cached: [] as string[], fresh: [] as string[] }));

async function captureDb(sink: string[]) {
  const schema = await import('@/db/schema');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  // postgres.js 的查询对象既可直接 await（行对象），也可 .values()（行数组）；两者都返回空结果。
  const result = () =>
    Object.assign(Promise.resolve([] as unknown[]), { values: () => Promise.resolve([] as unknown[]) });
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe: (query: string) => {
      sink.push(query);
      return result();
    },
  };
  return drizzle(client as never, { schema });
}

vi.mock('@/lib/prisma', async () => ({ ...(await import('@/db/schema')), db: await captureDb(log.cached) }));
// 保留真实的 bypassQueryCache（policy-access 的子查询构造器仍在用），只替换 freshDb
vi.mock('@/db/fresh-read', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db/fresh-read')>()),
  freshDb: await captureDb(log.fresh),
}));
vi.mock('@/lib/admin-auth', () => ({ requireAdmin: vi.fn(async () => ({ userId: 'admin-1' })) }));
vi.mock('@/lib/license-write-gate', () => ({ requireLicenseWriteOk: vi.fn(async () => null) }));

import { GET, POST } from '@/app/api/admin/structural-alias-grants/route';
import { getStructuralAliasGrant } from '@/lib/structural-alias-grants';
import { getTrashItems, getTrashStats } from '@/lib/policy-lifecycle';


describe('一致性关键读绕过 Hyperdrive 缓存', () => {
  beforeEach(() => {
    log.cached.length = 0;
    log.fresh.length = 0;
  });

  it('GET /api/admin/structural-alias-grants 的列表查询走 fresh 连接', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(log.cached).toHaveLength(0);
    expect(log.fresh).toHaveLength(1);
    expect(log.fresh[0]).toMatch(/from "User"/);
  });

  it('getStructuralAliasGrant（编辑器 / 保存校验）走 fresh 连接', async () => {
    await expect(getStructuralAliasGrant('user-1')).resolves.toBe(false);
    expect(log.cached).toHaveLength(0);
    expect(log.fresh).toHaveLength(1);
    expect(log.fresh[0]).toContain('"StructuralAliasGrant"');
  });

  it('POST 授予是单条 INSERT … ON CONFLICT DO NOTHING，不经可被缓存的预查', async () => {
    const res = await POST(
      new Request('http://localhost/api/admin/structural-alias-grants', {
        method: 'POST',
        body: JSON.stringify({ userId: 'user-1' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(log.fresh).toHaveLength(0);
    expect(log.cached).toHaveLength(1);
    expect(log.cached[0]).toMatch(/^insert into "StructuralAliasGrant"/);
    expect(log.cached[0]).toContain('on conflict do nothing');
  });

  it('回收站列表与统计全部走 fresh 连接', async () => {
    await getTrashItems('user-1');
    await getTrashStats('user-1');
    expect(log.cached).toHaveLength(0);
    expect(log.fresh).toHaveLength(4);
    for (const q of log.fresh) expect(q).toContain('"PolicyRecycleBin"');
  });
});
