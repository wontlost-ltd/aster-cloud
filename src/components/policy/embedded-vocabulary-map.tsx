'use client';

/**
 * 版本详情（审批视图）里的「策略自带词汇」映射表（ADR 0060 §7.5）：写法 → 规范名 / 展开值，字面量行加标记。
 *
 * 词条是这个版本的编译输入（执行时并入有效词汇、优先于团队与作者词汇），审批者必须看到每个写法实际代表什么。
 * 输入是版本行上存的规范序列化文本：NULL / 缺省不渲染任何东西（无内嵌词汇的版本 DOM 与引入前一致）；
 * 文本无法按规范解析时显示「无法读取、该版本不会执行」——与执行路径的 fail-closed 一致，不静默隐藏。
 */
import { useId, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { parseStoredEmbeddedVocabulary, type EmbeddedVocabulary } from '@/lib/policy-embedded-vocabulary';

/** 已存文本 → 词条；null 为无词条，'unreadable' 为损坏文本。 */
export function readStoredEmbeddedTerms(text: string | null | undefined): EmbeddedVocabulary | null | 'unreadable' {
  try {
    return parseStoredEmbeddedVocabulary(text);
  } catch {
    return 'unreadable';
  }
}

export function EmbeddedVocabularyMap({ embeddedVocabularyJson }: { embeddedVocabularyJson: string | null | undefined }) {
  const t = useTranslations('policyEditor.embeddedTerms');
  const titleId = useId();
  const stored = useMemo(() => readStoredEmbeddedTerms(embeddedVocabularyJson), [embeddedVocabularyJson]);
  if (stored === null) return null;

  return (
    <div
      role="region"
      aria-labelledby={titleId}
      data-testid="embedded-vocabulary-map"
      className="overflow-hidden rounded-lg border border-border dark:border-gray-700"
    >
      <div id={titleId} className="bg-bg-subtle px-3 py-2 text-sm font-medium text-fg dark:bg-gray-900 dark:text-gray-200">
        {t('mapTitle')}
      </div>
      {stored === 'unreadable' ? (
        <p role="alert" className="px-3 py-2 text-xs text-danger">{t('mapUnreadable')}</p>
      ) : (
        <>
          <p className="border-b border-border px-3 py-2 text-xs text-fg-muted dark:border-gray-700">{t('mapNote')}</p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-fg-muted dark:border-gray-700 dark:text-fg-subtle">
                <th scope="col" className="px-3 py-2 font-medium">{t('colWritten')}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('colMeaning')}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('colKind')}</th>
              </tr>
            </thead>
            <tbody>
              {stored.terms.map((term) => {
                const isLiteral = term.kind === 'literal';
                return (
                  <tr
                    key={`${term.kind}/${term.parent ?? ''}/${term.localized}`}
                    data-testid="embedded-vocabulary-row"
                    className={`border-b border-border last:border-0 dark:border-gray-700 ${isLiteral ? 'bg-sky-50/60 dark:bg-sky-950/20' : ''}`}
                  >
                    <th scope="row" className="px-3 py-2 text-left font-mono font-normal text-fg dark:text-gray-200">
                      {term.localized}
                    </th>
                    <td className="px-3 py-2 font-mono text-fg dark:text-gray-100">
                      {isLiteral ? `"${term.canonical}"` : `${term.parent ? `${term.parent}.` : ''}${term.canonical}`}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {isLiteral ? (
                        <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-900 dark:bg-sky-900/60 dark:text-sky-100">
                          {t('kind_literal')} · {t('expandsTo')}
                        </span>
                      ) : (
                        <span className="text-fg-muted">{t(`kind_${term.kind}`)}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
