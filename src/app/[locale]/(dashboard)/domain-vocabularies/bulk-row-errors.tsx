'use client';

import { useTranslations } from 'next-intl';
import {
  ROW_ERROR_CODES,
  SKIP_REASONS,
  skippedBreakdown,
  type BulkRowErrorView,
  type SkipReason,
} from './bulk-result';
import { useVocabularyErrors, type VocabularyErrorTexts } from './use-vocabulary-errors';

const MAX_VISIBLE = 10;

type BulkT = ReturnType<typeof useTranslations<'domainVocabularies.bulk'>>;

/** 非零的原因分组，按固定顺序本地化（「N 条已在你的词汇中」等）。 */
export function skippedReasonTexts(errors: readonly BulkRowErrorView[], skipped: number, t: BulkT): string[] {
  const counts = skippedBreakdown(errors, skipped);
  return SKIP_REASONS
    .filter((reason) => counts[reason] > 0)
    .map((reason) => t(`skippedReasons.${reason}` as `skippedReasons.${SkipReason}`, { n: counts[reason] }));
}

/** 未导入行按原因分组的计数（#636）：同步结果与异步任务完成卡共用；全部导入时不渲染。 */
export function BulkSkippedReasons({ errors, skipped }: { errors: BulkRowErrorView[]; skipped: number }) {
  const t = useTranslations('domainVocabularies.bulk');
  const texts = skippedReasonTexts(errors, skipped, t);
  if (texts.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-fg">{t('skippedReasons.title')}</p>
      <ul aria-label={t('skippedReasons.title')} className="list-disc space-y-0.5 pl-5 text-xs text-fg-muted">
        {texts.map((text) => <li key={text}>{text}</li>)}
      </ul>
    </div>
  );
}

type RowErrorKey = `rowErrors.${'duplicate_link' | 'validation_failed' | 'quota_exceeded' | 'row_failed' | 'chunk_failed'}`;

/**
 * 未导入行的清单（#607）：同步结果与异步任务完成卡共用。
 *
 * 行号按用户看到的预览表编号（从 1 开始）；服务端 row 为 0 基索引，-1 表示任务级错误。
 * 只按错误码显示本地化说明，不显示服务端原文（#634）；校验失败额外附上识别出的具体原因
 * （本地化后），方便用户改数据。未知错误码按「该行未能保存」处理。
 */
export function BulkRowErrors({ errors }: { errors: BulkRowErrorView[] }) {
  const t = useTranslations('domainVocabularies.bulk');
  const vocabularyErrors = useVocabularyErrors();
  if (errors.length === 0) return null;
  const visible = errors.slice(0, MAX_VISIBLE);
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-fg">{t('resultErrorsTitle')}</p>
      <ul className="max-h-48 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs text-fg-muted">
        {visible.map((err, i) => (
          <li key={`${err.row}-${i}`}>
            {err.row >= 0 ? `${t('rowLabel', { row: err.row + 1 })}: ` : null}
            {describe(err, t, vocabularyErrors)}
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
  t: BulkT,
  vocabularyErrors: VocabularyErrorTexts,
): string {
  const code = ROW_ERROR_CODES.has(err.code) ? err.code : 'row_failed';
  const label = t(`rowErrors.${code}` as RowErrorKey);
  const reason = code === 'validation_failed' ? vocabularyErrors.validationReason(err.message) : null;
  return reason ? `${label}: ${reason}` : label;
}
