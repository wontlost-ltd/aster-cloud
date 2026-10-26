/**
 * 批量导入结果的纯逻辑（#607/#629）：同步响应与异步任务共用。
 *
 * 成功行数只能取服务端的 rollup（added + reused），不能拿提交的行数代替——
 * 重复、校验失败、超配额的行都会被跳过。
 */

export interface BulkRowErrorView {
  row: number;
  code: string;
  message: string;
}

export interface BulkRollupView {
  added?: number;
  reused?: number;
  skipped?: number;
  errorCount?: number;
}

export interface BulkOutcomeSummary {
  imported: number;
  failed: number;
  /** 提交的总行数：取服务端 rowCount；缺失时按 imported + failed（两者恒覆盖全部行）。 */
  total: number;
  /** success：全部导入；partial：部分导入；failed：一行都没进。 */
  tone: 'success' | 'partial' | 'failed';
}

/** 行级错误里已有本地化文案的错误码；其余显示服务端消息。 */
export const ROW_ERROR_CODES = new Set([
  'duplicate_link',
  'validation_failed',
  'quota_exceeded',
  'row_failed',
  'chunk_failed',
]);

/**
 * 计数口径见服务端 BulkRollup（#629）：rowCount = added + reused + skipped，
 * skipped = errorCount = errors.length。所以 toast 里「已导入 / 未导入 / 总数」三者自洽。
 */
export function summarizeBulkOutcome(
  rollup: BulkRollupView | undefined,
  errors: readonly unknown[] | undefined,
  rowCount?: number,
): BulkOutcomeSummary {
  const imported = (rollup?.added ?? 0) + (rollup?.reused ?? 0);
  const failed = rollup?.errorCount ?? errors?.length ?? 0;
  const total = rowCount ?? imported + failed;
  if (failed === 0) return { imported, failed, total, tone: 'success' };
  return { imported, failed, total, tone: imported > 0 ? 'partial' : 'failed' };
}

/** 把服务端 errors 规范成可渲染的行（容忍字段缺失的历史数据），按行号排序。 */
export function normalizeRowErrors(errors: readonly unknown[] | undefined): BulkRowErrorView[] {
  return (errors ?? [])
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => ({
      row: typeof e.row === 'number' ? e.row : -1,
      code: typeof e.code === 'string' ? e.code : 'row_failed',
      message: typeof e.message === 'string' ? e.message : '',
    }))
    .sort((a, b) => a.row - b.row);
}
