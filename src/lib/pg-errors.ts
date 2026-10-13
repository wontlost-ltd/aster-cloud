/**
 * Postgres 错误识别。
 */

/**
 * 是否唯一约束冲突（SQLSTATE 23505）。
 *
 * <p>drizzle 会把 postgres-js 的 PostgresError 包一层，23505 落在 `cause.code` 上；
 * 换驱动时也可能直接在顶层。两处都看——只看顶层会把每一次冲突都当成未知错误抛出
 * （#480 的真 Postgres 集成测试抓到 nonce-service 正是如此）。
 */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidates: unknown[] = [err];
  if ('cause' in err) candidates.push((err as { cause: unknown }).cause);
  return candidates.some((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) return false;
    if (!('code' in candidate)) return false;
    return (candidate as { code: unknown }).code === '23505';
  });
}
