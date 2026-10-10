'use client';

// 法规对照表（ADR 0045 §5）：只呈现证据包内注册表驱动的对照结果，不做任何判定。
import { Badge } from '@/components/ui';
import { localizedTitle } from '@/services/evidence/control-registry';
import type { ClauseStatus, FrameworkMapping, RegulatoryMapping } from '@/services/evidence/regulatory-mapping';
import type { ProfileUsed } from '@/services/evidence/types';

/** 对照接口返回的视图：v5 证据包另附所用治理档案（ADR 0046 §6），v4 无此字段。 */
export type RegulatoryMappingView = RegulatoryMapping & { profilesUsed?: ProfileUsed[] };

export interface RegulatoryMappingLabels {
  profiles: string;
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

function FrameworkTable({ framework, locale, labels }: {
  framework: FrameworkMapping; locale: string; labels: RegulatoryMappingLabels;
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
            <td className="px-2 py-1">{localizedTitle(c.title, locale)}</td>
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

// 证据包所用治理档案；无档案（含 v4 包）时不占位
function ProfilesLine({ profiles, locale, label }: { profiles: ProfileUsed[]; locale: string; label: string }) {
  if (profiles.length === 0) return null;
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm" data-testid="profiles-used">
      <span className="text-fg-muted">{label}</span>
      {profiles.map((p) => <Badge key={p.id} variant="neutral">{localizedTitle(p.title, locale)}</Badge>)}
    </p>
  );
}

export function RegulatoryMappingTable({ mapping, locale, labels }: {
  mapping: RegulatoryMappingView | null; locale: string; labels: RegulatoryMappingLabels;
}) {
  if (!mapping) return <p className="text-sm text-fg-muted">{labels.notAvailable}</p>;
  return (
    <div className="space-y-4">
      <ProfilesLine profiles={mapping.profilesUsed ?? []} locale={locale} label={labels.profiles} />
      <p className="text-xs text-fg-muted">
        <span>{labels.registryVersion.replace('{version}', mapping.registryVersion)}</span> · {labels.disclaimer}
      </p>
      {mapping.frameworks.length === 0 ? (
        <p className="text-sm text-fg-muted">{labels.noFrameworks}</p>
      ) : (
        mapping.frameworks.map((f) => <FrameworkTable key={f.control} framework={f} locale={locale} labels={labels} />)
      )}
    </div>
  );
}

// 报告页单行对照的取数状态：'loading'=请求中，'error'=请求失败（可重试），null=接口如实返回无对照
export type MappingState = RegulatoryMappingView | null | 'loading' | 'error';

export interface RegulatoryMappingPanelLabels extends RegulatoryMappingLabels {
  loading: string;
  loadFailed: string;
}

// 失败与「不含对照」分开呈现：前者是取数问题，不能说成证据包本身没有对照
export function RegulatoryMappingPanel({ state, locale, labels }: {
  state: MappingState; locale: string; labels: RegulatoryMappingPanelLabels;
}) {
  if (state === 'loading') return <p className="text-sm text-fg-muted">{labels.loading}</p>;
  if (state === 'error') return <p className="text-sm text-danger">{labels.loadFailed}</p>;
  return <RegulatoryMappingTable mapping={state} locale={locale} labels={labels} />;
}
