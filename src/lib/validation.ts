/**
 * 团队和资源的通用验证工具
 */

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * 验证团队名称
 * - 长度：2-50 个字符
 */
export function validateTeamName(name: unknown): ValidationResult {
  if (typeof name !== 'string') {
    return { valid: false, error: '团队名称必须是字符串' };
  }
  if (name.length < 2 || name.length > 50) {
    return { valid: false, error: '团队名称必须是 2-50 个字符' };
  }
  return { valid: true };
}

/**
 * 验证 slug（URL 友好标识符）
 * - 长度：2-50 个字符
 * - 只允许小写字母、数字和连字符
 * - 不能以连字符开头或结尾
 * - 不能包含连续的连字符
 */
export function validateSlug(slug: unknown): ValidationResult {
  if (typeof slug !== 'string') {
    return { valid: false, error: 'Slug 必须是字符串' };
  }
  if (slug.length < 2 || slug.length > 50) {
    return { valid: false, error: 'Slug 必须是 2-50 个字符' };
  }
  // 只允许小写字母、数字和连字符
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return { valid: false, error: 'Slug 只能包含小写字母、数字和连字符' };
  }
  // 不能以连字符开头或结尾
  if (slug.startsWith('-') || slug.endsWith('-')) {
    return { valid: false, error: 'Slug 不能以连字符开头或结尾' };
  }
  // 不能包含连续的连字符
  if (slug.includes('--')) {
    return { valid: false, error: 'Slug 不能包含连续的连字符' };
  }
  return { valid: true };
}

/** 自动生成的 slug 无可用 ASCII 字符时的兜底前缀。 */
export const SLUG_FALLBACK_PREFIX = 'team';

/**
 * 生成 slug（从名称自动生成）
 *
 * 只产出 validateSlug 接受的形态（`[a-z0-9-]`、2-50 字符、无首尾/连续连字符），
 * 保证"自动生成的值永远能通过服务端校验"：
 * - 拉丁字母先做 NFKD 分解再去掉附加符号（"Café" → "cafe"），全角字母数字归一为半角；
 * - 其余非 ASCII（中文、天城文等）直接剔除，不做音译——音译需要词典，且结果不可预期；
 * - 剔除后不足 2 个字符时用 `team-<suffix>` 兜底。suffix 由调用方传入并在表单生命周期内
 *   保持不变，避免每次键入都换一个随机串。
 */
export function generateSlug(name: string, fallbackSuffix: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // 去掉拉丁字母的附加符号
    .toLowerCase()
    .replace(/ß/g, 'ss') // ß 没有 NFKD 分解，按德语惯例写作 ss（"Straße" → "strasse"）
    .replace(/[^a-z0-9]+/g, '-') // 非 ASCII 字母数字一律视为分隔符
    .replace(/-{2,}/g, '-') // 合并连续连字符
    .substring(0, 50)
    .replace(/^-+|-+$/g, ''); // 截断后再去首尾连字符，避免截在分隔符上
  if (slug.length >= 2) return slug;
  return `${SLUG_FALLBACK_PREFIX}-${fallbackSuffix}`;
}

/**
 * 生成 slug 兜底用的短随机后缀（6 位小写十六进制）。
 * 用 getRandomValues 而不是 randomUUID：后者只在安全上下文（https / localhost）存在，
 * 内网纯 http 或按 IP 访问的私有部署会在 /teams/new 渲染时直接报错。
 */
export function randomSlugSuffix(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(3));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
