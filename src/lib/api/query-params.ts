/**
 * URL 查询参数解析：非法值一律回落到默认值或「不过滤」，而不是把 NaN / Invalid Date 交给查询层。
 *
 * 曾经各路由直接 `parseInt(...)`：`?page=abc` 得到 NaN，Drizzle 遇到 NaN 的 limit/offset 会直接
 * 丢掉分页子句，返回全部记录；`?days=abc` 让日期计算变成 Invalid Date，查询报 500（#479）。
 */

/**
 * 解析正整数参数。缺省、非数字、≤ 0 时返回 `fallback`；给了 `max` 时截到上限。
 */
export function parsePositiveInt(value: string | null, fallback: number, max?: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return max === undefined ? parsed : Math.min(parsed, max);
}

/**
 * 解析日期参数。缺省或解析不出有效日期时返回 `undefined`（调用方据此跳过该过滤条件）。
 */
export function parseDateParam(value: string | null): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * 解析枚举参数。不在 `allowed` 内时返回 `undefined`，避免非法值进到数据库枚举比较里报错。
 */
export function parseEnumParam<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}
