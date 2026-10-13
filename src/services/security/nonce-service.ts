/**
 * Nonce 服务 - 防重放攻击
 *
 * 使用一次性 Nonce 防止请求重放攻击。
 * 每个 Nonce 只能使用一次，过期后自动清理。
 */

import { db, usedNonces } from '@/lib/prisma';
import { inArray, lt, sql } from 'drizzle-orm';

import { isUniqueViolation } from '@/lib/pg-errors';
import { affectedRows, runInBatches } from '@/lib/retention/batching';

const NONCE_EXPIRY_MS = 10 * 60 * 1000; // 10 分钟

/** nonce 最大长度。aster-api 发的是 36 字符 UUID，cloud 出站发的是 32 位 hex。 */
const MAX_NONCE_LENGTH = 128;

/** 回收时每批删除的行数上限。 */
export const NONCE_GC_BATCH_SIZE = 5_000;

/** 单次回收的批数上限；清不完留给下一次 cron。 */
export const NONCE_GC_MAX_BATCHES_PER_RUN = 100;

export interface NonceCheckResult {
  valid: boolean;
  reason?: 'ALREADY_USED' | 'INVALID_FORMAT';
}

/**
 * 检查并记录 Nonce（原子操作）
 *
 * 使用数据库唯一约束保证原子性：
 * - 如果 Nonce 已存在，创建会失败（重放攻击）
 * - 如果 Nonce 不存在，创建成功并记录
 */
export async function checkAndRecordNonce(
  nonce: string,
  policyId?: string,
  userId?: string
): Promise<NonceCheckResult> {
  // 验证 Nonce 格式（UUID v4）
  const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidV4Regex.test(nonce)) {
    return { valid: false, reason: 'INVALID_FORMAT' };
  }

  const expiresAt = new Date(Date.now() + NONCE_EXPIRY_MS);
  const claimed = await insertNonceOnce({ nonce, policyId, userId, expiresAt });
  return claimed ? { valid: true } : { valid: false, reason: 'ALREADY_USED' };
}

/**
 * 认领一个 /api/internal/* 入站签名的 nonce（#480）。
 *
 * <p>与 {@link checkAndRecordNonce} 共用 UsedNonce 表与唯一约束，区别只有两点：
 * <ul>
 *   <li>不校验 UUID 格式：签名已证明 nonce 出自持钥方，格式由签名方决定；
 *       只限长度，防止超长值写进表里。</li>
 *   <li>过期时间由调用方按签名时间戳算出（见 internal-signature.ts），
 *       保证记录活得比该签名的可接受窗口更久。</li>
 * </ul>
 *
 * @returns true = 首次使用；false = 已被用过（重放）
 */
export async function claimNonce(nonce: string, expiresAt: Date): Promise<boolean> {
  if (nonce.length === 0 || nonce.length > MAX_NONCE_LENGTH) {
    throw new Error(`nonce 长度须在 1..${MAX_NONCE_LENGTH} 之间`);
  }
  return insertNonceOnce({ nonce, expiresAt });
}

/** 插入一条 nonce；唯一约束冲突（23505）即已被使用，返回 false。 */
async function insertNonceOnce(row: {
  nonce: string;
  expiresAt: Date;
  policyId?: string;
  userId?: string;
}): Promise<boolean> {
  try {
    await db.insert(usedNonces).values({ id: crypto.randomUUID(), ...row });
    return true;
  } catch (error: unknown) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

/**
 * 清理过期的 Nonce 记录，返回删除的行数与是否清完。
 *
 * <p>由每小时的 cleanup-nonces cron 调用。每批一条短语句，积压一次清不完就留给下一次
 * （complete=false）；计数取驱动返回的受影响行数，不把被删的行回传进内存（同 #481）。
 *
 * @param now 注入当前时间以便测试
 */
export async function cleanupExpiredNonces(
  now: Date = new Date(),
  opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<{ deletedCount: number; complete: boolean }> {
  const batchSize = opts.batchSize ?? NONCE_GC_BATCH_SIZE;
  const { affected, complete } = await runInBatches(
    async () => {
      const doomed = db.select({ id: usedNonces.id })
        .from(usedNonces)
        .where(lt(usedNonces.expiresAt, now))
        .limit(batchSize);
      return affectedRows(await db.delete(usedNonces).where(inArray(usedNonces.id, doomed)));
    },
    batchSize,
    opts.maxBatches ?? NONCE_GC_MAX_BATCHES_PER_RUN,
  );
  return { deletedCount: affected, complete };
}

/**
 * 获取 Nonce 统计信息（用于监控）
 */
export async function getNonceStats(): Promise<{
  total: number;
  expired: number;
  active: number;
}> {
  const now = new Date();

  const [totalResult, expiredResult] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(usedNonces),
    db.select({ count: sql<number>`count(*)::int` })
      .from(usedNonces)
      .where(lt(usedNonces.expiresAt, now)),
  ]);

  const total = totalResult[0]?.count || 0;
  const expired = expiredResult[0]?.count || 0;

  return {
    total,
    expired,
    active: total - expired,
  };
}
