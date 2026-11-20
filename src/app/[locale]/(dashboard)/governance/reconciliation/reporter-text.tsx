'use client';

/**
 * 上报方可控文本的唯一渲染方式（ADR 0061 §3.6）：`detail.*`、`executor`、`executorId` 等由本租户任一 MEMBER key
 * 上报，只能作 React 文本节点——不转链接、不进 dangerouslySetInnerHTML、不进属性。非字符串值按 JSON 显示。
 * 超过 256 字符折叠显示，可展开 / 收起。
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';

export const REPORTER_TEXT_LIMIT = 256;

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function ReporterText({ value }: { value: unknown }) {
  const t = useTranslations('guardReconciliation');
  const [expanded, setExpanded] = useState(false);
  const text = textOf(value);
  const long = text.length > REPORTER_TEXT_LIMIT;
  const shown = long && !expanded ? `${text.slice(0, REPORTER_TEXT_LIMIT)}…` : text;
  return (
    <span className="whitespace-pre-wrap break-all">
      {shown}
      {long && (
        <button type="button" className="ml-1 text-xs text-primary underline" aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}>
          {t(expanded ? 'showLess' : 'showAll')}
        </button>
      )}
    </span>
  );
}
