// owner 池用量随配额快照下发（#694），真实 Postgres。
//
// 单测钉住了查询条件的形状；本文件验证单测证明不了的两件事：
// - 批量计数 countOwnerPoolUsageByOwner 的 GROUP BY COALESCE(quotaOwnerId, userId) 在真实 SQL 下
//   与逐 owner 的 countOwnerPoolUsage 结果一致（团队 key 行、旧 NULL 行、失败行、跨月行、他人团队行）；
// - 全量同步路由 /api/internal/snapshot/full 的 users[] 带上与 precheck 同口径的 monthlyUsed / usagePeriod。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts api-quota-pool-snapshot

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { inArray, like } from 'drizzle-orm';

vi.mock('server-only', () => ({}));

import { createDb } from '@/db';
import { apiCallRecords, users } from '@/lib/prisma';
import {
  countOwnerPoolUsage,
  countOwnerPoolUsageByOwner,
  currentPeriodMonth,
  recordApiCallRecord,
  type ApiCallRecordInput,
} from '@/lib/api-quota-pool';
import { GET } from '@/app/api/internal/snapshot/full/route';

const PREFIX = 'it-qpool-';
const OWNER = `${PREFIX}owner`;
const MEMBER = `${PREFIX}member`;
const IDLE = `${PREFIX}idle`;
const OTHER = `${PREFIX}other-owner`;
const USER_IDS = [OWNER, MEMBER, IDLE, OTHER];
const HMAC_KEY = 'it-qpool-hmac-key';
const PATH = '/api/internal/snapshot/full';

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

function call(userId: string, quotaOwnerId: string, status: 'success' | 'api_error' = 'success'): ApiCallRecordInput {
  return { userId, tenantId: null, apiKeyId: null, quotaOwnerId, endpointPath: '/api/v1/policies/{id}/execute', status, latencyMs: 1 };
}

function signedGet(query: string): Request {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const bodyHash = createHash('sha256').update('').digest('hex');
  const sig = createHmac('sha256', HMAC_KEY).update(`GET\n${PATH}\n${ts}\n${nonce}\n${bodyHash}`).digest('hex');
  return new Request(`http://cloud.test${PATH}${query}`, {
    headers: { 'X-Aster-Timestamp': ts, 'X-Aster-Nonce': nonce, 'X-Internal-Signature': sig },
  });
}

async function cleanup(db: Db): Promise<void> {
  await db.delete(apiCallRecords).where(like(apiCallRecords.userId, `${PREFIX}%`));
  await db.delete(users).where(inArray(users.id, USER_IDS));
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('owner 池用量随快照下发（#694，真实 Postgres）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const previousKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;
  const db = createDb(undefined, { max: 4 });
  const period = currentPeriodMonth();
  const lastMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 15));

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
    process.env.ASTER_PLAN_GATE_HMAC_KEY = HMAC_KEY;
    await cleanup(db);
    await db.insert(users).values(
      USER_IDS.map((id) => ({ id, email: `${id}@example.test`, plan: 'pro', updatedAt: new Date() })) as Array<
        typeof users.$inferInsert
      >,
    );
    // OWNER 池：个人调用 1 + 成员用 OWNER 团队 key 1 + 旧行（quotaOwnerId 为 NULL，持有者 OWNER）1 = 3；
    // 失败行与上月行不计入；OWNER 用 OTHER 团队 key 的调用计入 OTHER 池。
    await recordApiCallRecord(call(OWNER, OWNER));
    await recordApiCallRecord(call(MEMBER, OWNER));
    await recordApiCallRecord(call(OWNER, OWNER, 'api_error'));
    await recordApiCallRecord(call(OWNER, OWNER), lastMonth);
    await recordApiCallRecord(call(OWNER, OTHER));
    await db.insert(apiCallRecords).values({
      id: `${PREFIX}legacy-owner`, userId: OWNER, quotaOwnerId: null, periodMonth: period,
      endpointPath: '/api/policies/evaluate', status: 'success', latencyMs: 1,
    });
    // MEMBER 自己的池：一条旧行 + 一条个人调用 = 2
    await db.insert(apiCallRecords).values({
      id: `${PREFIX}legacy-member`, userId: MEMBER, quotaOwnerId: null, periodMonth: period,
      endpointPath: '/api/policies/evaluate', status: 'success', latencyMs: 1,
    });
    await recordApiCallRecord(call(MEMBER, MEMBER));
  });

  afterAll(async () => {
    await cleanup(db);
    globalForDb.__asterLocalDevDb = previous;
    if (previousKey === undefined) delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    else process.env.ASTER_PLAN_GATE_HMAC_KEY = previousKey;
    await db.$client.end({ timeout: 1 });
  });

  it('批量计数与逐 owner 计数一致，没有调用的 owner 计 0', async () => {
    const batch = await countOwnerPoolUsageByOwner(USER_IDS, period);
    expect(Object.fromEntries(batch)).toEqual({ [OWNER]: 3, [MEMBER]: 2, [IDLE]: 0, [OTHER]: 1 });
    for (const id of USER_IDS) {
      expect(batch.get(id), id).toBe(await countOwnerPoolUsage(id, period));
    }
  });

  it('批量计数只返回请求的 owner：他人池中的行不会混入', async () => {
    const batch = await countOwnerPoolUsageByOwner([OWNER], period);
    expect(Object.fromEntries(batch)).toEqual({ [OWNER]: 3 });
  });

  it('全量同步 users[] 带 monthlyUsed 与 usagePeriod', async () => {
    const res = await GET(signedGet(`?cursor=${encodeURIComponent(PREFIX)}&limit=5000`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: Array<{ userId: string; monthlyUsed: number; usagePeriod: string }> };
    const ours = Object.fromEntries(
      body.users.filter((u) => USER_IDS.includes(u.userId)).map((u) => [u.userId, [u.monthlyUsed, u.usagePeriod]]),
    );
    expect(ours).toEqual({
      [OWNER]: [3, period],
      [MEMBER]: [2, period],
      [IDLE]: [0, period],
      [OTHER]: [1, period],
    });
  });
});
