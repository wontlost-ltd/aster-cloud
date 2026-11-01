/**
 * 常见个人 / 免费邮箱域名，用于把试点申请区分为「企业域名」与「个人邮箱」两类线索。
 *
 * 只做分类、不拒绝提交：个人邮箱也可能是真实需求方（顾问、早期团队），交给人工判断。
 * 列表覆盖主要市场（北美、欧洲、印度、中国）的大型免费邮箱，未收录的域名一律视为企业域名。
 */
const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com',
  'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'ymail.com', 'rocketmail.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'mail.com', 'gmx.com', 'gmx.net', 'gmx.de', 'web.de', 't-online.de', 'freenet.de',
  'proton.me', 'protonmail.com', 'pm.me', 'tutanota.com', 'tuta.io', 'fastmail.com', 'hey.com',
  'zoho.com', 'zohomail.com', 'yandex.com', 'yandex.ru', 'mail.ru',
  'rediffmail.com',
  'qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net', 'sina.com', 'sina.cn', 'sohu.com', 'aliyun.com',
]);

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domain.trim().toLowerCase());
}
