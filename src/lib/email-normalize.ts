// 邮箱规范化：消除"同一人多账号"漏洞
//
// 规则：
//   - 所有域名：toLowerCase，并剥离 local-part 中的 +xxx 后缀
//     （Gmail、Google Workspace、Microsoft 365 / Outlook、iCloud、Fastmail、Proton 等主流服务
//     都把 a+x@ 投递到 a@ 的同一邮箱；只对 Gmail 剥离会让其余服务的 +别名成为免费额度的刷号口子）
//   - gmail.com / googlemail.com：另外去除 local-part 中的点，googlemail.com 归一为 gmail.com
//     foo.bar+spam@gmail.com → foobar@gmail.com
//
// 归一化结果写入 User.emailNormalized（部分唯一索引 User_emailNormalized_unique），
// 即「一个邮箱一个账号」：注册遇到同一邮箱的别名时明确报错，引导用既有账号登录；
// 团队邀请按同一邮箱（isSameMailbox）匹配，发给 a+team@ 的邀请可由 a@ 的账号接受。
//
// 详见 aster-deploy/docs/pm/07-ai-billing.md "反多重注册" 章节

const GMAIL_HOSTS = new Set(['gmail.com', 'googlemail.com']);

/**
 * 把任意输入邮箱归一化为去重键。
 * 注意：此函数仅用于"是否是同一人"的判断，不替换原始 email 列存储。
 */
export function normalizeEmail(email: string): string {
  if (!email || typeof email !== 'string') return '';
  const trimmed = email.trim().toLowerCase();
  const atIdx = trimmed.lastIndexOf('@');
  if (atIdx <= 0) return trimmed;

  let local = trimmed.slice(0, atIdx);
  const host = trimmed.slice(atIdx + 1);

  // 剥离 +suffix（任何域名通用）
  const plusIdx = local.indexOf('+');
  if (plusIdx >= 0) local = local.slice(0, plusIdx);

  // gmail / googlemail：去除 local-part 中的点
  if (GMAIL_HOSTS.has(host)) {
    local = local.replace(/\./g, '');
    // googlemail.com 与 gmail.com 视为同一域
    return `${local}@gmail.com`;
  }

  return `${local}@${host}`;
}

/**
 * 已有账号地址的掩码提示（#682）：保留 local-part 首字符、+后缀前 3 个字符与完整域名，
 * 例如 `ryan.pang+adr0051-retest@wontlost.com` → `r***+adr…@wontlost.com`。
 * 注册遇到同一邮箱的另一种写法时用它告诉用户「该用哪个地址登录」，又不完整暴露地址。
 */
export function maskEmail(email: string): string {
  const trimmed = (email ?? '').trim();
  const atIdx = trimmed.lastIndexOf('@');
  if (atIdx <= 0) return '***';
  const local = trimmed.slice(0, atIdx);
  const domain = trimmed.slice(atIdx + 1);
  const plusIdx = local.indexOf('+');
  const base = plusIdx >= 0 ? local.slice(0, plusIdx) : local;
  const suffix = plusIdx >= 0 ? local.slice(plusIdx + 1) : '';
  const maskedSuffix = plusIdx >= 0 ? `+${suffix.slice(0, 3)}${suffix.length > 3 ? '…' : ''}` : '';
  return `${base.charAt(0) || '*'}***${maskedSuffix}@${domain}`;
}

/**
 * 两个地址是否投递到同一邮箱：与注册去重同一口径（normalizeEmail），
 * 团队邀请的接受 / 拒绝 / 收件箱据此匹配，避免「+别名无法注册、邀请又只认 +别名」的死路。
 */
export function isSameMailbox(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = normalizeEmail(a);
  return na !== '' && na === normalizeEmail(b);
}
