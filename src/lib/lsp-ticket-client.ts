/**
 * 浏览器端：拼 LSP 网关握手 URL 的鉴权参数（#657）。
 *
 * 每次连接 / 重连前向 cloud 取一张新 ticket（一次性，不能复用）。取不到时
 * （端点未部署、LSP_TICKET_SECRET 未配置、网络错误）返回空串：不带任何凭据发起握手，
 * 由网关决定放行与否（本地非生产网关放行，远端网关返回 401 并走正常重连退避）。
 */
export async function lspAuthQuery(opts: { fetchImpl?: typeof fetch } = {}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl('/api/lsp/ticket', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    if (res.ok) {
      const body = (await res.json()) as { ticket?: unknown };
      if (typeof body.ticket === 'string' && body.ticket) return `&ticket=${encodeURIComponent(body.ticket)}`;
    }
  } catch {
    // 取票失败：不带凭据握手
  }
  return '';
}
