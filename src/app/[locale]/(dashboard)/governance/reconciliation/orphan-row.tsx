'use client';

/**
 * 孤儿列表的一行（ADR 0061 §3.6 / §3.7）：severity、kind、检出时间（UTC）、执行方、状态；展开后显示 kind 说明、
 * detail 键值（上报方文本，纯文本、长值折叠）、执行方 id、确认 / 解除信息与决策上下文（展开时才请求）。
 * 可确认（canAck 且 OPEN）时行内给「确认」，打开 AckDialog；结果交给列表处理。
 */
import { Fragment, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, Badge, Button } from '@/components/ui';
import { isOrphanKind } from '@/lib/guard-reconciliation/kinds';
import { formatUtc, type OrphanItem } from '@/lib/guard-reconciliation/ui';
import type { GuardOrphanSeverity, GuardOrphanStatus } from '@/services/policy/guard-types';
import { AckDialog, type AckResult } from './ack-dialog';
import { DecisionContextPanel } from './decision-context-panel';
import { ReporterText } from './reporter-text';

/** 有本地化字段名的 detail 键（aster-api GuardOrphanDetector）；其余键按原样显示。 */
const DETAIL_FIELDS = new Set([
  'effectId', 'source', 'actionName', 'resourceType', 'resourceId', 'occurredAt', 'decisionId', 'attemptId',
  'actionHash', 'reason', 'executorId', 'consumedAt', 'expiresAt', 'outcome', 'approvalStatus',
]);

export const ORPHAN_COLUMNS = 6;

export function severityVariant(severity: GuardOrphanSeverity): 'danger' | 'warning' | 'neutral' {
  if (severity === 'critical') return 'danger';
  if (severity === 'warning') return 'warning';
  return 'neutral';
}

function statusVariant(status: GuardOrphanStatus): 'warning' | 'success' | 'neutral' {
  if (status === 'OPEN') return 'warning';
  if (status === 'ACKNOWLEDGED') return 'success';
  return 'neutral';
}

interface Props {
  orphan: OrphanItem;
  tenantId: string;
  canAck: boolean;
  locale: string;
  onAckResult: (orphanId: number, result: AckResult) => void;
}

function AckInfo({ orphan, locale }: { orphan: OrphanItem; locale: string }) {
  const t = useTranslations('guardReconciliation');
  if (!orphan.acknowledgedBy && !orphan.ackComment && !orphan.resolvedAt) return null;
  const user = orphan.acknowledgedByUser;
  const userLabel = user?.name || user?.email;
  return (
    <dl className="mt-3 space-y-1 text-sm" data-testid="ack-info">
      {orphan.acknowledgedBy && (
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-fg-muted">{t('acknowledgedBy')}</dt>
          <dd>{userLabel ?? t('unknownUser')}{user?.name && user.email && <span className="ml-1 text-xs text-fg-muted">{user.email}</span>}</dd>
        </div>
      )}
      {orphan.ackComment && (
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-fg-muted">{t('ackComment')}</dt>
          <dd className="min-w-0"><ReporterText value={orphan.ackComment} /></dd>
        </div>
      )}
      {orphan.resolvedAt && (
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-fg-muted">{t('resolvedAt')}</dt>
          <dd>
            {formatUtc(orphan.resolvedAt, locale)}
            {orphan.resolution && <> · {t(`resolution.${orphan.resolution}`)}</>}
          </dd>
        </div>
      )}
    </dl>
  );
}

