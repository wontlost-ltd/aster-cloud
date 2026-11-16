// ADR 0058 capability.* 平台开关：设置写入与审计在同一事务，真实 Postgres 验证回滚。
// 以主键冲突强制审计插入失败（预置同 id 审计行 + 固定 randomUUID），断言设置未提交。
// 测试前快照目标键的原行，测试后原样恢复；审计行按固定前缀清理。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts platform-settings-audit-atomic

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/admin-auth', () => ({ requireAdmin: vi.fn(async () => ({ userId: 'it-psat-admin' })) }));
vi.mock('@/lib/license-write-gate', () => ({ requireLicenseWriteOk: vi.fn(async () => null) }));

import { createDb } from '@/db';
import { auditLogs, platformSettings } from '@/lib/prisma';
import { PLATFORM_SETTING_KEYS } from '@/lib/platform-settings';
import { POST } from '@/app/api/admin/platform-settings/route';

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

const KEY = PLATFORM_SETTING_KEYS.STRUCTURED_AUTHORING_ENABLED;
const AUDIT_PREFIX = 'it-psat-';
const FIXED_AUDIT_ID = `${AUDIT_PREFIX}fixed`;

const request = (value: boolean) =>
  new Request('http://localhost/api/admin/platform-settings', {
    method: 'POST',
    body: JSON.stringify({ key: KEY, value }),
  });

describe.skipIf(process.env.LICENSE_E2E !== '1')('platform-settings capability 写入事务（真实 Postgres）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db = createDb(undefined, { max: 4 });
  let original: typeof platformSettings.$inferSelect | undefined;

  const readRow = () => db.select().from(platformSettings).where(eq(platformSettings.key, KEY));
  const cleanAudits = () => db.delete(auditLogs).where(like(auditLogs.id, `${AUDIT_PREFIX}%`));

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
    original = (await readRow())[0];
    await cleanAudits();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await cleanAudits();
    if (original) {
      await db.insert(platformSettings).values(original).onConflictDoUpdate({
        target: platformSettings.key,
        set: { value: original.value, updatedAt: original.updatedAt, updatedBy: original.updatedBy },
      });
    } else {
      await db.delete(platformSettings).where(eq(platformSettings.key, KEY));
    }
    globalForDb.__asterLocalDevDb = previous;
  });

  it('审计插入失败 → 500 且设置值回滚为原值', async () => {
    const before = original ? original.value : null;
    const target = before !== true;
    // 预置同 id 审计行，使路由内的审计插入触发主键冲突
    await db.insert(auditLogs).values({ id: FIXED_AUDIT_ID, action: 'it.seed', resource: 'it' });
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(FIXED_AUDIT_ID as `${string}-${string}-${string}-${string}-${string}`);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(request(target));
    expect(res.status).toBe(500);

    const [row] = await readRow();
    expect(row?.value ?? null).toBe(before);
    expect(row?.updatedBy ?? null).toBe(original?.updatedBy ?? null);
    vi.restoreAllMocks();
  });

  it('审计成功 → 200，设置与审计一并提交', async () => {
    const before = original ? original.value : null;
    const target = before !== true;
    const res = await POST(request(target));
    expect(res.status).toBe(200);

    const [row] = await readRow();
    expect(row.value).toBe(target);
    expect(row.updatedBy).toBe('it-psat-admin');
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.userId, 'it-psat-admin'));
    expect(audits.some((a) => a.resourceId === KEY && a.action === 'platform_setting.update')).toBe(true);
    // userId 为 it-psat-admin 的审计 id 是随机 UUID，按 userId 清理
    await db.delete(auditLogs).where(eq(auditLogs.userId, 'it-psat-admin'));
  });
});
