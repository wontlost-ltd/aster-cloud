/**
 * R21-Critical-2: cron route 鉴权统一入口（fail-closed）。
 *
 * <p>历史 bug：每个 cron route 各自实现 guard，写法 `if (cronSecret && header !== ...)`
 * —— 当 CRON_SECRET 未配置时直接放行，destructive job 可被任意触发。
 * 现统一走此 helper，secret 缺失时 fail-closed 返回 503（"未配置 = 服务不可用"），
 * secret 存在但不匹配返回 401（"配置了但你没权限"）。
 *
 * <p>典型用法：
 * <pre>{@code
 *   export async function POST(req: NextRequest) {
 *     const guard = requireCronAuth(req);
 *     if (guard) return guard;
 *     // ... 真实任务逻辑
 *   }
 * }</pre>
 *
 * <p>开发环境豁免：仅当 NODE_ENV 显式为 'development' 或 'test' 且 CRON_SECRET
 *   未设置时，允许调用并打一行 warn。NODE_ENV 未设置（OpenNext/Workers 等运行时
 *   的默认情形）同样 fail-closed。
 *
 * <p>比较使用**定长时间**算法：先各自 SHA-256 再 timingSafeEqual。直接用 `!==`
 *   会在字符逐位比较时提前返回，理论上可被计时侧信道逐字节还原 secret；
 *   先哈希还能保证两侧长度恒为 32 字节（timingSafeEqual 对不等长输入会抛错）。
 *
 * <p>★与 `two-factor.ts` / `trusted-device.ts` 的做法**不同**，不要照搬：
 *   那两处比较的是**已持久化为 hash 的 hex 串**（长度天然相等），故先用
 *   `a.length !== b.length` 短路再比较即可。此处比较的是**原始请求头**，
 *   长度由攻击者控制，用长度短路等于把「长度对不对」这一位免费送出去，
 *   所以改为两侧现场哈希、不做任何长度短路。
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

/** 定长时间比较两个字符串：先哈希对齐长度，再逐字节比较。 */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * 校验 cron 鉴权头。
 *
 * @returns 校验通过时返回 null；失败时返回 NextResponse（caller 直接 return）。
 */
export function requireCronAuth(req: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization');

  if (!cronSecret) {
    // R21-Critical-2 + R23-Major-3: default fail-closed.
    // 仅在显式 development / test 时 warn-and-allow；NODE_ENV 未设、production
    // 或其他任何值 → 503。这样 OpenNext/Workers 等不设 NODE_ENV 的运行时
    // 也是安全的（fail-closed by default）。
    const env = process.env.NODE_ENV;
    if (env === 'development' || env === 'test') {
      console.warn(
        `[cron-auth] CRON_SECRET not set — allowing call in NODE_ENV=${env}. ` +
          'In production this would return 503.'
      );
      return null;
    }
    return NextResponse.json(
      {
        error: 'cron_secret_not_configured',
        message:
          'CRON_SECRET env var is required but missing. ' +
          'Cron endpoints are disabled until it is set ' +
          '(NODE_ENV=' + (env ?? 'unset') + ').',
      },
      { status: 503 }
    );
  }

  if (auth === null || !safeEqual(auth, `Bearer ${cronSecret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}
