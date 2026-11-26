'use client';

/**
 * layout 错误码的本地化文案（ADR 0058 §7.5）：排版标签页的实时校验与保存失败共用。
 *
 * 校验码来自包的 `validatePolicyLayout` / 保存接口 400（含 ADR 0059 修订 5 L10 的 `layout_escape_delimiter_invalid` 与
 * `layout_hidden_escape_changes_program`），另加门禁的 `structured_authoring_required`（403）。
 * `offset` 是 canonical 源码里的 UTF-16 偏移，换算成 1 起始的行列附在文案后；`limit` 附上限名与上限值。
 */
import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { LAYOUT_LIMITS, type LayoutLimitName } from '@aster-cloud/aster-lang-ts/layout';
import type { LayoutSaveErrorCode } from '@/lib/policy-layout/errors';
import { positionAt } from '@/lib/policy-layout/edit-ops';

export const LAYOUT_SAVE_ERROR_CODES: readonly LayoutSaveErrorCode[] = [
  'layout_invalid_format',
  'layout_too_large',
  'layout_roundtrip_mismatch',
  'layout_structural_hides_value',
  'layout_content_parity',
  'layout_escape_delimiter_invalid',
  'layout_hidden_escape_changes_program',
  'structured_authoring_required',
];

export function isLayoutSaveErrorCode(code: unknown): code is LayoutSaveErrorCode {
  return typeof code === 'string' && (LAYOUT_SAVE_ERROR_CODES as readonly string[]).includes(code);
}

export interface LayoutErrorDetail {
  code: LayoutSaveErrorCode;
  offset?: number;
  limit?: string;
}

const isLimitName = (limit: unknown): limit is LayoutLimitName =>
  typeof limit === 'string' && Object.prototype.hasOwnProperty.call(LAYOUT_LIMITS, limit);

/** 返回 `(error, source) => 文案`；`source` 是错误偏移所指的 canonical 源码。 */
export function useLayoutErrorText(): (error: LayoutErrorDetail, source: string) => string {
  const t = useTranslations('policyEditor');
  return useCallback(
    (error, source) => {
      let message = t(`saveErrorCodes.${error.code}`);
      if (isLimitName(error.limit)) {
        message = t('saveErrorCodes.withLimit', {
          message,
          limit: t(`layoutTab.limits.${error.limit}`),
          max: LAYOUT_LIMITS[error.limit],
        });
      }
      const offset = error.offset;
      if (typeof offset === 'number' && Number.isInteger(offset) && offset >= 0 && offset <= source.length) {
        const { line, column } = positionAt(source, offset);
        message = t('saveErrorCodes.atPosition', { message, line, column });
      }
      return message;
    },
    [t],
  );
}
