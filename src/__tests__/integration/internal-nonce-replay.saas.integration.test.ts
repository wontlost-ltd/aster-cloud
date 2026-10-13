// /api/internal/* 入站签名的重放拒绝与 nonce 回收，跑在真 Postgres 上（#480）。
//
// 单测用内存表验证「时间窗 × nonce」的组合逻辑；本文件验证单测证明不了的两件事：
// - 去重真的落在 UsedNonce 的唯一约束上（23505 → 重放），而不是某个进程内状态；
// - 回收按 expiresAt 分批删除，只删过期行，计数取驱动返回的受影响行数。

import { createHash, createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { db, usedNonces } from '@/lib/prisma';
import { nonceExpiresAt, verifyInternalSignature } from '@/lib/internal-signature';
import { claimNonce, cleanupExpiredNonces } from '@/services/security/nonce-service';

import { setupTestDb, teardownTestDb } from './setup-postgres';

const SECRET = 'nonce-replay-it-secret';
const PATH = '/api/internal/api/usage';
const BODY = '{"userId":"u1"}';

function signedRequest(ts: number, nonce: string): Request {
  const bodyHash = createHash('sha256').update(BODY, 'utf8').digest('hex');
  const sig = createHmac('sha256', SECRET)
    .update(`POST\n${PATH}\n${ts}\n${nonce}\n${bodyHash}`, 'utf8')
    .digest('hex');
  return new Request(`https://x.test${PATH}`, {
    method: 'POST',
    body: BODY,
    headers: { 'X-Aster-Timestamp': String(ts), 'X-Aster-Nonce': nonce, 'X-Internal-Signature': sig },
  });
}

async function nonceCount(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(usedNonces);
  return row?.n ?? 0;
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('内部签名重放拒绝（#480，真 Postgres）', () => {
  beforeAll(async () => {
    (process.env as Record<string, string>).NODE_ENV = 'test';
    await setupTestDb();
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await db.delete(usedNonces);
  });

  it('★同一签名请求第二次被拒，表里只有一行', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();
    expect(await verifyInternalSignature(signedRequest(ts, nonce), BODY, SECRET))
      .toEqual({ ok: true, usedLegacyCanonical: false });
    expect(await verifyInternalSignature(signedRequest(ts, nonce), BODY, SECRET))
      .toEqual({ ok: false, reason: 'replayed_nonce' });
    expect(await nonceCount()).toBe(1);
  });

  it('★并发重放：同一 nonce 同时到达，只有一个通过', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => verifyInternalSignature(signedRequest(ts, nonce), BODY, SECRET)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === 'replayed_nonce')).toHaveLength(7);
  });

  it('记录的过期时刻按签名时间戳计算', async () => {
    const ts = Math.floor(Date.now() / 1000) - 100;
    const nonce = crypto.randomUUID();
    await verifyInternalSignature(signedRequest(ts, nonce), BODY, SECRET);
    const [row] = await db.select({ expiresAt: usedNonces.expiresAt }).from(usedNonces);
    expect(row?.expiresAt.getTime()).toBe(nonceExpiresAt(ts).getTime());
  });

  it('★回收只删过期行，未过期的 nonce 仍能拒重放', async () => {
    const now = new Date('2026-10-13T12:00:00.000Z');
    await claimNonce('expired-1', new Date(now.getTime() - 1));
    await claimNonce('expired-2', new Date(now.getTime() - 60_000));
    await claimNonce('live', new Date(now.getTime() + 1));

    expect(await cleanupExpiredNonces(now)).toEqual({ deletedCount: 2, complete: true });
    expect(await nonceCount()).toBe(1);
    expect(await claimNonce('live', new Date(now.getTime() + 1))).toBe(false);
    // 过期记录删掉后可再写入（它对应的签名早已因时间戳过期被拒）
    expect(await claimNonce('expired-1', new Date(now.getTime() + 1))).toBe(true);
  });

  it('积压分批回收：批数上限内清不完时 complete=false，下一次接着清', async () => {
    const now = new Date('2026-10-13T12:00:00.000Z');
    for (let i = 0; i < 7; i++) await claimNonce(`old-${i}`, new Date(now.getTime() - 1000));

    expect(await cleanupExpiredNonces(now, { batchSize: 3, maxBatches: 2 }))
      .toEqual({ deletedCount: 6, complete: false });
    expect(await cleanupExpiredNonces(now, { batchSize: 3, maxBatches: 2 }))
      .toEqual({ deletedCount: 1, complete: true });
    expect(await nonceCount()).toBe(0);
  });

  it('恰好整批时多跑一批空批确认清完', async () => {
    const now = new Date('2026-10-13T12:00:00.000Z');
    for (let i = 0; i < 3; i++) await claimNonce(`full-${i}`, new Date(now.getTime() - 1000));
    expect(await cleanupExpiredNonces(now, { batchSize: 3, maxBatches: 5 }))
      .toEqual({ deletedCount: 3, complete: true });
  });
});
