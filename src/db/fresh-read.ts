/**
 * 必须新鲜的读：绕过 Hyperdrive 查询缓存（#614 → #624）。
 *
 * 背景：生产经 Hyperdrive 连库，默认 HYPERDRIVE 配置缓存非变更查询
 * （max_age 60s + stale_while_revalidate 15s），且写入**不会**让已缓存的读失效，
 * 「写后立刻读」会在窗口内拿到旧结果。
 *
 * 主方案：一致性敏感的读用 freshDb，经关闭缓存（--caching-disabled）的第二个绑定
 * HYPERDRIVE_FRESH 执行，整条连接都不缓存，不必逐条查询打补丁。
 *
 * bypassQueryCache() 只留给**子查询构造器**（如 policy-access 的 teamsAllowing / teamMemberIds）：
 * 它们被嵌进调用方在缓存连接（全局 db）上执行的外层查询，无法改连接，只能靠恒真谓词
 * `NOW() IS NOT NULL` 让整条语句不可缓存（Hyperdrive 不缓存含 NOW() 等 STABLE/VOLATILE 函数的查询）。
 * 能直接选择连接的读一律用 freshDb，不要再并入该谓词。
 */
import { sql, type SQL } from 'drizzle-orm';
import { getCloudflareEnvSync } from '@/db/binding';
import { db, getFreshDb, type Database } from '@/lib/prisma';

/**
 * 一致性敏感读用的数据库实例：有 HYPERDRIVE_FRESH 绑定时经 getFreshDb() 走关闭缓存的配置，
 * 否则就是全局 db（Node 运行时 / on-prem / 测试都没有 Hyperdrive 缓存）。
 * 只用于事务之外的读：它是另一条连接，看不到当前事务里未提交的写入。
 *
 * 不直接引入 @/db：本模块被大量单测间接加载，这些单测只 mock 了 @/lib/prisma，
 * 引入 @/db 会连带加载 schema 与 postgres 驱动。
 */
export const freshDb = new Proxy({} as Database, {
  get(_target, prop) {
    const actual = getCloudflareEnvSync()?.HYPERDRIVE_FRESH?.connectionString ? getFreshDb() : db;
    return Reflect.get(actual, prop, actual);
  },
});

/** 仅供嵌入缓存连接上外层查询的子查询使用，见文件头说明。 */
export function bypassQueryCache(): SQL {
  return sql`NOW() IS NOT NULL`;
}
