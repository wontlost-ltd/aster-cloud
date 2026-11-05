/**
 * 数据库访问层 - Drizzle ORM
 * 此文件保持 'prisma' 导出名称以减少迁移工作量
 * 实际使用 Drizzle ORM 连接 PostgreSQL
 *
 * Cloudflare Workers 兼容性说明：
 * - 在 Cloudflare Workers 中，Hyperdrive binding 只在请求处理期间可用
 * - getDb() 已更新为自动检测 Cloudflare 环境
 * - 在 API 路由和服务器组件中，调用发生在请求处理期间，所以可以正常工作
 */

import { getDb, getDbAsync, getFreshDb, createDb, type Database } from '@/db';

/**
 * 获取数据库实例
 * 在 Cloudflare Workers 中会自动检测并使用 Hyperdrive
 * 在本地开发环境使用 DATABASE_URL
 *
 * 注意：这是一个 getter，每次调用都会检测环境
 * 这确保在 Cloudflare Workers 中正确获取 Hyperdrive binding
 */
export const db = new Proxy({} as Database, {
  get(_target, prop, _receiver) {
    // 每次属性访问时动态获取 db 实例
    const actualDb = getDb();
    return Reflect.get(actualDb, prop, actualDb);
  },
});

// 导出 getDb 函数用于需要显式控制的场景
export { getDb, getDbAsync, getFreshDb };

// 导出类型
export type { Database };

// 导出 createDb 用于需要手动传递 env 的场景
export { createDb };

// 重新导出 schema 以便查询使用
export * from '@/db/schema';
