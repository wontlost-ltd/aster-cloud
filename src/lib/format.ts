/**
 * 格式化日期字符串
 * 使用明确的 locale 和格式选项，确保服务端和客户端输出一致
 * 避免 React hydration error #418
 */
export function formatDate(dateString: string | Date, locale: string): string {
  const date = typeof dateString === 'string' ? new Date(dateString) : dateString;
  // ★必须固定 timeZone：只给 locale 时，服务端（容器 / Workers 为 UTC）与浏览器（用户本地时区）
  //   在跨日窗口内格式化出不同日期，触发 hydration #418（#585：22:04 UTC 的时间在 UTC 为 10/12、
  //   在 Pacific/Auckland 为 10/13）。与 docs trust-footer 一致，日期一律按 UTC 日历日显示。
  return date.toLocaleDateString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'UTC',
  });
}
