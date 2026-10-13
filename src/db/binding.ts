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
