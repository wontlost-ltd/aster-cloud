// 建策略 / 改策略事务与连接池（真实 Postgres，外部 DATABASE_URL）。
//
// Node 运行时单例是全进程唯一的连接池。POST/PUT /api/policies 在 db.transaction 内建版本：
// 事务占住一条连接，若回调里再经全局 db 写安全事件或读别名授权，就要第二条连接；
// 并发事务数达到池大小时全部互等而挂死。此处把池固定为 1，任何「事务内用全局 db」都会立刻超时。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts policy-version-tx-pool

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(async () => ({ user: { id: 'user-tx-pool-1' } })),
}));
// 编译门禁走网络，与本用例无关：恒判可编译，并带回档案 id 以验证落库。
vi.mock('@/lib/policy-compile-validator', () => ({
  makeCompileValidator: () => async () => ({ diagnostics: [], profile: 'governed' }),
}));

import { createDb } from '@/db';
import { policies, policyVersions, securityEvents } from '@/lib/prisma';
import { POST } from '@/app/api/policies/route';
import { PUT } from '@/app/api/policies/[id]/route';

const USER = 'user-tx-pool-1';
const SOURCE = 'Module tx.pool.\n\nRule r given x as Int, produce Bool:\n  Return x at least 1.\n';
const DEADLINE_MS = 5000;

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

// 超时即判失败：池为 1 时事务内第二次取连接会永久排队。
async function withDeadline<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} 在 ${DEADLINE_MS}ms 内未完成：事务内向连接池要了第二条连接`)),
      DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function cleanup(db: Db): Promise<void> {
  const owned = await db.select({ id: policies.id }).from(policies).where(eq(policies.userId, USER));
  const ids = owned.map((p) => p.id);
  await db.delete(securityEvents).where(eq(securityEvents.userId, USER));
  if (ids.length > 0) {
    await db.delete(policyVersions).where(inArray(policyVersions.policyId, ids));
  }
  await db.delete(policies).where(eq(policies.userId, USER));
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('策略保存事务（连接池 = 1）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const pool = createDb(undefined, { max: 1 });
  const seededId = 'pol-tx-pool-put';

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = pool;
    await cleanup(pool);
    // PUT 用例自带的策略与 v1，与 POST 用例互不依赖。
    await pool.insert(policies).values({
      id: seededId,
      userId: USER,
      name: 'tx-pool-put',
      content: SOURCE,
      updatedAt: new Date(),
    } as typeof policies.$inferInsert);
    await pool.insert(policyVersions).values({
      id: `${seededId}-v1`,
      policyId: seededId,
      version: 1,
      content: SOURCE,
      source: SOURCE,
    });
  });

  afterAll(async () => {
    // 挂死时池内连接仍被占用，先强制关闭再用独立连接清理。
    await pool.$client.end({ timeout: 1 });
    globalForDb.__asterLocalDevDb = previous;
    const janitor = createDb(undefined, { max: 1 });
    await cleanup(janitor);
    await janitor.$client.end({ timeout: 1 });
  });

  it('POST 建策略：事务内建版本与安全事件只用事务连接', async () => {
    const res = await withDeadline(
      POST(jsonRequest('http://localhost/api/policies', 'POST', { name: 'tx-pool', content: SOURCE, locale: 'en-US' })),
      'POST /api/policies',
    );
    expect(res.status).toBe(201);
    const policyId = ((await res.json()) as { id: string }).id;

    const events = await pool.select().from(securityEvents).where(eq(securityEvents.policyId, policyId));
    expect(events.map((e) => e.eventType)).toEqual(['VERSION_CREATED']);
    const [version] = await pool
      .select({ profile: policyVersions.profile })
      .from(policyVersions)
      .where(eq(policyVersions.policyId, policyId));
    expect(version.profile).toBe('governed');
  });

  it('PUT 改源码与别名：别名授权读取与安全事件不占第二条连接', async () => {
    const res = await withDeadline(
      PUT(
        jsonRequest(`http://localhost/api/policies/${seededId}`, 'PUT', {
          content: `${SOURCE}\n`,
          aliasSet: { TIMES: ['multiplied by'] },
          locale: 'en-US',
        }),
        { params: Promise.resolve({ id: seededId }) },
      ),
      'PUT /api/policies/[id]',
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { version: number }).version).toBe(2);

    const versions = await pool
      .select({ version: policyVersions.version })
      .from(policyVersions)
      .where(eq(policyVersions.policyId, seededId));
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
    const events = await pool.select().from(securityEvents).where(eq(securityEvents.policyId, seededId));
    expect(events.map((e) => e.eventType)).toEqual(['VERSION_CREATED']);
  });
});
