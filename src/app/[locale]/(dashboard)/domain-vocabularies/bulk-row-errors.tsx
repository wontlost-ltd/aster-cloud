'use client';

import { useTranslations } from 'next-intl';
import { ROW_ERROR_CODES, type BulkRowErrorView } from './bulk-result';

const MAX_VISIBLE = 10;

type RowErrorKey = `rowErrors.${'duplicate_link' | 'validation_failed' | 'quota_exceeded' | 'row_failed' | 'chunk_failed'}`;

/**
 * 未导入行的清单（#607）：同步结果与异步任务完成卡共用。
 *
 * 行号按用户看到的预览表编号（从 1 开始）；服务端 row 为 0 基索引，-1 表示任务级错误。
 * 已知错误码显示本地化说明；校验失败额外附上服务端的具体原因，方便用户改数据。
 */
export function BulkRowErrors({ errors }: { errors: BulkRowErrorView[] }) {
  const t = useTranslations('domainVocabularies.bulk');
  if (errors.length === 0) return null;
  const visible = errors.slice(0, MAX_VISIBLE);
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-fg">{t('resultErrorsTitle')}</p>
      <ul className="max-h-48 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs text-fg-muted">
        {visible.map((err, i) => (
          <li key={`${err.row}-${i}`}>
            {err.row >= 0 ? `${t('rowLabel', { row: err.row + 1 })}: ` : null}
            {describe(err, t)}
          </li>
        ))}
        {errors.length > MAX_VISIBLE ? (
          <li>{t('moreErrors', { n: errors.length - MAX_VISIBLE })}</li>
        ) : null}
      </ul>
    </div>
  );
}

function describe(
  err: BulkRowErrorView,
  t: ReturnType<typeof useTranslations<'domainVocabularies.bulk'>>,
): string {
  if (!ROW_ERROR_CODES.has(err.code)) return err.message || err.code;
  const label = t(`rowErrors.${err.code}` as RowErrorKey);
  return err.code === 'validation_failed' && err.message ? `${label} (${err.message})` : label;
}
