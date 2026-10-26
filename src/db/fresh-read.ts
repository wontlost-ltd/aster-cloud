/**
 * 必须新鲜的读：绕过 Hyperdrive 查询缓存。
 *
 * 背景（#614）：生产经 Hyperdrive 连库，Hyperdrive 默认缓存非变更查询
 * （max_age 60s + stale_while_revalidate 15s），且写入**不会**让已缓存的读失效。
 * 于是「写后立刻读」会在窗口内拿到旧结果——例如管理员授予结构词别名后，
 * 授权管理卡约 100 秒内仍显示未授权。
 *
 * 做法：Hyperdrive 不缓存含 STABLE / VOLATILE 函数的查询（官方文档明确列出 NOW() 不缓存）。
 * 往 WHERE 里并入恒真条件 `NOW() IS NOT NULL`，查询语义与结果形状都不变，但不再被缓存。
 * 本地 / Node 运行时没有 Hyperdrive，此条件只是一个无副作用的恒真谓词。
 *
 * 只用于一致性关键的读：权限 / 授权状态、管理端配置、写后即读。高频且可容忍短暂陈旧的读
 * 不要用，否则白白放弃缓存收益。
 *
 * 不靠 SQL 注释做缓存控制：Hyperdrive 文档明确说注释不是受支持的缓存开关。
 * 若将来需要成批的新鲜读，官方推荐的长期方案是再建一个 `--caching-disabled` 的
 * Hyperdrive 配置并绑定为第二个 binding（需人工在 Cloudflare 侧创建）。
 */
import { sql, type SQL } from 'drizzle-orm';

export function bypassQueryCache(): SQL {
  return sql`NOW() IS NOT NULL`;
}
