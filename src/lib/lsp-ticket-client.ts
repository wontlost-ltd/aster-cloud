/**
 * 浏览器端：拼 LSP 网关握手 URL 的鉴权参数（#657）。
 *
 * 每次连接 / 重连前向 cloud 取一张新 ticket（一次性，不能复用）。取不到时
 * （端点未部署、LSP_TICKET_SECRET 未配置、网络错误）回落到构建期内联的共享 token，
 * 保证过渡期两种部署都能连上；共享 token 下线后只剩 ticket。
 */
export async function lspAuthQuery(opts: {
  fetchImpl?: typeof fetch;
  legacyToken: string | undefined;
}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl('/api/lsp/ticket', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    if (res.ok) {
      const body = (await res.json()) as { ticket?: unknown };
      if (typeof body.ticket === 'string' && body.ticket) return `&ticket=${encodeURIComponent(body.ticket)}`;
    }
  } catch {
    // 取票失败按旧 token 处理，由网关决定是否放行
  }
  return opts.legacyToken ? `&token=${encodeURIComponent(opts.legacyToken)}` : '';
}
