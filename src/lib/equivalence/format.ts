/**
 * /equivalence 页面的数值与日期格式化。日期一律按 UTC 输出：
 * CSV 时间戳是 UTC，钉住时区可避免服务端与浏览器渲染不一致。
 */
export function formatParityDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', dateStyle: 'medium' }).format(new Date(iso));
}

/** 一致率百分比：100% 显示整数，其余保留一位小数（避免把 99.96% 四舍五入成 100%）。 */
export function formatParityRate(rate: number, locale: string): string {
  const digits = rate >= 1 ? 0 : 1;
  const floored = Math.floor(rate * 1000) / 1000;
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(rate >= 1 ? 1 : floored);
}
