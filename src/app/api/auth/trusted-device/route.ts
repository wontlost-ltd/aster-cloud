/**
 * 可信设备 token 的读取与签发（issue #400）。
 *
 * <p>为什么需要这条路由：Auth.js 的 `authorize()` **不能读写 cookie**——
 * 它在 NextAuth 内部执行，拿不到 Next 的 request/response。故：
 *
 * <ul>
 *   <li><b>GET</b>：登录前读出 httpOnly cookie 里的 token，交给前端连同
 *       email/password 一起提交（authorize 据此判断能否跳过第二因子）。</li>
 *   <li><b>POST</b>：登录成功且用户**勾选了「记住该设备」**后，签发新 token
 *       并写入 httpOnly cookie。</li>
 * </ul>
 *
 * <p>★token 全程不进 JS 可读的存储：cookie 是 httpOnly，前端只是把 GET 拿到的
 * 值原样回传。这样 XSS 拿不到它——虽然 XSS 已经能做更糟的事，但没必要多送一个。
 */

import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/auth';
import {
  TRUSTED_DEVICE_COOKIE,
  TRUST_TTL_DAYS,
  issueTrustedDevice,
} from '@/lib/trusted-device';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 登录前：读出既有 token（若有），供前端回传给 authorize。 */
export async function GET(request: NextRequest) {
  const token = request.cookies.get(TRUSTED_DEVICE_COOKIE)?.value ?? null;
  return NextResponse.json({ token });
}

/**
 * 登录成功后：为**当前已登录用户**签发可信设备 token。
 *
 * ★必须校验 session：没有这一步，任何人都能对任意 userId 签发一个
 * "可信设备"，从此只凭密码即可登录——等于自己给自己开了后门。
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }

  const token = await issueTrustedDevice(
    session.user.id,
    request.headers.get('user-agent'),
  );

  const res = NextResponse.json({ ok: true });
  res.cookies.set(TRUSTED_DEVICE_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: TRUST_TTL_DAYS * 24 * 60 * 60,
  });
  return res;
}
