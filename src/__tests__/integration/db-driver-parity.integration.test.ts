// #842：Worker 数据库驱动从 postgres-js 换成 node-postgres 后，原生 `db.execute()` 结果的取值语义不变。
//
// 同一条 SQL 分别经旧驱动（drizzle + postgres-js，#842 之前的 createDb 配置）与新驱动（createDb）执行，
// 逐列比较取出的应用层值：时间戳、bigint、numeric、布尔、json/jsonb、数组、空值，以及原生 SQL 里的
// Date / bigint / 数组 / 对象参数。业务代码里的原生查询（执行路由的统一查询、熔断统计、
// 回放候选等）都依赖这些值的形态。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts db-driver-parity

import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { drizzle as drizzlePostgresJs } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createDb } from '@/db';
import { rowsOf } from '@/db/result';
import { affectedRows } from '@/lib/retention/batching';

describe.skipIf(process.env.LICENSE_E2E !== '1')('db.execute 取值：node-postgres 与 postgres-js 一致（真实 Postgres）', () => {
  const pg = createDb(undefined, { max: 2 });
  const legacyClient = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  const legacy = drizzlePostgresJs(legacyClient);

  afterAll(async () => {
    await pg.$client.end();
    await legacyClient.end({ timeout: 1 });
  });

  async function both(query: ReturnType<typeof sql>) {
    const [a, b] = await Promise.all([pg.execute(query), legacy.execute(query)]);
    return { next: rowsOf<Record<string, unknown>>(a), prev: rowsOf<Record<string, unknown>>(b) };
  }

  it('各类列类型取出的值逐列相同', async () => {
    const { next, prev } = await both(sql`
      SELECT
        TIMESTAMPTZ '2026-01-02 03:04:05.678+00' AS ts_tz,
        TIMESTAMP '2026-01-02 03:04:05.678' AS ts,
        DATE '2026-01-02' AS d,
        INTERVAL '1 day 2 hours' AS iv,
        9007199254740993::bigint AS big,
        count(*) AS cnt,
        42::int AS i,
        1.25::numeric AS num,
        1.5::float8 AS f,
        true AS b,
        '{"a":[1,"x"],"n":null}'::jsonb AS jb,
        '{"k":1}'::json AS j,
        ARRAY['x','y']::text[] AS arr,
        ARRAY[1,2]::int[] AS iarr,
        NULL::text AS nul
      FROM (VALUES (1), (2)) v(x)
    `);
    expect(next).toEqual(prev);
    // 关键形态显式断言：时间戳是字符串（drizzle 两个适配器都关掉了日期解析），bigint / count 是字符串。
    expect(typeof next[0].ts_tz).toBe('string');
    expect(next[0].cnt).toBe('2');
    expect(next[0].big).toBe('9007199254740993');
    expect(next[0].arr).toEqual(['x', 'y']);
    expect(next[0].jb).toEqual({ a: [1, 'x'], n: null });
  });

  it('原生 SQL 参数：ISO 时间串、bigint、数组展开、JSON 文本在两个驱动下得到相同结果', async () => {
    const at = new Date('2026-03-04T05:06:07.000Z').toISOString();
    const lockKey = BigInt('-1234567890123456789');
    const ids = ['a', 'b'];
    const payload = JSON.stringify({ k: 'v' });
    const { next, prev } = await both(sql`
      SELECT
        ${at}::timestamp AS at,
        ${lockKey}::bigint AS lock_key,
        ${'b'} IN ${ids} AS has_b,
        ${payload}::jsonb ->> 'k' AS k
    `);
    expect(next).toEqual(prev);
    expect(next[0].lock_key).toBe('-1234567890123456789');
    expect(next[0].has_b).toBe(true);
  });

  it('RETURNING 的行与 delete / update 的受影响行数', async () => {
    // 临时表按连接可见：两条语句必须在同一条连接上，放进事务里执行。
    const counts = await pg.transaction(async (tx) => {
      await tx.execute(sql`CREATE TEMP TABLE parity_tx (id int) ON COMMIT DROP`);
      const inserted = rowsOf<{ id: number }>(
        await tx.execute(sql`INSERT INTO parity_tx SELECT generate_series(1, 3) RETURNING id`),
      );
      const updated = affectedRows(await tx.execute(sql`UPDATE parity_tx SET id = id + 10 WHERE id > 1`));
      return { inserted: inserted.map((r) => r.id), updated };
    });
    expect(counts).toEqual({ inserted: [1, 2, 3], updated: 2 });
  });
});
