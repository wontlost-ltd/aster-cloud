/**
 * 仅用于 autocommit 的独立查询，在迁移窗口内以旧投影回退；单次新列部署周期后应删除。
 */
export const SAFE_COLUMNS: readonly string[] = [];

type DatabaseError = Error & {
  code?: string;
  cause?: { code?: string };
};

export async function safeColumnRead<T>(
  run: () => Promise<T>,
  fallback: () => Promise<T>,
  column: string,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const dbError = error as DatabaseError;
    if (dbError.code !== '42703' && dbError.cause?.code !== '42703') throw error;
    console.warn('[safe-column-read] 列缺失，使用回退投影', { column });
    return fallback();
  }
}
