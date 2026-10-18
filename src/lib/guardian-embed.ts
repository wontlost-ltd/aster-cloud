// AI Guardian 嵌入的共享配置：CSP、嵌入组件与页面链接共用同一个 base。
// 不在模块加载阶段读 env（middleware import 链约束），调用方传入已读取的配置值。
import { locales } from '@/i18n/config';
import { safeEnv } from '@/lib/runtime/safe-env';

export const GUARDIAN_EMBED_DEFAULT_BASE = 'https://aster-lang.dev/embed/guardian';
// 嵌入页（aster-lang.dev）与本站使用同一套 locale；直接复用站点配置，避免两处清单漂移。
export const GUARDIAN_EMBED_LOCALES: readonly string[] = locales;

/** 配置值缺失或不是合法 URL 时回退默认 base；去掉末尾斜杠。 */
export function resolveGuardianEmbedBase(configured?: string): string {
  const raw = configured || GUARDIAN_EMBED_DEFAULT_BASE;
  try {
    new URL(raw);
    return raw.replace(/\/+$/, '');
  } catch {
    return GUARDIAN_EMBED_DEFAULT_BASE;
  }
}

/** frame-src 使用的来源（scheme://host[:port]）。 */
export function guardianEmbedOrigin(configured?: string): string {
  return new URL(resolveGuardianEmbedBase(configured)).origin;
}

/** 「亲手试试」完整演示页地址：与嵌入同源，路径 /<locale>/demos/guardian。 */
export function guardianTryItUrl(
  locale: string,
  configured: string | undefined = safeEnv('NEXT_PUBLIC_GUARDIAN_EMBED_URL'),
): string {
  const loc = GUARDIAN_EMBED_LOCALES.includes(locale) ? locale : 'en';
  return `${guardianEmbedOrigin(configured)}/${loc}/demos/guardian`;
}
