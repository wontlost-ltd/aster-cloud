/**
 * Postgres 错误识别。
 */

/**
 * 取 SQLSTATE：drizzle 会把 postgres-js 的 PostgresError 包一层，code 落在 `cause.code` 上；
 * 换驱动时也可能直接在顶层。两处都看——只看顶层会把每一次冲突都当成未知错误抛出
 * （#480 的真 Postgres 集成测试抓到 nonce-service 正是如此）。
 */
function hasSqlState(err: unknown, sqlState: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidates: unknown[] = [err];
  if ('cause' in err) candidates.push((err as { cause: unknown }).cause);
  return candidates.some((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) return false;
    if (!('code' in candidate)) return false;
    return (candidate as { code: unknown }).code === sqlState;
  });
}

/** 是否唯一约束冲突（SQLSTATE 23505）。 */
export function isUniqueViolation(err: unknown): boolean {
  return hasSqlState(err, '23505');
}

/**
 * 是否表不存在（SQLSTATE 42P01 undefined_table）。
 *
 * <p>只用于迁移窗口容错：Worker 先于 k3s PostSync 迁移 Job 部署时，新表尚未建出。
 * 仅凭 SQLSTATE 判断，不匹配报错文本，避免把别的错误误吞。
 */
export function isUndefinedTable(err: unknown): boolean {
  return hasSqlState(err, '42P01');
}
