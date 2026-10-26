'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import type { AliasIssue } from '@/lib/policy-alias-shared';
import { ALL_ALIAS_KINDS } from './policy-alias-types';

/**
 * 别名校验问题 → 当前界面语言的提示文案。
 *
 * 校验核心（policy-alias-shared）只产出稳定 code + 参数，文案统一在
 * `policies.form.aliases.errors.*` 下按语言维护，避免中文诊断原文出现在其它语言界面。
 */
export function useAliasIssueMessage(): (issue: AliasIssue) => string {
  const t = useTranslations('policies.form.aliases');

  const kindLabel = useCallback(
    (kind: string | undefined): string => {
      const meta = ALL_ALIAS_KINDS.find((m) => m.kind === kind);
      return meta ? t(`kinds.${meta.labelKey}`) : (kind ?? '');
    },
    [t],
  );

  return useCallback(
    (issue: AliasIssue): string => {
      const values = {
        kind: kindLabel(issue.kind),
        otherKind: kindLabel(issue.otherKind),
        alias: issue.alias ?? '',
        normalized: issue.normalized ?? '',
        count: issue.count ?? 0,
        limit: issue.limit ?? 0,
      };
      switch (issue.code) {
        case 'tooManyKinds': return t('errors.tooManyKinds', values);
        case 'kindNotAllowed': return t('errors.kindNotAllowed', values);
        case 'structuralNotGranted': return t('errors.structuralNotGranted', values);
        case 'tooManyAliases': return t('errors.tooManyAliases', values);
        case 'empty': return t('errors.empty', values);
        case 'tooLong': return t('errors.tooLong', values);
        case 'nonCanonical': return t('errors.nonCanonical', values);
        case 'singleWord': return t('errors.singleWord', values);
        case 'shadowsKeyword': return t('errors.shadowsKeyword', values);
        case 'shadowsBaseAlias': return t('errors.shadowsBaseAlias', values);
        case 'collidesVocabulary': return t('errors.collidesVocabulary', values);
        case 'duplicate': return t('errors.duplicate', values);
      }
    },
    [t, kindLabel],
  );
}
