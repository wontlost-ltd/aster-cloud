// src/__tests__/db/local-dev-db-singleton.test.ts
// 本地 next dev 下 HYPERDRIVE 是无池化的本地代理：getDb() 必须复用单例；
// 真实 Workers（无 Node process.release）仍按调用新建 client。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const hyperdriveEnv = {
  HYPERDRIVE: { connectionString: 'postgres://u:p@127.0.0.1:5432/aster_cloud' },
};

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({ env: hyperdriveEnv }),
}));

// getCloudflareEnvSync 用 CJS require 加载 @opennextjs/cloudflare，vi.mock 拦不到，
// 因此直接在 Node 的 require 缓存里放入同样的桩。
const req = createRequire(import.meta.url);
const opennextPath = req.resolve('@opennextjs/cloudflare');

const globalForDb = globalThis as unknown as { __asterLocalDevDb?: unknown };
const originalRelease = process.release;

function setRelease(value: unknown) {
  Object.defineProperty(process, 'release', { value, configurable: true, writable: true });
}

describe('getDb 本地 dev 代理检测', () => {
  beforeEach(() => {
    vi.resetModules();
    globalForDb.__asterLocalDevDb = null;
    req.cache[opennextPath] = {
      id: opennextPath,
      filename: opennextPath,
      loaded: true,
      exports: { getCloudflareContext: () => ({ env: hyperdriveEnv }) },
    } as unknown as NodeJS.Module;
  });

  afterEach(() => {
    setRelease(originalRelease);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    delete req.cache[opennextPath];
    globalForDb.__asterLocalDevDb = null;
  });

  it('Node + 非 production + HYPERDRIVE：两次 getDb() 返回同一实例', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { getDb } = await import('@/db');
    const a = getDb();
    const b = getDb();
    expect(a).toBe(b);
  });

  it('Node + 非 production：getDbAsync/withRequestDb 也复用单例', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { getDb, getDbAsync, withRequestDb } = await import('@/db');
    const a = getDb();
    expect(await getDbAsync()).toBe(a);
    expect(await withRequestDb(async (db) => db)).toBe(a);
  });

  it('无 Node process.release（模拟 Workers）：每次调用新建 client', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    setRelease(undefined);
    const { getDb } = await import('@/db');
    expect(getDb()).not.toBe(getDb());
  });

  it('NODE_ENV=production 的真实 Node 进程：仍复用单例', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { getDb, getDbAsync } = await import('@/db');
    const a = getDb();
    expect(getDb()).toBe(a);
    expect(await getDbAsync()).toBe(a);
  });

  it('workerd 原生 process v2（release.name=node 但 UA=Cloudflare-Workers）：每次调用新建 client', async () => {
    setRelease({ name: 'node' });
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' });
    const { getDb } = await import('@/db');
    expect(getDb()).not.toBe(getDb());
  });

  // 单例是 Node 进程内唯一的 client：池大小若为 1，db.transaction 占住唯一连接后，
  // 事务回调里经全局 db 发出的查询（如 createVersion 内的 logSecurityEvent）会永远排队，
  // POST/PUT /api/policies 因而挂死。单例必须是真正的连接池。
  it('Node 运行时单例的连接池大于 1（事务内经全局 db 的查询不死锁）', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { getDb } = await import('@/db');
    const client = (getDb() as unknown as { $client: { options: { max: number } } }).$client;
    expect(client.options.max).toBeGreaterThan(1);
  });

  it('Workers 路径仍为每请求 max=1（Hyperdrive 负责池化）', async () => {
    setRelease(undefined);
    const { getDb } = await import('@/db');
    const client = (getDb() as unknown as { $client: { options: { max: number } } }).$client;
    expect(client.options.max).toBe(1);
  });
});
