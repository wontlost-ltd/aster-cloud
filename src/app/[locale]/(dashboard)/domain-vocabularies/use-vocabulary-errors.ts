'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  vocabularyValidationReasonText,
  vocabularyValidationText,
  type VocabularyValidationTranslate,
} from '@/lib/vocabulary-validation-message';
import { KNOWN_ERROR_CODES } from './constants';

type ErrorKey = `errors.${
  | 'quota_exceeded'
  | 'duplicate_link'
  | 'validation_failed'
  | 'not_found'
  | 'plan_gate_required'
  | 'internal_error'}`;

export interface VocabularyErrorTexts {
  /** validation_failed 的文案：具体原因，识别不了时为通用提示。 */
  validation: (message: string | undefined | null) => string;
  /** validation_failed 的具体原因；识别不了时 null（调用方只显示错误类别）。 */
  validationReason: (message: string | undefined | null) => string | null;
  /** 错误信封（code + message）→ 界面文案；未知错误码显示 fallback，从不显示服务端原文。 */
  envelope: (code: string | undefined, message: string | undefined, fallback: string) => string;
}

/**
 * 词汇页所有错误提示的唯一出口（#634）：服务端 message 可能是引擎中文诊断或英文内部说明，
 * 一律按错误码 + 识别出的原因码本地化，不直接展示原文。
 */
export function useVocabularyErrors(): VocabularyErrorTexts {
  const t = useTranslations('domainVocabularies');
  return useMemo(() => {
    const translate = t as unknown as VocabularyValidationTranslate;
    const validation = (message: string | undefined | null) => vocabularyValidationText(message, translate);
    return {
      validation,
      validationReason: (message) => vocabularyValidationReasonText(message, translate),
      envelope: (code, message, fallback) => {
        if (code === 'validation_failed') return validation(message);
        if (code && KNOWN_ERROR_CODES.has(code)) return t(`errors.${code}` as ErrorKey);
        return fallback;
      },
    };
  }, [t]);
}
