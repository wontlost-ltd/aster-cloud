// src/__tests__/db/fresh-db-binding.test.ts
// #624：一致性敏感的读走关闭查询缓存的第二个 Hyperdrive 绑定 HYPERDRIVE_FRESH；
// 没有该绑定（本地、on-prem、绑定尚未配置）时回落到 getDb()。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

type Env = Record<string, { connectionString: string }>;
let currentEnv: Env = {};

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({ env: currentEnv }),
}));

const req = createRequire(import.meta.url);
const opennextPath = req.resolve('@opennextjs/cloudflare');
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: unknown };
const originalRelease = process.release;

function setRelease(value: unknown) {
  Object.defineProperty(process, 'release', { value, configurable: true, writable: true });
}

function databaseOf(db: unknown): string {
  return (db as { $client: { options: { database: string } } }).$client.options.database;
}

const CACHED = { connectionString: 'postgres://u:p@127.0.0.1:5432/cached_db' };
const FRESH = { connectionString: 'postgres://u:p@127.0.0.1:5432/fresh_db' };

describe('getFreshDb 选择关闭缓存的 Hyperdrive 绑定', () => {
  beforeEach(() => {
    vi.resetModules();
    globalForDb.__asterLocalDevDb = null;
    req.cache[opennextPath] = {
      id: opennextPath,
      filename: opennextPath,
      loaded: true,
      exports: { getCloudflareContext: () => ({ env: currentEnv }) },
    } as unknown as NodeJS.Module;
  });

  afterEach(() => {
    setRelease(originalRelease);
    vi.unstubAllEnvs();
    delete req.cache[opennextPath];
    globalForDb.__asterLocalDevDb = null;
    currentEnv = {};
  });

  it('Workers + 有 HYPERDRIVE_FRESH：用 fresh 绑定的连接串新建 client', async () => {
    setRelease(undefined);
    currentEnv = { HYPERDRIVE: CACHED, HYPERDRIVE_FRESH: FRESH };
    const { getFreshDb, getDb } = await import('@/db');
    expect(databaseOf(getFreshDb())).toBe('fresh_db');
    expect(databaseOf(getDb())).toBe('cached_db');
  });

  it('Workers + 无 HYPERDRIVE_FRESH：回落到默认 HYPERDRIVE', async () => {
    setRelease(undefined);
    currentEnv = { HYPERDRIVE: CACHED };
    const { getFreshDb } = await import('@/db');
    expect(databaseOf(getFreshDb())).toBe('cached_db');
  });

  it('Node 运行时（本地 dev 代理）：即使有 HYPERDRIVE_FRESH 也复用 getDb() 单例', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    currentEnv = { HYPERDRIVE: CACHED, HYPERDRIVE_FRESH: FRESH };
    const { getFreshDb, getDb } = await import('@/db');
    expect(getFreshDb()).toBe(getDb());
  });

  it('Workers + 请求级复用的 db（withRequestDb）：fresh 读不复用缓存连接', async () => {
    setRelease(undefined);
    currentEnv = { HYPERDRIVE: CACHED, HYPERDRIVE_FRESH: FRESH };
    const { getFreshDb, withRequestDb } = await import('@/db');
    const name = await withRequestDb(async () => databaseOf(getFreshDb()));
    expect(name).toBe('fresh_db');
  });

  it('@/db/fresh-read 的 freshDb：有绑定走 fresh 配置', async () => {
    setRelease(undefined);
    currentEnv = { HYPERDRIVE: CACHED, HYPERDRIVE_FRESH: FRESH };
    const { freshDb } = await import('@/db/fresh-read');
    expect(databaseOf(freshDb)).toBe('fresh_db');
  });

  it('@/db/fresh-read 的 freshDb：无绑定时等同全局 db', async () => {
    setRelease(undefined);
    currentEnv = { HYPERDRIVE: CACHED };
    const { freshDb } = await import('@/db/fresh-read');
    expect(databaseOf(freshDb)).toBe('cached_db');
  });
});
