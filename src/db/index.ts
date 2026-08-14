/**
 * 数据库连接配置
 * 支持 Cloudflare Workers/Pages 环境（通过 Hyperdrive）和本地开发环境
 *
 * 性能说明：
 * - Cloudflare Workers: Hyperdrive 负责连接池，每次 getDb() 获取预热连接
 * - 本地开发：使用模块级单例避免连接泄漏
 * - 使用 AsyncLocalStorage 实现请求级别的连接复用
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { AsyncLocalStorage } from 'node:async_hooks';

// 类型导出
export * from './schema';
export type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

// Hyperdrive 类型定义
interface HyperdriveBinding {
  connectionString: string;
}

interface CloudflareEnv {
  HYPERDRIVE?: HyperdriveBinding;
}

// 请求级别的数据库连接存储
const requestDbStorage = new AsyncLocalStorage<ReturnType<typeof createDb>>();

// 本地开发环境的单例连接（避免热重载时连接泄漏）。
//
// ★必须挂在 globalThis 上，不能用模块级 `let`：Next.js 的 HMR 会**丢弃并重新求值
// 整个模块**，模块级变量随之复位成 null，于是每次热重载都新建一个 pool，而旧 pool
// 没有任何人调用 .end() —— 连接只增不减，直到打满 max_connections。
// 实测：12 次热重载 = +12 条常驻连接，线性且无上限。
// globalThis 跨模块重新求值存活，才真的是单例。
const globalForDb = globalThis as unknown as {
  __asterLocalDevDb?: ReturnType<typeof createDb> | null;
};

/**
 * 尝试从 OpenNext 获取 Cloudflare 上下文（同步版本）
 * 注意：只能在请求处理期间调用，不能在模块初始化时调用
 */
function getCloudflareEnvSync(): CloudflareEnv | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCloudflareContext } = require('@opennextjs/cloudflare');
    const context = getCloudflareContext({ async: false });
    return context.env as CloudflareEnv;
  } catch {
    // 非 Cloudflare 环境或不在请求上下文中
    return null;
  }
}

/**
 * 尝试从 OpenNext 获取 Cloudflare 上下文（异步版本）
 */
async function getCloudflareEnv(): Promise<CloudflareEnv | null> {
  try {
    // 动态导入以避免在非 Cloudflare 环境中报错
    const { getCloudflareContext } = await import('@opennextjs/cloudflare');
    const context = await getCloudflareContext({ async: true });
    return context.env as CloudflareEnv;
  } catch {
    // 非 Cloudflare 环境或导入失败
    return null;
  }
}

/**
 * 获取数据库连接字符串
 * 优先级：HYPERDRIVE > DATABASE_URL
 */
function getConnectionString(env?: CloudflareEnv): string {
  // Cloudflare Workers/Pages 环境：使用 Hyperdrive binding
  if (env?.HYPERDRIVE?.connectionString) {
    return env.HYPERDRIVE.connectionString;
  }

  // 本地开发环境：使用环境变量
  const url = process.env.HYPERDRIVE_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'Database connection string not found. ' +
        'Set DATABASE_URL environment variable or provide HYPERDRIVE binding.'
    );
  }
  return url;
}

/**
 * 是否存在可用的数据库连接来源（Hyperdrive binding 或 DATABASE_URL）。
 *
 * 用于 build 期短路：`next build` / opennext 预渲染阶段既无 Hyperdrive binding、
 * 也无 DATABASE_URL，此时任何 getDb() 都会抛 "connection string not found"。
 * 冷启动自愈（db-bootstrap）在预渲染时被 layout 顺带触发，本判定让它安静跳过，
 * 而不是逐条 DDL 抛错刷屏。不抛错、纯布尔，安全用于任何环境。
 */
export function hasDbBinding(): boolean {
  const env = getCloudflareEnvSync();
  if (env?.HYPERDRIVE?.connectionString) {
    return true;
  }
  return Boolean(process.env.HYPERDRIVE_DATABASE_URL || process.env.DATABASE_URL);
}

/**
 * 创建数据库客户端
 * Hyperdrive 负责连接池，这里只是创建客户端包装器
 */
export function createDb(env?: CloudflareEnv) {
  const connectionString = getConnectionString(env);

  // 集成测试用更大 pool 才能验证 advisory lock 的并发竞争；
  // Workers / Hyperdrive 生产路径不会读这个 env，保持 max=1 行为不变。
  const isIntegrationTest =
    process.env.LICENSE_E2E === '1' && process.env.VITEST === 'true';
  const max = isIntegrationTest ? 8 : 1;

  const client = postgres(connectionString, {
    // Hyperdrive 处理连接池，Workers 限制并发连接数
    max,
    // 禁用 prepared statements（Hyperdrive 不支持）
    prepare: false,
    // ★空闲连接自动归还：这是**兜底**，不是主修法。
    // 主修法是 getDb() 的 globalThis 单例（见上方注释）。但单例只覆盖本地 dev 路径，
    // Workers 路径每次调用都新建 client，且 runWithDb/getDbAsync 也各自建。
    // 任何一条路径漏掉 .end()，没有 idle_timeout 就是永久占用。
    // 20s 后归还空闲连接，让「漏掉 end()」从**永久泄漏**降级为**短暂占用**。
    idle_timeout: 20,
  });

  return drizzle(client, { schema });
}

/**
 * 获取数据库实例（自动检测 Cloudflare 环境）
 * 在 Cloudflare Workers 中会自动使用 Hyperdrive
 */
export async function getDbAsync(): Promise<ReturnType<typeof createDb>> {
  const env = await getCloudflareEnv();
  return createDb(env ?? undefined);
}

/**
 * 获取数据库实例
 * - 在 Cloudflare Workers 中：每次调用创建新实例（Hyperdrive 管理实际连接池）
 * - 在本地开发中：使用单例避免连接泄漏
 *
 * 性能说明：
 * - Hyperdrive 在边缘维护连接池，"创建连接"实际上是获取预热连接
 * - createDb() 的开销主要是 JavaScript 对象创建，非常轻量
 * - 如果需要在单个请求中复用，可以在请求入口处获取一次并传递
 */
export function getDb() {
  // 检查是否在请求上下文中已有缓存的连接
  const cachedDb = requestDbStorage.getStore();
  if (cachedDb) {
    return cachedDb;
  }

  // 尝试获取 Cloudflare 上下文
  const env = getCloudflareEnvSync();

  // Cloudflare Workers 环境：每次创建新实例（Hyperdrive 管理连接池）
  if (env?.HYPERDRIVE) {
    return createDb(env);
  }

  // 本地开发环境：使用单例避免连接泄漏（挂 globalThis 才能跨 HMR 存活）
  if (!globalForDb.__asterLocalDevDb) {
    globalForDb.__asterLocalDevDb = createDb();
  }
  return globalForDb.__asterLocalDevDb;
}

/**
 * 在请求上下文中运行函数，复用同一数据库连接
 * 用于需要在单个请求中多次访问数据库的场景
 *
 * @example
 * await withRequestDb(async (db) => {
 *   const user = await db.query.users.findFirst(...);
 *   const posts = await db.query.posts.findMany(...);
 *   return { user, posts };
 * });
 */
export async function withRequestDb<T>(
  fn: (db: ReturnType<typeof createDb>) => Promise<T>
): Promise<T> {
  const env = getCloudflareEnvSync();
  const db = createDb(env ?? undefined);
  return requestDbStorage.run(db, () => fn(db));
}

/**
 * 数据库类型
 */
export type Database = ReturnType<typeof createDb>;