function OrphanDetails({ orphan, tenantId, locale }: { orphan: OrphanItem; tenantId: string; locale: string }) {
  const t = useTranslations('guardReconciliation');
  const entries = Object.entries(orphan.detail ?? {});
  return (
    <div data-testid={`orphan-details-${orphan.id}`}>
      {isOrphanKind(orphan.kind) && <p className="text-sm text-fg-muted">{t(`kinds.${orphan.kind}.description`)}</p>}
      <h4 className="mt-3 text-xs font-semibold uppercase text-fg-muted">{t('detailTitle')}</h4>
      <table className="mt-1 w-full text-sm">
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key} className="border-b border-border last:border-b-0 align-top">
              <th scope="row" className="w-48 py-1 pr-3 text-left font-normal text-fg-muted">
                {DETAIL_FIELDS.has(key) ? t(`detailFields.${key}`) : key}
              </th>
              <td className="py-1 font-mono text-xs"><ReporterText value={value} /></td>
            </tr>
          ))}
          {orphan.executorId && (
            <tr className="align-top">
              <th scope="row" className="w-48 py-1 pr-3 text-left font-normal text-fg-muted">{t('detailFields.executorId')}</th>
              <td className="py-1 font-mono text-xs"><ReporterText value={orphan.executorId} /></td>
            </tr>
          )}
        </tbody>
      </table>
      <AckInfo orphan={orphan} locale={locale} />
      {orphan.decisionId ? (
        <DecisionContextPanel tenantId={tenantId} decisionId={orphan.decisionId} orphanKind={orphan.kind} locale={locale} />
      ) : (
        <p className="mt-3 text-sm text-fg-muted" data-testid="no-decision-id">{t('decision.noDecisionId')}</p>
      )}
    </div>
  );
}

export function OrphanRow({ orphan, tenantId, canAck, locale, onAckResult }: Props) {
  const t = useTranslations('guardReconciliation');
  const [open, setOpen] = useState(false);
  const [acking, setAcking] = useState(false);
  const [notOpenStatus, setNotOpenStatus] = useState<GuardOrphanStatus | null>(null);
  const ackable = canAck && orphan.status === 'OPEN';

  const done = (result: AckResult) => {
    setAcking(false);
    if (result.kind === 'not_open') setNotOpenStatus(result.status);
    onAckResult(orphan.id, result);
  };

  return (
    <Fragment>
      <tr className="border-b border-border" data-testid={`orphan-${orphan.id}`}>
        <td className="px-4 py-3">
          <Badge variant={severityVariant(orphan.severity)}>{t(`severity.${orphan.severity}`)}</Badge>
        </td>
        <td className="px-4 py-3 font-medium text-fg">
          {isOrphanKind(orphan.kind) ? t(`kinds.${orphan.kind}.name`) : orphan.kind}
          <div className="text-xs font-normal text-fg-muted"><code>{orphan.kind}</code></div>
        </td>
        <td className="px-4 py-3 text-fg-muted">{formatUtc(orphan.detectedAt, locale)}</td>
        <td className="px-4 py-3"><ReporterText value={orphan.executor} /></td>
        <td className="px-4 py-3">
          <Badge variant={statusVariant(orphan.status)}>{t(`status.${orphan.status}`)}</Badge>
        </td>
        <td className="px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="text-xs text-primary underline" aria-expanded={open}
              onClick={() => setOpen((o) => !o)}>
              {t(open ? 'collapse' : 'expand')}
            </button>
            {ackable && !acking && (
              <Button size="sm" variant="secondary" onClick={() => { setOpen(true); setAcking(true); }}>
                {t('ack.button')}
              </Button>
            )}
          </div>
        </td>
      </tr>
      {(open || notOpenStatus) && (
        <tr className="border-b border-border bg-bg-subtle" data-testid={`orphan-expanded-${orphan.id}`}>
          <td colSpan={ORPHAN_COLUMNS} className="px-4 py-3">
            {notOpenStatus && (
              <Alert variant="info" className="mb-3" data-testid="ack-not-open">
                {t('ack.notOpen', { status: t(`status.${notOpenStatus}`) })}
              </Alert>
            )}
            {acking && ackable && (
              <div className="mb-3">
                <AckDialog tenantId={tenantId} orphan={orphan} onDone={done} onCancel={() => setAcking(false)} />
              </div>
            )}
            {open && <OrphanDetails orphan={orphan} tenantId={tenantId} locale={locale} />}
          </td>
        </tr>
      )}
    </Fragment>
  );
}
