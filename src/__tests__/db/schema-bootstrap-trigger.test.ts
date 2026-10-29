// #650：冷启动自愈（db-bootstrap）此前只由登录、dashboard 布局等页面入口触发，
// 只走 API 的流量（API key、/api/policies/**）在迁移未跑时会一直 500，直到有人打开 dashboard。
// getDb() 在 Next 服务端首次取连接时后台触发一次 ensureSchemaApplied；脚本 / 测试（无 NEXT_RUNTIME）不触发。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { ensureSchemaApplied } = vi.hoisted(() => ({ ensureSchemaApplied: vi.fn(async () => undefined) }));
vi.mock('@/lib/db-bootstrap', () => ({ ensureSchemaApplied }));

const globalForDb = globalThis as unknown as { __asterLocalDevDb?: unknown };

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('getDb 触发冷启动 schema 自愈', () => {
  beforeEach(() => {
    vi.resetModules();
    ensureSchemaApplied.mockClear();
    globalForDb.__asterLocalDevDb = { fake: true };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    globalForDb.__asterLocalDevDb = null;
  });

  it('Next 服务端 + 有连接来源：首次取连接后台触发一次，之后不再触发', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@127.0.0.1:1/x');
    const { getDb } = await import('@/db');
    getDb();
    getDb();
    await flush();
    getDb();
    await flush();
    expect(ensureSchemaApplied).toHaveBeenCalledTimes(1);
  });

  it('脚本 / 测试进程（无 NEXT_RUNTIME）不触发', async () => {
    vi.stubEnv('NEXT_RUNTIME', '');
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@127.0.0.1:1/x');
    const { getDb } = await import('@/db');
    getDb();
    await flush();
    expect(ensureSchemaApplied).not.toHaveBeenCalled();
  });

  it('无连接来源（build / 预渲染）时不触发也不占用这一次，有连接来源后再触发', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('HYPERDRIVE_DATABASE_URL', '');
    const { getDb } = await import('@/db');
    getDb();
    await flush();
    expect(ensureSchemaApplied).not.toHaveBeenCalled();

    vi.stubEnv('DATABASE_URL', 'postgres://u:p@127.0.0.1:1/x');
    getDb();
    await flush();
    expect(ensureSchemaApplied).toHaveBeenCalledTimes(1);
  });

  it('自愈启动失败只记日志，不影响取连接', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@127.0.0.1:1/x');
    ensureSchemaApplied.mockRejectedValueOnce(new Error('boom'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getDb } = await import('@/db');
    expect(getDb()).toEqual({ fake: true });
    await flush();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
