/**
 * Nonce 清理任务与积压健康检查。
 *
 * 每小时由 /api/cron/cleanup-nonces 调度（cron-registry 的 cleanup-nonces）。
 * /api/internal/* 每次入站调用都会写一条 UsedNonce（#480），不清理表会无限增长。
 */

import { cleanupExpiredNonces, getNonceStats } from '@/services/security/nonce-service';

/** 删除已过期的 nonce；complete=false 表示积压本次没清完，留给下一次。 */
export async function cleanupNoncesJob(): Promise<{ deletedCount: number; complete: boolean }> {
  const result = await cleanupExpiredNonces();
  console.log(`[Cron] Cleaned up ${result.deletedCount} expired nonces (complete=${result.complete})`);
  return result;
}

/**
 * 健康检查：确保 Nonce 表没有过多积压
 *
 * @param maxActive 最大允许的活跃 Nonce 数量
 * @returns 是否健康
 */
export async function checkNonceHealth(maxActive: number = 100000): Promise<{
  healthy: boolean;
  stats: { total: number; expired: number; active: number };
  message: string;
}> {
  const stats = await getNonceStats();

  const healthy = stats.active <= maxActive;
  const message = healthy
    ? `Nonce count is within limits (${stats.active}/${maxActive})`
    : `Warning: Nonce count exceeds threshold (${stats.active}/${maxActive})`;

  return { healthy, stats, message };
}
