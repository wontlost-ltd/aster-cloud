'use client';

// 法规对照表（ADR 0045 §5）：只呈现证据包内注册表驱动的对照结果，不做任何判定。
import { Badge } from '@/components/ui';
import type { ClauseStatus, FrameworkMapping, RegulatoryMapping } from '@/services/evidence/regulatory-mapping';

export interface RegulatoryMappingLabels {
  notAvailable: string;
  noFrameworks: string;
  registryVersion: string;
  disclaimer: string;
  columns: { clause: string; title: string; status: string; evidence: string };
  status: Record<ClauseStatus, string>;
}

const BADGE: Record<ClauseStatus, 'success' | 'warning' | 'neutral'> = {
  evidenced: 'success', partial: 'warning', none: 'neutral',
};

type TitleLocale = 'en' | 'zh' | 'de';
// 条款标题只有 en/zh/de 三语，其余 locale（如 hi）回退英文
const titleLocale = (locale: string): TitleLocale => (locale === 'zh' || locale === 'de' ? locale : 'en');

function FrameworkTable({ framework, lang, labels }: {
  framework: FrameworkMapping; lang: TitleLocale; labels: RegulatoryMappingLabels;
}) {
  return (
    <table className="w-full text-sm">
      <caption className="text-left font-medium">{framework.control}</caption>
      <thead>
        <tr>
          <th className="px-2 py-1 text-left">{labels.columns.clause}</th>
          <th className="px-2 py-1 text-left">{labels.columns.title}</th>
          <th className="px-2 py-1 text-left">{labels.columns.status}</th>
          <th className="px-2 py-1 text-left">{labels.columns.evidence}</th>
        </tr>
      </thead>
      <tbody>
        {framework.clauses.map((c) => (
          <tr key={c.clause} className="border-b border-border" data-testid={`clause-row-${c.clause}`}>
            <td className="px-2 py-1">{c.clause}</td>
            <td className="px-2 py-1">{c.title[lang]}</td>
            <td className="px-2 py-1"><Badge variant={BADGE[c.status]}>{labels.status[c.status]}</Badge></td>
            <td className="px-2 py-1">
              <details>
                <summary data-testid={`evidence-count-${c.clause}`}>{c.evidence.length}</summary>
                <ul>{c.evidence.map((r) => <li key={`${r.executionId}:${r.field}`}>{r.executionId} · {r.field}</li>)}</ul>
              </details>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RegulatoryMappingTable({ mapping, locale, labels }: {
  mapping: RegulatoryMapping | null; locale: string; labels: RegulatoryMappingLabels;
}) {
  if (!mapping) return <p className="text-sm text-fg-muted">{labels.notAvailable}</p>;
  const lang = titleLocale(locale);
  return (
    <div className="space-y-4">
      <p className="text-xs text-fg-muted">
        <span>{labels.registryVersion.replace('{version}', mapping.registryVersion)}</span> · {labels.disclaimer}
      </p>
      {mapping.frameworks.length === 0 ? (
        <p className="text-sm text-fg-muted">{labels.noFrameworks}</p>
      ) : (
        mapping.frameworks.map((f) => <FrameworkTable key={f.control} framework={f} lang={lang} labels={labels} />)
      )}
    </div>
  );
}
