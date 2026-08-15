/**
 * 可信设备的列表与吊销（issue #400）。
 *
 * <p>与 `/api/auth/trusted-device` 分开：那条是**登录流程**用的
 * （未登录时读 cookie、登录成功后签发），这条是**已登录用户管理自己的设备**。
 * 混在一条路由里会让"未登录可访问"与"必须登录"两种鉴权要求纠缠。
 *
 * <p>★所有操作都以 session 的 userId 为准，**不接受客户端传入的 userId**——
 * 否则任意用户都能列出/吊销别人的设备。
 */

import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/auth';
import { listTrustedDevices, revokeTrustedDevice } from '@/lib/trusted-device';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }

  const devices = await listTrustedDevices(session.user.id);
  return NextResponse.json({ devices });
}

export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }

  const { id } = (await request.json().catch(() => ({}))) as { id?: string };
  if (!id) {
    return NextResponse.json({ error: 'MISSING_ID' }, { status: 400 });
  }

  // revokeTrustedDevice 内部同时按 userId + id 过滤：
  // 别人的设备 id 传进来会返回 false，而不是被删掉。
  const removed = await revokeTrustedDevice(session.user.id, id);
  if (!removed) {
    // 404 而非 403——403 会泄露"这个 id 存在但不属于你"，
    // 把端点变成设备 id 的存在性探针。
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
