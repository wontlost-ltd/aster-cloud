/**
 * 执行日志行映射：API/查询层字段 durationMs → 组件字段 duration。
 * 服务端首屏（page.tsx）与客户端翻页/筛选（logs-content.tsx）共用同一映射，避免两处漂移
 * （此前客户端漏映射导致时长显示 NaNs）。放在非 'use client' 模块，服务端可直接调用。
 */
export function toClientLog<T extends { durationMs?: number; duration?: number }>(
  item: T,
): Omit<T, 'durationMs'> & { duration: number } {
  const { durationMs, ...rest } = item;
  return { ...rest, duration: durationMs ?? item.duration ?? Number.NaN };
}
