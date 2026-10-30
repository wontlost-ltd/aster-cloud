/**
 * aster-api 错误提示的英文口径（#680）。
 *
 * aster-api 的部分错误 message 与 What-If 窗口标签是中文硬编码，经 cloud 薄转发后英文 / 德文 /
 * 印地文用户在接口与界面上都看到中文。cloud 的约定是：接口 message 用英文，界面按错误码本地化。
 * 所以转发时按稳定错误码换成英文；未登记的错误码原样透传 message。
 */

const UPSTREAM_MESSAGES: Readonly<Record<string, string>> = {
  whatif_not_entitled: 'What-If impact estimates require a Pro or higher plan.',
  whatif_batch_in_progress: 'A What-If batch is already running. Start another one when it finishes.',
  segregation_of_duties: 'The requester or submitter of an action cannot approve it.',
  approval_not_pending: 'This approval has already been decided.',
};

/** 已登记错误码返回英文提示，否则返回上游原文。 */
export function upstreamErrorMessage(code: string | undefined, upstreamMessage: string): string {
  return (code && UPSTREAM_MESSAGES[code]) || upstreamMessage;
}

const WINDOW_LABELS: Readonly<Record<string, string>> = {
  LAST_MONTH: 'Last month',
  LAST_QUARTER: 'Last quarter',
  LAST_HALF_YEAR: 'Last 6 months',
  LAST_YEAR: 'Last year',
  CUSTOM: 'Custom range',
};

/** What-If 批次的 windowLabel 按 windowKind 换成英文；界面另按 windowKind 本地化。 */
export function withEnglishWindowLabel<T>(batch: T): T {
  if (!batch || typeof batch !== 'object') return batch;
  const kind = (batch as { windowKind?: unknown }).windowKind;
  const label = typeof kind === 'string' ? WINDOW_LABELS[kind] : undefined;
  return label ? { ...batch, windowLabel: label } : batch;
}
