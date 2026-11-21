/**
 * 数据库连接配置
 * 支持 Cloudflare Workers/Pages 环境（通过 Hyperdrive）和本地开发环境
 *
 * 性能说明：
 * - Cloudflare Workers: Hyperdrive 负责连接池，每次 getDb() 获取预热连接
 * - 本地开发：使用模块级单例避免连接泄漏
 * - 使用 AsyncLocalStorage 实现请求级别的连接复用
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import * as schema from './schema';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getCloudflareEnvSync, isNodeRuntime, warnFreshBindingMissing, type CloudflareEnv } from './binding';

// 类型导出
export * from './schema';
export type { NodePgDatabase } from 'drizzle-orm/node-postgres';

// 连接来源判定独立在 ./binding（无 pg 驱动依赖），供 instrumentation 等 edge 可达代码复用
export { hasDbBinding } from './binding';

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
 * Node 运行时单例的连接池大小。
 *
 * 单例是整个 Node 进程共用的唯一 client，没有 Hyperdrive 在前面池化，必须是真正的池：
 * 池大小为 1 时，db.transaction 占住唯一连接，事务回调里经全局 db 发出的查询
 * （如 createVersion 内的 logSecurityEvent / 缓存失效）会永远排队，请求挂死。
 */
const NODE_RUNTIME_POOL_MAX = 10;

/**
 * Node 运行时单例：仍尊重 Hyperdrive 本地代理给出的连接串，但全进程只建一个 client。
 */
function getLocalDevDb(env?: CloudflareEnv): ReturnType<typeof createDb> {
  if (!globalForDb.__asterLocalDevDb) {
    globalForDb.__asterLocalDevDb = createDb(env, { max: NODE_RUNTIME_POOL_MAX });
  }
  return globalForDb.__asterLocalDevDb;
}

/**
 * 卡死兜底超时（#842）。
 *
 * 经 Hyperdrive 的连接曾出现「查询发出后永远等不到回包」：请求挂到 Worker 被平台掐断，
 * 日志里没有任何数据库错误。两个超时把这种卡死变成可见、可重试的报错：
 * - 连接超时：建连（含在池里排队等连接）超过此值即失败，报错 "timeout exceeded when trying to connect"
 *   或 "Connection terminated due to connection timeout"。
 * - 查询读超时：pg 客户端侧计时，发出查询后超过此值仍无结果即失败，报错 "Query read timeout"
 *   （drizzle 包成 "Failed query: …"，原始错误在 cause 上）。它不依赖数据库端的 statement_timeout，
 *   网络或 Hyperdrive 侧卡住时同样生效。
 * 取值依据：业务查询与 cron 的单批语句都在秒级，30 秒已远超正常耗时；再长就该拆批，而不是等。
 */
export const DB_CONNECT_TIMEOUT_MS = 10_000;
export const DB_QUERY_TIMEOUT_MS = 30_000;

/** 空闲连接归还时间（毫秒），语义同旧 postgres-js 的 idle_timeout: 20，见 createDb 注释。 */
const DB_IDLE_TIMEOUT_MS = 20_000;

/** pg 客户端侧查询读超时的错误信息（pg/lib/client.js）。 */
const QUERY_READ_TIMEOUT_MESSAGE = 'Query read timeout';

function isQueryReadTimeout(err: unknown): boolean {
  return err instanceof Error && err.message === QUERY_READ_TIMEOUT_MESSAGE;
}

/**
 * 查询读超时后立即作废整条连接的 pg 客户端（#842）。
 *
 * pg 的 query_timeout 只让调用方的 promise 失败：非 pipeline 模式下超时的查询仍占着连接，
 * 后面的查询（包括 drizzle 事务失败后发的 rollback）会排在它后面继续卡住；drizzle 事务结束时
 * 又以「无错误」把这条连接还给池，下一位使用者拿到的是一条卡死的连接。
 * 这里在超时发生时调用 end()：有活动查询时 pg 会直接销毁 socket，客户端标记为不可查询，
 * 超时前已在 pg 内部排队的查询以连接终止错误失败；作废之后新提交的语句（如 rollback）
 * 不再发出，直接以带原始超时为 cause 的 "Query read timeout" 失败。池会移除这条连接而不是复用。
 * 用 end() 而不是直接销毁 socket：_ending 置位后连接断开不会再作为未捕获的 'error' 事件抛出。
 */
class StallGuardClient extends Client {
  /** 作废本连接的那次超时；之后的语句不再发出，直接以带超时信息的错误失败。 */
  private abandonedBy: Error | null = null;

