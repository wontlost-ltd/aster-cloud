'use client';

/**
 * 孤儿行展开后的决策上下文（ADR 0061 §3.5）：展开时才请求 `GET …/decisions/[decisionId]`。
 *
 * 三个来源各自降级（BFF 已组装）：决策行、链收据、发起执行。决策 404 只说明「本工作区没有这条决策行」，
 * 按 kind 措辞：`orphan_receipt` = 链上有决策事件而无决策行；`side_effect_without_decision` = 上报方声称的
 * 决策 id 在本工作区不存在（不断言它在别处不存在）；其他 kind 出现 404 属异常，如实显示。
 * 决策与收据里的执行方 id 等文本同样按纯文本显示。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, Badge, Button } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import type { DecisionContext } from '@/lib/guard-reconciliation/decision-context';
import { formatUtc } from '@/lib/guard-reconciliation/ui';
import type { GuardDecision, GuardOrphanKind } from '@/services/policy/guard-types';
import { ReporterText } from './reporter-text';

type LoadState = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ok'; ctx: DecisionContext };

interface Props {
  tenantId: string;
  decisionId: string;
  orphanKind: GuardOrphanKind;
  locale: string;
}

async function fetchContext(tenantId: string, decisionId: string): Promise<DecisionContext | null> {
  try {
    const url = `/api/guard-reconciliation/${encodeURIComponent(tenantId)}/decisions/${encodeURIComponent(decisionId)}`;
    const res = await fetch(url, { cache: 'no-store' });
    return res.ok ? ((await res.json()) as DecisionContext) : null;
  } catch {
    return null;
  }
}

function notFoundKey(kind: GuardOrphanKind): 'notFound.orphan_receipt' | 'notFound.side_effect_without_decision' | 'notFound.other' {
  if (kind === 'orphan_receipt') return 'notFound.orphan_receipt';
  if (kind === 'side_effect_without_decision') return 'notFound.side_effect_without_decision';
  return 'notFound.other';
}

function policyAddress(d: GuardDecision): string | null {
  const p = d.executionReceipt?.payload;
  if (p?.policyModule && p.policyFunction) return `${p.policyModule}.${p.policyFunction}`;
  return p?.policyModule ?? null;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2 text-sm">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-fg">{children}</dd>
    </div>
  );
}

function DecisionPart({ ctx, orphanKind, locale }: { ctx: DecisionContext; orphanKind: GuardOrphanKind; locale: string }) {
  const t = useTranslations('guardReconciliation.decision');
  const part = ctx.decision;
  if (part.state === 'not_found') return <p className="text-sm text-fg-muted" data-testid="decision-not-found">{t(notFoundKey(orphanKind))}</p>;
  if (part.state === 'unavailable') return <p className="text-sm text-fg-muted" data-testid="decision-unavailable">{t('unavailable')}</p>;
  const d = part.value;
  const address = policyAddress(d);
  return (
    <dl className="space-y-1" data-testid="decision-ok">
      <Field label={t('outcome')}><Badge variant="neutral">{d.effectiveOutcome ?? d.outcome ?? '—'}</Badge></Field>
      {d.reasonCode && <Field label={t('reasonCode')}><code className="text-xs">{d.reasonCode}</code></Field>}
      {address && <Field label={t('policy')}><code className="text-xs">{address}</code></Field>}
      <Field label={t('consumedBy')}>
        {d.consumedBy ? (
          <>
            {formatUtc(d.consumedBy.consumedAt, locale)}
            {d.consumedBy.executorId && <> · <ReporterText value={d.consumedBy.executorId} /></>}
          </>
        ) : t('notConsumed')}
      </Field>
      <Field label={t('result')}>
        {d.result ? `${d.result.status} · ${formatUtc(d.result.resultAt, locale)}` : t('noResult')}
      </Field>
    </dl>
  );
}

function ChainPart({ ctx, locale }: { ctx: DecisionContext; locale: string }) {
  const t = useTranslations('guardReconciliation.decision');
  const part = ctx.chain;
  if (part.state === 'not_found') return <p className="text-sm text-fg-muted" data-testid="chain-not-found">{t('chainNotFound')}</p>;
  if (part.state === 'unavailable') return <p className="text-sm text-fg-muted" data-testid="chain-unavailable">{t('chainUnavailable')}</p>;
  const c = part.value;
  return (
    <dl className="space-y-1" data-testid="chain-ok">
      <Field label={t('chainDecision')}>
        {c.decision ? `${c.decision.eventType} · #${c.decision.auditId} · ${formatUtc(c.decision.timestamp, locale)}` : t('chainNoDecision')}
      </Field>
      <Field label={t('chainConsumes')}>{c.consumes.length}</Field>
      <Field label={t('chainResults')}>{c.results.length}</Field>
      <Field label={t('chainApprovals')}>{c.approvals.length}</Field>
    </dl>
  );
}

export function DecisionContextPanel({ tenantId, decisionId, orphanKind, locale }: Props) {
  const t = useTranslations('guardReconciliation.decision');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchContext(tenantId, decisionId).then((ctx) => {
      if (!cancelled) setState(ctx ? { kind: 'ok', ctx } : { kind: 'failed' });
    });
    return () => {
      cancelled = true;
    };
  }, [tenantId, decisionId]);

  const retry = useCallback(async () => {
    setState({ kind: 'loading' });
    const ctx = await fetchContext(tenantId, decisionId);
    setState(ctx ? { kind: 'ok', ctx } : { kind: 'failed' });
  }, [tenantId, decisionId]);

  const partUnavailable = state.kind === 'ok' && (state.ctx.decision.state === 'unavailable' || state.ctx.chain.state === 'unavailable');

  return (
    <section className="mt-3 rounded-md border border-border p-3" data-testid="decision-context">
      <h4 className="text-sm font-semibold text-fg">{t('title')}</h4>
      <p className="mb-2 font-mono text-xs text-fg-muted">{decisionId}</p>
      {state.kind === 'loading' && <div className="h-5 w-40 animate-pulse rounded bg-bg-muted" />}
      {state.kind === 'failed' && (
        <Alert variant="danger" data-testid="decision-context-failed">
          {t('loadFailed')}{' '}
          <Button size="sm" variant="secondary" onClick={retry}>{t('retry')}</Button>
        </Alert>
      )}
      {state.kind === 'ok' && (
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <h5 className="mb-1 text-xs font-semibold uppercase text-fg-muted">{t('decisionRow')}</h5>
            <DecisionPart ctx={state.ctx} orphanKind={orphanKind} locale={locale} />
          </div>
          <div>
            <h5 className="mb-1 text-xs font-semibold uppercase text-fg-muted">{t('chainTitle')}</h5>
            <ChainPart ctx={state.ctx} locale={locale} />
          </div>
          {(state.ctx.execution || state.ctx.approvalLink || partUnavailable) && (
            <div className="flex flex-wrap items-center gap-3 md:col-span-2">
              {state.ctx.execution && (
                <Link href={`/policies/${encodeURIComponent(state.ctx.execution.policyId)}/logs`}
                  className="text-sm font-medium text-primary hover:text-primary-hover" data-testid="execution-link">
                  {t('executionLink')} →
                </Link>
              )}
              {state.ctx.approvalLink && (
                <Link href={`/approvals?status=${state.ctx.approvalLink.status}&decisionId=${encodeURIComponent(decisionId)}`}
                  className="text-sm font-medium text-primary hover:text-primary-hover" data-testid="approval-link">
                  {t('approvalLink')} →
                </Link>
              )}
              {partUnavailable && <Button size="sm" variant="secondary" onClick={retry}>{t('retry')}</Button>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
