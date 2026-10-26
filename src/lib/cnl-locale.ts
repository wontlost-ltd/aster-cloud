/**
 * 策略 CNL 语言的受支持集合与规范化（保存入口与版本 locale 解析共用的唯一来源）。
 *
 * 受支持集合直接取自编辑器/编译器使用的 lexicon（aster-lexicon），保证「能保存的
 * locale」与「能编译的 locale」一致；版本 envelope 记录的 locale 因此只可能是这几个
 * 规范标签之一，可被 policy-version-locale 精确反推。
 */

import { DE_DE, EN_US, HI_IN, ZH_CN } from '@/lib/aster-lexicon';

/** 受支持的 CNL 语言（规范 BCP-47 标签）。 */
export const CNL_LOCALES: readonly string[] = [EN_US, ZH_CN, DE_DE, HI_IN].map((lexicon) => lexicon.id);

/** 保存请求未带 locale 时的默认值（与既有入口一致）。 */
export const DEFAULT_CNL_LOCALE = EN_US.id;

/**
 * 把请求里的 locale 规范为受支持标签：大小写不敏感的完整标签（`de-de` → `de-DE`），
 * 或唯一对应一个受支持标签的裸语言码（`de` → `de-DE`）。其它（如 `en-GB`、`fr-FR`）
 * 返回 null。
 */
export function normalizeCnlLocale(raw: string): string | null {
  const value = raw.trim().replace('_', '-').toLowerCase();
  const exact = CNL_LOCALES.find((locale) => locale.toLowerCase() === value);
  if (exact) return exact;
  const byLanguage = CNL_LOCALES.filter((locale) => locale.split('-')[0]!.toLowerCase() === value);
  return byLanguage.length === 1 ? byLanguage[0]! : null;
}

export type CompileLocaleResult = { ok: true; locale: string } | { ok: false; error: UnsupportedLocaleBody };

export interface UnsupportedLocaleBody {
  error: string;
  code: 'unsupported_locale';
  supportedLocales: readonly string[];
}

/**
 * 解析保存请求的 locale 字段：缺省/空串取默认值；不受支持时给出 400 响应体
 * （稳定 code 供前端本地化，见 policy-form saveErrorCodes.unsupported_locale）。
 */
export function parseCompileLocale(raw: unknown): CompileLocaleResult {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: true, locale: DEFAULT_CNL_LOCALE };
  }
  const locale = typeof raw === 'string' ? normalizeCnlLocale(raw) : null;
  if (locale) return { ok: true, locale };
  return {
    ok: false,
    error: {
      error: `Unsupported policy language. Supported: ${CNL_LOCALES.join(', ')}.`,
      code: 'unsupported_locale',
      supportedLocales: CNL_LOCALES,
    },
  };
}