  // pg 的 query 有回调 / promise 多种重载，这里只做透传，不改变参数与返回值。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(...args: any[]): any {
    const callbackIndex = args.findIndex((arg) => typeof arg === 'function');
    // drizzle 事务在回调失败后会先发 rollback，rollback 的错误会盖掉原始错误。连接已作废时让后续语句
    // 以「查询读超时」失败，调用方看到的仍是超时，而不是 "Client was closed"。
    if (this.abandonedBy) {
      const error = new Error(
        `${QUERY_READ_TIMEOUT_MESSAGE}：连接已在先前的查询超时后作废，本语句未发送`,
        { cause: this.abandonedBy },
      );
      if (callbackIndex >= 0) {
        process.nextTick(() => (args[callbackIndex] as (err: unknown) => void)(error));
        return undefined;
      }
      return Promise.reject(error);
    }
    if (callbackIndex >= 0) {
      const callback = args[callbackIndex] as (err: unknown, res: unknown) => void;
      args[callbackIndex] = (err: unknown, res: unknown) => {
        this.abandonOnTimeout(err);
        callback(err, res);
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (super.query as any)(...args);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (super.query as any)(...args);
    if (result && typeof result.then === 'function') {
      return result.catch((err: unknown) => {
        this.abandonOnTimeout(err);
        throw err;
      });
    }
    return result;
  }

  private abandonOnTimeout(err: unknown): void {
    if (!isQueryReadTimeout(err) || this.abandonedBy) return;
    this.abandonedBy = err as Error;
    this.end().catch(() => {
      // 连接本来就坏了，关闭失败无需处理
    });
    // 被借出的连接立刻带错归还，让池移除它、空出名额：drizzle 的事务在 BEGIN 就失败时不会调用
    // release()，不在这里归还就会永久占住一个池位。之后调用方再 release() 是空操作（否则 pg-pool
    // 会抛「重复归还」，盖掉真正的超时错误）。
    const checkedOut = this as unknown as { release?: (err?: Error) => void };
    const release = checkedOut.release;
    if (typeof release === 'function') {
      checkedOut.release = () => {};
      release(err as Error);
    }
  }
}

/**
 * 创建数据库客户端（drizzle + node-postgres 连接池）。
 *
 * 为什么是 node-postgres 而不是 postgres-js（#842）：
 * - Cloudflare 文档明确「Drizzle ORM 搭配 Postgres.js 经 Hyperdrive 目前不受支持」，推荐 node-postgres。
 * - drizzle 的 postgres-js 适配器把每条查询都经 client.unsafe() 发出，强制 prepare: false
 *   （drizzle-team/drizzle-orm#6096），客户端上的 prepare 选项不起作用；Cloudflare 确认这条路径会
 *   稳定触发 Hyperdrive 报文处理的竞态，连接卡死（cloudflare-docs#35121）。
 * node-postgres 把 Parse/Bind/Describe/Execute/Sync 一次发出，不走那条两段式路径。
 *
 * Workers 路径不传 options：max=1，与此前的 postgres-js 行为一致（Hyperdrive 负责真正的池化）。
 */
export function createDb(
  env?: CloudflareEnv,
  options?: {
    max?: number;
    /** 仅供测试缩短等待；生产路径一律用 DB_CONNECT_TIMEOUT_MS / DB_QUERY_TIMEOUT_MS。 */
    connectTimeoutMs?: number;
    queryTimeoutMs?: number;
  },
) {
  const connectionString = getConnectionString(env);

  // 集成测试用更大 pool 才能验证 advisory lock 的并发竞争；
  // Workers / Hyperdrive 生产路径不传 options，保持 max=1 行为不变。
  const isIntegrationTest =
    process.env.LICENSE_E2E === '1' && process.env.VITEST === 'true';
  const max = options?.max ?? (isIntegrationTest ? 8 : 1);

  const pool = new Pool({
    Client: StallGuardClient,
    connectionString,
    max,
    connectionTimeoutMillis: options?.connectTimeoutMs ?? DB_CONNECT_TIMEOUT_MS,
    query_timeout: options?.queryTimeoutMs ?? DB_QUERY_TIMEOUT_MS,
    // ★空闲连接自动归还：这是**兜底**，不是主修法。
    // 主修法是 getDb() 的 globalThis 单例（见上方注释）。但单例只覆盖本地 dev 路径，
    // Workers 路径每次调用都新建 pool，且 runWithDb/getDbAsync 也各自建。
    // 任何一条路径漏掉 .end()，没有空闲超时就是永久占用。
    // 20s 后归还空闲连接，让「漏掉 end()」从**永久泄漏**降级为**短暂占用**。
    idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
  });
  // pg 的 Pool 在空闲连接出错（服务端断开、网络中断）时发 'error' 事件；
  // 没有监听者时 EventEmitter 会把它当未捕获异常抛出。这里只记日志：出错的连接已被池移除，
  // 下一次查询会新建连接。
  pool.on('error', (err) => {
    console.warn('[db] 空闲连接出错，已从连接池移除：', err.message);
  });

  return drizzle(pool, { schema });
}

/**
 * Workers 上全局 db 实际使用的 Hyperdrive 配置（#842）：有 HYPERDRIVE_FRESH 就用它。
 *
 * 换成 node-postgres 之后，参数化查询在默认 HYPERDRIVE 配置上会**开始**被缓存
 * （max_age 60s + stale_while_revalidate 15s，写入不让缓存失效）；此前 postgres-js 被 drizzle 强制
 * prepare: false，这类查询实际上不进缓存（#744 的测量）。全局 db 被一百多个模块引用，没有逐条做过
 * 「写后读是否容忍 75 秒旧数据」的审计，悄悄打开缓存就是一次行为变更。所以这里保持现状：
 * 全局 db 也走关闭缓存的配置；要启用缓存，应针对具体的读显式选择，并先做陈旧性审计。
 * 缺 HYPERDRIVE_FRESH 时回落到 HYPERDRIVE 并告警（#743）。
 */
function uncachedWorkerEnv(env: CloudflareEnv): CloudflareEnv {
  if (env.HYPERDRIVE_FRESH?.connectionString) {
    return { HYPERDRIVE: env.HYPERDRIVE_FRESH };
  }
  warnFreshBindingMissing(env);
  return env;
}

/**
 * 获取数据库实例（自动检测 Cloudflare 环境）
 * 在 Cloudflare Workers 中会自动使用 Hyperdrive
 */
export async function getDbAsync(): Promise<ReturnType<typeof createDb>> {
  const env = await getCloudflareEnv();
  if (isNodeRuntime()) {
    return getLocalDevDb(env ?? undefined);
  }
  return createDb(env ? uncachedWorkerEnv(env) : undefined);
}

/**
 * 获取数据库实例
 * - 在 Cloudflare Workers（workerd）中：每次调用创建新实例（Hyperdrive 管理实际连接池）
 * - 在 Node 运行时（next dev / next start / CI / docker）中：使用单例避免连接泄漏
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

  // 真实 Cloudflare Workers：每次创建新实例（Hyperdrive 管理连接池）。
  // Node 运行时（含本地 next dev 的无池化 HYPERDRIVE 代理）必须走单例（见 isNodeRuntime）。
  if (env?.HYPERDRIVE && !isNodeRuntime()) {
    return createDb(uncachedWorkerEnv(env));
  }

  // 本地开发环境：使用单例避免连接泄漏（挂 globalThis 才能跨 HMR 存活）
  return getLocalDevDb(env ?? undefined);
}

/**
 * 获取一致性敏感读用的数据库实例（#624）。
 *
 * Hyperdrive 默认缓存只读查询（60s + 15s stale），写入不会让缓存失效。权限、成员关系、
 * 写后即读等场景必须读到最新数据，因此走第二个关闭缓存的绑定 HYPERDRIVE_FRESH：
 * - 真实 Workers 且有 HYPERDRIVE_FRESH：用它的连接串新建 client。不复用 withRequestDb
 *   的请求级连接（那条走的是带缓存的配置）。
 * - 其余情况（Node 运行时、本地 dev 代理、on-prem、绑定尚未配置）：等同 getDb()。
 *   这些环境没有 Hyperdrive 查询缓存（本地代理直连 PG），或绑定缺失时属于部署配置错误。
 *
 * 自 #842 起 Workers 上的全局 db 也走 HYPERDRIVE_FRESH（见 uncachedWorkerEnv），两者效果相同；
 * 仍保留本函数，作为「这条读必须新鲜」的显式标记——以后给全局 db 打开缓存时它不受影响。
 *
 * 只能用于事务之外的读：它是另一条连接，看不到当前事务里未提交的写入。
 */
export function getFreshDb() {
  const env = getCloudflareEnvSync();
  if (env?.HYPERDRIVE_FRESH?.connectionString && !isNodeRuntime()) {
    return createDb({ HYPERDRIVE: env.HYPERDRIVE_FRESH });
  }
  warnFreshBindingMissing(env);
  return getDb();
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
  const db = isNodeRuntime()
    ? getLocalDevDb(env ?? undefined)
    : createDb(env ? uncachedWorkerEnv(env) : undefined);
  return requestDbStorage.run(db, () => fn(db));
}

/**
 * 数据库类型
 */
export type Database = ReturnType<typeof createDb>;
