/**
 * `db.execute()` 原生 SQL 结果的取行工具（#842）。
 *
 * drizzle 的 `execute()` 把驱动的原始结果原样返回，形态因驱动而异：
 * - node-postgres（当前驱动）：`QueryResult`，行在 `.rows`，受影响行数在 `.rowCount`；
 * - postgres-js（#842 之前的驱动，脚本与部分单测桩仍是这种形态）：结果本身就是行数组。
 *
 * 调用方此前普遍写 `result as unknown as Row[]`，类型检查对这种强转无能为力，换驱动后会静默拿到空结果。
 * 统一经此处取行：两种形态都认，认不出时直接报错，绝不当成「没有行」。
 *
 * 本模块不引入任何驱动，单测可直接使用。
 */

/** 取 `execute()` 结果中的行。 */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null | undefined)?.rows;
  if (Array.isArray(rows)) return rows as T[];
  throw new Error('数据库驱动返回了无法识别的结果形态：既不是行数组，也没有 rows 数组');
}

/** 取 `execute()` 结果中的第一行；没有行时返回 undefined。 */
export function firstRowOf<T>(result: unknown): T | undefined {
  return rowsOf<T>(result)[0];
}
