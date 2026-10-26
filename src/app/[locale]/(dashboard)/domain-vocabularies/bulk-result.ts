/**
 * 批量导入结果的纯逻辑（#607/#629/#636）：同步响应与异步任务共用。
 *
 * 成功行数只能取服务端的 rollup（added + reused），不能拿提交的行数代替——
 * 重复、校验失败、超配额的行都会被跳过。字段口径见服务端 BulkRollup：
 *   - added：新建全局词条并链接到你的词汇；
 *   - reused：全局词条已存在（别人建过），为你新建链接——仍是「新导入」的行；
 *   - skipped：未导入，按行级错误码分原因（见 {@link skippedBreakdown}）：
 *     「已在你的词汇中」（duplicate_link）、无效（validation_failed）、超配额、保存失败。
 * 用户直觉上的「已存在」对应 skipped 里的 duplicate_link，不是 reused，界面按原因分组展示。
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

/** 行级错误里已有本地化文案的错误码；其余按 row_failed 显示（不显示服务端原文）。 */
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

/** 未导入的原因分组（#636）。顺序即界面展示顺序。 */
export const SKIP_REASONS = ['existing', 'invalid', 'quota', 'failed'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

const SKIP_REASON_BY_CODE: Readonly<Record<string, SkipReason>> = {
  duplicate_link: 'existing',
  validation_failed: 'invalid',
  quota_exceeded: 'quota',
};

/**
 * 按原因统计未导入的行：duplicate_link → 已在你的词汇中，validation_failed → 无效，
 * quota_exceeded → 超配额，其余（行/块写入失败、未知码）→ 保存失败。
 * 服务端保证 skipped = errors.length；历史数据若 errors 偏少，差额计入「保存失败」，
 * 使各组之和恒等于 skipped。
 */
export function skippedBreakdown(
  errors: readonly BulkRowErrorView[],
  skipped: number,
): Record<SkipReason, number> {
  const counts: Record<SkipReason, number> = { existing: 0, invalid: 0, quota: 0, failed: 0 };
  for (const err of errors) counts[SKIP_REASON_BY_CODE[err.code] ?? 'failed'] += 1;
  counts.failed += Math.max(0, skipped - errors.length);
  return counts;
}
