/**
 * /api/internal/* 入站验签的唯一入口：验签名 + 拒重放（#480）。
 *
 * <h3>为什么要查重放</h3>
 *
 * 签名只能证明「这条请求出自持钥方」，证明不了「这是第一次收到」。此前只验签名、
 * nonce 验完即丢，于是同一条 (签名, body, nonce) 在 300 秒时间窗内可被原样重放任意次：
 * 打 /api/internal/api/usage、/api/internal/ai/usage 即重复写入用量，污染计费与配额。
 *
 * <h3>怎么拒</h3>
 *
 * 签名通过后把 nonce 写进 UsedNonce 表，靠唯一约束原子去重：第二次写入冲突即判重放。
 * 必须**先验签名再认领**——反过来，任何人发一堆垃圾请求都能往表里灌行。
 *
 * <h3>两个时间窗如何衔接</h3>
 *
 * - 时间戳偏差超过 300 秒：签名本身就被拒（stale_timestamp），与 nonce 无关；
 * - 300 秒以内：靠 nonce 记录拒重放。所以 nonce 记录只需活到「该时间戳的窗口关闭」，
 *   即 timestamp + 300 秒；再加 60 秒余量，抵消清理 cron 与本 isolate 的时钟差。
 *   过了这个时刻，同一签名再来已经会因时间戳过期被拒，记录删掉也不会放出重放。
 *
 * <h3>不覆盖的路径</h3>
 *
 * v1 旧格式（ASTER_INTERNAL_ALLOW_LEGACY_SIG=true 的紧急回退）不带 nonce，无从去重，
 * 开启期间仍可重放。它默认关闭，见 api-signing.ts。
 */

import {
  checkInternalSignature,
  INTERNAL_TS_WINDOW_SEC,
  type InternalVerifyResult,
} from '@/lib/api-signing';
import { claimNonce } from '@/services/security/nonce-service';

/** nonce 记录比签名窗口多活的秒数，见文件头。 */
const NONCE_RETENTION_MARGIN_SEC = 60;

/** 某个签名时间戳对应的 nonce 记录过期时刻。 */
export function nonceExpiresAt(timestampSec: number): Date {
  return new Date((timestampSec + INTERNAL_TS_WINDOW_SEC + NONCE_RETENTION_MARGIN_SEC) * 1000);
}

/**
 * 校验 aster-api → aster-cloud 的内部调用：签名、时间窗、重放。
 *
 * <p>nonce 存储不可用时 fail-closed（拒绝），不退化为「只验签名」——
 * 退化就等于在数据库抖动期间重新打开重放。
 *
 * @param req      入站请求；body 需由调用方先读出（Request body 只能读一次）
 * @param rawBody  已读出的原始 body 文本；GET 传空串
 * @param secret   共享密钥
 */
export async function verifyInternalSignature(
  req: Request,
  rawBody: string,
  secret: string,
  opts?: { allowLegacy?: boolean },
): Promise<InternalVerifyResult> {
  const check = await checkInternalSignature(req, rawBody, secret, opts);
  if (!check.ok) return check;
  if (check.usedLegacyCanonical) return { ok: true, usedLegacyCanonical: true };

  let firstUse: boolean;
  try {
    firstUse = await claimNonce(check.nonce, nonceExpiresAt(check.timestamp));
  } catch (err) {
    console.error('[internal-signature] nonce 认领失败，拒绝请求：', err);
    return { ok: false, reason: 'nonce_check_failed' };
  }
  if (!firstUse) return { ok: false, reason: 'replayed_nonce' };
  return { ok: true, usedLegacyCanonical: false };
}
