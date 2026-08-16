/**
 * TOTP（验证器 App）的绑定管理 —— issue #400 第二步。
 *
 * <p>全部要求**已登录会话**：绑定/解绑是账户安全设置，不能匿名操作。
 *
 * <ul>
 *   <li><b>GET</b>：查询当前绑定状态（是否已启用、剩余恢复码数）。</li>
 *   <li><b>POST</b>：开始绑定——生成候选 secret，返回二维码 SVG。
 *       ★此时**尚未启用**，必须再调 PUT 确认。</li>
 *   <li><b>PUT</b>：用 App 上的码确认绑定，成功后**一次性**返回恢复码。</li>
 *   <li><b>DELETE</b>：解绑。★必须提供一个有效的 TOTP 码或恢复码——
 *       否则拿到 session 的人（如借用了未锁屏的电脑）能直接关掉第二因子。</li>
 * </ul>
 */

import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/auth';
import { RateLimitPresets } from '@/lib/rate-limit';
import { checkRateLimitDistributed } from '@/lib/rate-limit-distributed';
import { renderQrSvg } from '@/lib/qr-code';
import {
  confirmEnrollment,
  countUnusedRecoveryCodes,
  disableTotp,
  hasTotpEnabled,
  startEnrollment,
  verifyTotpForLogin,
} from '@/lib/totp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 校验类操作的限流（独立审查发现的 Medium）。
 *
 * ★PUT / DELETE 都在**猜 6 位码**：单次命中率 1/10⁶，但 epochTolerance
 * 让三个窗口都有效（≈3/10⁶），若不限次就是可行的在线爆破——猜中即可
 * 关闭第二因子。同目录 verify-login 早已用这套机制，此处属遗漏而非无解。
 *
 * 按 userId 限流（已登录才可达），沿用 LOGIN 预设：60 秒 5 次。
 */
async function guardRate(userId: string): Promise<NextResponse | null> {
  const rl = await checkRateLimitDistributed(`totp:${userId}`, RateLimitPresets.LOGIN);
  if (!rl.allowed) {
    return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 });
  }
  return null;
}

async function requireUser() {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) return null;
  return { id: session.user.id, email: session.user.email };
}

export async function GET(): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });

  const enabled = await hasTotpEnabled(user.id);
  return NextResponse.json({
    enabled,
    remainingRecoveryCodes: enabled ? await countUnusedRecoveryCodes(user.id) : 0,
  });
}

export async function POST(): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });

  // ★已启用时不允许直接重置：否则拿到 session 就能悄悄把 secret 换成自己的。
  //   要换设备必须先 DELETE（需提供有效码），再重新绑定。
  if (await hasTotpEnabled(user.id)) {
    return NextResponse.json({ error: 'ALREADY_ENABLED' }, { status: 409 });
  }

  const { secret, otpauthUri } = await startEnrollment(user.id, user.email);

  return NextResponse.json({
    // ★secret 明文返回是**必要**的：用户可能无法扫码（桌面端无摄像头），
    //   需要手动输入。它只在绑定流程中短暂存在，确认后前端即丢弃。
    secret,
    otpauthUri,
    qrSvg: renderQrSvg(otpauthUri),
  });
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });

  const limited = await guardRate(user.id);
  if (limited) return limited;

  let token = '';
  try {
    token = String(((await req.json()) as { token?: unknown }).token ?? '');
  } catch {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }

  const res = await confirmEnrollment(user.id, token);
  if (!res.ok) {
    return NextResponse.json({ error: res.reason }, { status: 400 });
  }

  // ★恢复码**只在这一次**明文返回，之后只存 hash。
  return NextResponse.json({ ok: true, recoveryCodes: res.recoveryCodes });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });

  const limited = await guardRate(user.id);
  if (limited) return limited;

  if (!(await hasTotpEnabled(user.id))) {
    return NextResponse.json({ error: 'NOT_ENABLED' }, { status: 409 });
  }

  let token = '';
  try {
    token = String(((await req.json()) as { token?: unknown }).token ?? '');
  } catch {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }

  // ★解绑必须重新证明身份：只有 session 不够。
  //   session 可能来自一台没锁屏的电脑；关掉第二因子是高危操作。
  const verdict = await verifyTotpForLogin(user.id, token);
  if (!verdict.ok) {
    return NextResponse.json({ error: 'MISMATCH' }, { status: 400 });
  }

  await disableTotp(user.id);
  return NextResponse.json({ ok: true });
}
