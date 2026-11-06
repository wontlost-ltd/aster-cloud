/**
 * POST /api/lsp/ticket —— 为登录用户签发连接 LSP 网关的一次性短时 ticket（#657）。
 *
 * 取代构建期内联进前端的共享 token：ticket 用服务端密钥 LSP_TICKET_SECRET 签名，
 * 绑定用户、60 秒过期、网关侧只能用一次。未配置密钥时返回 503，客户端回落到旧 token（过渡期）。
 */
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { issueLspTicket } from '@/lib/lsp-ticket';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }
  const secret = (process.env.LSP_TICKET_SECRET || '').trim();
  if (!secret) {
    return NextResponse.json(
      { error: 'LSP tickets are not configured.', code: 'lsp_ticket_unconfigured' },
      { status: 503, headers: NO_STORE },
    );
  }
  const now = Date.now();
  const ticket = await issueLspTicket({ secret, sub: session.user.id, now });
  const [payloadPart] = ticket.split('.');
  const { exp } = JSON.parse(atob(payloadPart.replace(/-/g, '+').replace(/_/g, '/'))) as { exp: number };
  return NextResponse.json({ ticket, expiresAt: exp }, { headers: NO_STORE });
}
