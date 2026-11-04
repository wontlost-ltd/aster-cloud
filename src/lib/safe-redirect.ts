/**
 * 站内回跳校验（#695）——所有「登录 / 注册后跳回 callbackUrl」类参数的唯一判定入口。
 *
 * 此前各处各写一套前缀判断（signup 只看「以 / 开头且不以 // 开头」，login 干脆原样跳转），
 * `/\evil.com` 这类写法就能绕过：浏览器按 WHATWG URL 规则把 `\` 当 `/`，`/\evil.com`
 * 实为协议相对地址 `//evil.com`。前缀判断永远追不上解析器的规则，所以这里改为：
 *
 *   1. 先拒绝解析器会「悄悄改写」的输入：非字符串、超长、含反斜杠、含 C0 控制字符 / DEL
 *      （URL 解析会删掉制表符 / 换行，`/\t/evil.com` 由此变成 `//evil.com`）、首尾空白；
 *   2. 只接受以 `/` 开头的相对路径，或（给了站点 origin 时）同源绝对地址；
 *   3. 用 URL 构造器对站点 origin 解析，要求解析后 origin 完全一致（协议 + 主机 + 端口），
 *      `javascript:` / `data:` / userinfo 伪装 / 子域伪装都在这一步落空；
 *   4. 解析后的路径再查一次不能以 `//` 开头——`/.//evil.com` 经点段归一后会变成 `//evil.com`。
 *
 * 放行时返回规范化后的 `pathname + search + hash`（总是单个 `/` 开头的站内路径），
 * 否则返回调用方给的回落值。
 */

/** 回跳参数的长度上限：正常深链（含邀请 token）远小于此，超长输入直接回落。 */
export const MAX_REDIRECT_LENGTH = 2048;

/**
 * 未提供站点 origin 时用于解析的占位 origin。`.invalid` 是保留 TLD，永远不会是真实站点，
 * 因此任何绝对地址都不可能与它同源——等价于「只接受相对路径」。
 */
const PLACEHOLDER_ORIGIN = 'https://safe-redirect.invalid';

// 反斜杠 + C0 控制字符 + DEL：URL 解析会把它们改写或删除，必须在解析前拒绝
const UNSAFE_CHARS = /[\\\u0000-\u001f\u007f]/;

/**
 * 把不可信的回跳参数收敛为站内路径；不安全时返回 `fallback`。
 *
 * @param raw        来自 query / 表单 / 回调的原始值（任意类型）
 * @param fallback   不安全时的回落值（默认页路径，或 null 表示「没有可用回跳」）
 * @param siteOrigin 站点 origin（如浏览器端的 `window.location.origin`）；给出时同源绝对地址也放行
 */
export function safeRedirectPath<T extends string | null>(
  raw: unknown,
  fallback: T,
  siteOrigin?: string,
): string | T {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_REDIRECT_LENGTH) return fallback;
  if (UNSAFE_CHARS.test(raw) || raw.trim() !== raw) return fallback;

  const origin = siteOrigin ? toOrigin(siteOrigin) : PLACEHOLDER_ORIGIN;
  if (!origin) return fallback;
  // 相对输入必须以单个 / 开头；其余（`evil.com`、`?x=1`、`https:evil.com`）只有写成同源绝对地址才可能放行
  if (!raw.startsWith('/') && !raw.toLowerCase().startsWith(`${origin.toLowerCase()}/`)) return fallback;

  let parsed: URL;
  try {
    parsed = new URL(raw, origin);
  } catch {
    return fallback;
  }
  if (parsed.origin !== origin) return fallback;

  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (!path.startsWith('/') || path.startsWith('//')) return fallback;
  return path;
}

/**
 * Auth.js `callbacks.redirect` 的实现：站内地址拼回 baseUrl 的 origin，其余一律回 baseUrl。
 * 与默认实现相比，额外挡住反斜杠 / 控制字符 / 点段归一等绕过写法，并与页面侧共用同一判定。
 */
export function resolveAuthRedirect({ url, baseUrl }: { url: string; baseUrl: string }): string {
  const origin = toOrigin(baseUrl);
  if (!origin) return baseUrl;
  const path = safeRedirectPath(url, null, origin);
  return path === null ? baseUrl : `${origin}${path}`;
}

function toOrigin(value: string): string | null {
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}
