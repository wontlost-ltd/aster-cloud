/**
 * 「记住该设备」——用户主动勾选后跳过二次验证（issue #400）。
 *
 * <h2>★为什么不用设备指纹</h2>
 *
 * 常见做法是采集 UA + 屏幕尺寸 + 字体 + Canvas 指纹拼一个 ID。本实现**刻意不这么做**：
 * 那是**被动采集的跨站可追踪标识**，用户无从察觉、无从清除，属于隐私敏感数据；
 * 而且它并不更安全——指纹可被伪造，攻击者复刻一份即可冒充"可信设备"。
 *
 * 改为：勾选时签发一个 **32 字节随机 token**，放进 httpOnly cookie，
 * 库里只存 `sha256(token)`。三个性质：
 *   - **用户主动授权** —— 不勾选就没有任何记录
 *   - **可自行清除** —— 清 cookie 即失效
 *   - **可服务端吊销** —— 删行即刻生效（与不可吊销的 JWT session 不同）
 *
 * <h2>安全边界</h2>
 *
 * 可信设备**只跳过第二因子，不跳过密码**。即它把"两因子"降级为"一因子 + 一个
 * 长期持有物"，而不是免登录。这是"记住设备"这类功能的固有取舍——
 * 故给了 30 天上限并支持吊销，而不是无限期。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { and, eq, gt, lt } from 'drizzle-orm';

import { getDb } from '@/db';
import { trustedDevices } from '@/db/schema';

/** cookie 名。httpOnly + Secure + SameSite=Lax，由调用方设置。 */
export const TRUSTED_DEVICE_COOKIE = 'aster_td';

/**
 * 可信设备有效期（天）。
 *
 * ★30 天是**上限**而非目标值：这段时间内该设备只需密码即可登录，
 * 等于把二因子降级成一因子 + 持有物。再长就与"记住我"没有区别了。
 */
export const TRUST_TTL_DAYS = 30;

function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * 从 UA 提炼**粗粒度**标签，仅供用户在设备列表里辨认。
 *
 * ★刻意只保留浏览器 + 平台两级，不存完整 UA——完整 UA 本身就接近指纹
 * （版本号 + 渲染引擎 + 设备型号的组合足以缩小到很小的人群）。
 */
export function coarseLabel(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  // ★iOS 上**所有**浏览器都必须用自己的专属标记来认（用户报告的真实 bug）：
  //   Apple 规定 iOS 浏览器一律使用 WebKit，故 Chrome/Firefox/Edge 的 iOS 版
  //   UA 里**没有** `Chrome/`、`Firefox/`，只有 `CriOS/`、`FxiOS/`、`EdgiOS/`，
  //   同时都带着 `Safari/`。只测 `Chrome\//Safari\/` 会把 iOS Chrome 认成 Safari。
  //   顺序也重要：这些专属标记必须排在通用的 Safari 判定**之前**。
  const browser = /EdgiOS\//.test(userAgent)
    ? 'Edge'
    : /CriOS\//.test(userAgent)
      ? 'Chrome'
      : /FxiOS\//.test(userAgent)
        ? 'Firefox'
        : /Edg\//.test(userAgent)
          ? 'Edge'
          : /OPR\//.test(userAgent)
            ? 'Opera'
            : /Firefox\//.test(userAgent)
              ? 'Firefox'
              : /Chrome\//.test(userAgent)
                ? 'Chrome'
                : /Safari\//.test(userAgent)
                  ? 'Safari'
                  : 'Browser';

  // ★iOS 必须排在 macOS **之前**（同一个 bug 的另一半）：
  //   iPhone/iPad 的 UA 里含有字面量 `like Mac OS X`，
  //   先测 `/Mac OS X/` 会让**每一台 iOS 设备**都被记成 macOS。
  //   Android 同理要排在 Linux 之前——Android UA 里含 `Linux`。
  const os = /iPhone|iPad|iPod/.test(userAgent)
    ? 'iOS'
    : /Android/.test(userAgent)
      ? 'Android'
      : /Mac OS X/.test(userAgent)
        ? 'macOS'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : 'Unknown OS';
  return `${browser} on ${os}`;
}

/**
 * 签发一个可信设备 token。返回**明文 token**，调用方负责写入 httpOnly cookie。
 */
export async function issueTrustedDevice(
  userId: string,
  userAgent?: string | null,
  now: Date = new Date(),
): Promise<string> {
  const db = getDb();
  const token = randomBytes(32).toString('hex');

  await db.insert(trustedDevices).values({
    id: crypto.randomUUID(),
    userId,
    tokenHash: hashToken(token),
    label: coarseLabel(userAgent),
    expires: new Date(now.getTime() + TRUST_TTL_DAYS * 24 * 60 * 60_000),
    createdAt: now,
  });

  return token;
}

/**
 * 该 token 是否是**这个用户**的有效可信设备。
 *
 * ★必须同时校验 userId：只按 token 查会让 A 用户的可信设备 cookie
 * 在 B 用户登录时也生效——那是跨账户的二次验证绕过。
 */
export async function isTrustedDevice(
  userId: string,
  token: string | null | undefined,
  now: Date = new Date(),
): Promise<boolean> {
  if (!token) return false;
  const db = getDb();

  const row = await db.query.trustedDevices.findFirst({
    where: and(
      eq(trustedDevices.userId, userId),
      eq(trustedDevices.tokenHash, hashToken(token)),
      gt(trustedDevices.expires, now),
    ),
  });

  if (!row) return false;
  // 恒定时间再比一次：上面的 eq 走的是索引查找，这里防御性地避免
  // 将来有人把查询改成前缀/模糊匹配。
  if (!safeEqualHex(row.tokenHash, hashToken(token))) return false;

  await db
    .update(trustedDevices)
    .set({ lastUsedAt: now })
    .where(eq(trustedDevices.id, row.id));

  return true;
}

/** 吊销单个可信设备（用户在设备列表里点"移除"）。 */
export async function revokeTrustedDevice(userId: string, id: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .delete(trustedDevices)
    .where(and(eq(trustedDevices.userId, userId), eq(trustedDevices.id, id)))
    .returning({ id: trustedDevices.id });
  return rows.length > 0;
}

/**
 * 吊销某用户的**全部**可信设备。
 *
 * ★改密码时应当调用：密码可能已泄露，此时留着"跳过第二因子"的设备
 * 等于给攻击者留了一条只需旧密码的通道。
 */
export async function revokeAllTrustedDevices(userId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .delete(trustedDevices)
    .where(eq(trustedDevices.userId, userId))
    .returning({ id: trustedDevices.id });
  return rows.length;
}

/** 列出用户的有效可信设备，供设置页展示。★不返回 tokenHash。 */
export async function listTrustedDevices(userId: string, now: Date = new Date()) {
  const db = getDb();
  return db
    .select({
      id: trustedDevices.id,
      label: trustedDevices.label,
      lastUsedAt: trustedDevices.lastUsedAt,
      createdAt: trustedDevices.createdAt,
      expires: trustedDevices.expires,
    })
    .from(trustedDevices)
    .where(and(eq(trustedDevices.userId, userId), gt(trustedDevices.expires, now)));
}

/** 清理过期设备行。 */
export async function purgeExpiredTrustedDevices(now: Date = new Date()): Promise<number> {
  const db = getDb();
  const rows = await db
    .delete(trustedDevices)
    .where(lt(trustedDevices.expires, now))
    .returning({ id: trustedDevices.id });
  return rows.length;
}
