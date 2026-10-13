/**
 * 分批清理的公共原语：execution 留存清理（#481）与 UsedNonce 回收（#480）共用。
 */

/**
 * 取 postgres-js 结果上的受影响行数（RowList.count）。
 *
 * <p>★不用 `.returning()` 计数：那会把每一条被删 / 被改的行 id 回传进 Worker 内存，
 * 积压上百万行时足以 OOM（#481）。取不到 count 时直接报错，不当成 0——
 * 当成 0 会让循环以为清完了。
 */
export function affectedRows(result: unknown): number {
  const count = (result as { count?: unknown } | null)?.count;
  if (typeof count !== 'number') {
    throw new Error('数据库驱动未返回受影响行数（RowList.count）');
  }
  return count;
}

/** 反复执行一批，直到某批不满（已清完）或达到批数上限。 */
export async function runInBatches(
  runBatch: () => Promise<number>,
  batchSize: number,
  maxBatches: number,
): Promise<{ affected: number; complete: boolean }> {
  let affected = 0;
  for (let i = 0; i < maxBatches; i++) {
    const n = await runBatch();
    affected += n;
    if (n < batchSize) return { affected, complete: true };
  }
  return { affected, complete: false };
}
