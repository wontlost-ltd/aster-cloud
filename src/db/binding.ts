/**
 * 数据库连接来源判定（不依赖 postgres 驱动）。
 *
 * 独立成模块的原因：instrumentation.ts 在 edge 运行时也会被 webpack 打包，
 * 而 ./index.ts 静态引入 `postgres`（依赖 node:net / node:tls），edge 包解析
 * 即失败；这里只触碰 process.env 与 OpenNext 上下文，两端都可安全打包。
 */

// Hyperdrive 类型定义
export interface HyperdriveBinding {
  connectionString: string;
}

export interface CloudflareEnv {
  HYPERDRIVE?: HyperdriveBinding;
  /**
   * 关闭查询缓存（--caching-disabled）的第二个 Hyperdrive 配置（#624）。
   * 只给一致性敏感的读用（见 getFreshDb）；未配置时回落到 HYPERDRIVE。
   */
  HYPERDRIVE_FRESH?: HyperdriveBinding;
}

/**
 * 尝试从 OpenNext 获取 Cloudflare 上下文（同步版本）
 * 注意：只能在请求处理期间调用，不能在模块初始化时调用
 */
export function getCloudflareEnvSync(): CloudflareEnv | null {
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
 * 是否存在可用的数据库连接来源（Hyperdrive binding 或 DATABASE_URL）。
 *
 * 用于 build 期短路：`next build` / opennext 预渲染阶段既无 Hyperdrive binding、
 * 也无 DATABASE_URL，此时任何 getDb() 都会抛 "connection string not found"。
 * 冷启动自愈（db-bootstrap）在预渲染时被 layout 顺带触发，本判定让它安静跳过，
 * 而不是逐条 DDL 抛错刷屏。不抛错、纯布尔，安全用于任何环境。
 *
 * 口径必须与 index.ts 的 getConnectionString 保持一致。
 */
export function hasDbBinding(): boolean {
  const env = getCloudflareEnvSync();
  if (env?.HYPERDRIVE?.connectionString) {
    return true;
  }
  return Boolean(process.env.HYPERDRIVE_DATABASE_URL || process.env.DATABASE_URL);
}

/**
 * 是否运行在真实 Node 运行时（而非 workerd）中。
 *
 * 背景：本地 dev 下 @opennextjs/cloudflare 会经 getPlatformProxy 懒启动 workerd，
 * getCloudflareContext() 返回的 env **也带 HYPERDRIVE binding**（connectionString
 * 由 WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE 覆盖为直连 PG；HYPERDRIVE_FRESH 同理，
 * 变量名后缀为 _HYPERDRIVE_FRESH）。
 * 这个本地代理不做连接池，若按 Workers 路径每次调用新建 client，连接会打满
 * max_connections（实测 202/200 → too many clients）。`next start`、CI e2e、docker
 * 等任何真实 Node 进程同理，都必须复用单例；只有 workerd 内才有 Hyperdrive 池化。
 *
 * 判定：process.release.name === 'node' 且**不在 workerd 内**。
 * 不能只看 process.release：较新兼容日期下 workerd 的原生 process v2 也可能报告
 * release.name === 'node'。workerd 以 navigator.userAgent === 'Cloudflare-Workers'
 * 或存在全局 WebSocketPair 识别。
 */
export function isNodeRuntime(): boolean {
  const isNode = typeof process !== 'undefined' && process.release?.name === 'node';
  return isNode && !isWorkerd();
}

export function isWorkerd(): boolean {
  const g = globalThis as { navigator?: { userAgent?: string }; WebSocketPair?: unknown };
  return g.navigator?.userAgent === 'Cloudflare-Workers' || g.WebSocketPair !== undefined;
}

const FRESH_BINDING_NAME = 'HYPERDRIVE_FRESH';

/** 每个 isolate（模块实例）只告警一次。 */
let freshBindingWarned = false;

/**
 * 真实 workerd 里有 HYPERDRIVE 却缺 HYPERDRIVE_FRESH（绑定被删、改名或 env 取不到）时告警一次（#743）。
 *
 * 此时一致性敏感读会静默回落到带缓存的 HYPERDRIVE，可能读到约 75 秒旧数据。只发信号，**不改回退行为**；
 * 只在识别为 workerd 时告警；Node 运行时（本地 dev / on-prem / 测试）本来就没有 Hyperdrive 缓存，不告警。
 */
export function warnFreshBindingMissing(env: CloudflareEnv | null | undefined): void {
  if (freshBindingWarned || !isWorkerd()) return;
  if (!env?.HYPERDRIVE || env.HYPERDRIVE_FRESH?.connectionString) return;
  freshBindingWarned = true;
  console.warn(
    `[db] ${FRESH_BINDING_NAME} 绑定缺失，一致性敏感读回落到带查询缓存的 HYPERDRIVE，可能读到约 75 秒旧数据；` +
      `请检查 wrangler 配置中的 ${FRESH_BINDING_NAME} 绑定。`,
  );
}
