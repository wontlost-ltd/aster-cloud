'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { vocabularyDiagnosticHelp, vocabularyPageHref } from '@/lib/vocabulary-diagnostic';

/**
 * 词汇解析诊断（E800–E806）下方的「在领域词汇中查看」链接：带出出问题的写法，并打开按该写法
 * 过滤的词汇页（ADR 0051 §1）。不是词汇诊断时不渲染。编辑器问题面板与侧栏决策页共用。
 */
export function VocabularyDiagnosticLink({
  code,
  message,
  data,
  className,
}: {
  code?: string;
  message?: string;
  data?: unknown;
  className?: string;
}) {
  const t = useTranslations('policies.form');
  const locale = useLocale();
  const help = vocabularyDiagnosticHelp({ code, message, data });
  if (!help) return null;
  return (
    <Link
      href={vocabularyPageHref(locale, help.written)}
      className={`inline-block text-xs font-medium text-primary underline hover:no-underline ${className ?? ''}`}
    >
      {t('openVocabularyTerm', { term: help.written })}
    </Link>
  );
}
