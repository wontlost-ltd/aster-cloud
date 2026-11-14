'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Alert,
  Badge,
  Breadcrumbs,
  Button,
  Container,
  EmptyState,
  Label,
  PageHeader,
  Textarea,
} from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { trackProductEvent } from '@/lib/product-events/client';
import type { InboxItem } from '@/lib/approvals-inbox';
import type { PendingVersionApproval } from '@/lib/version-approvals-inbox';
import type { GuardApprovalInput, GuardApprovalStatus } from '@/services/policy/guard-types';
import { ApprovalInputPanel } from './approval-input-panel';

// 与服务端 GUARD_APPROVAL_STATUSES 同序；客户端组件不能引入 server-only 模块，故在此重列
const STATUSES: readonly GuardApprovalStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'];

type Verb = 'approve' | 'reject';

interface ApiErrorBody {
  error?: string;
  message?: string;
  verifiedRoles?: string[];
}

interface Props {
  locale: string;
  initialStatus: GuardApprovalStatus;
  initialItems: InboxItem[];
  initialUnavailable: string[];
  /** 待审批的策略版本（与 Action-Guard 审批分区展示，不随状态 tab 切换） */
  versionApprovals: PendingVersionApproval[];
  highlightDecisionId: string | null;
}

type T = ReturnType<typeof useTranslations>;

// 列表首屏由服务端渲染（运行时为 UTC），浏览器再按本地时区水合：toLocaleString 两端结果不同会触发
// hydration mismatch。固定按 UTC 格式化并标注时区，两端文本一致。
const CREATED_AT_FORMAT = { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' } as const;

function formatCreatedAt(iso: string, locale: string): string {
  return `${new Intl.DateTimeFormat(locale, CREATED_AT_FORMAT).format(new Date(iso))} UTC`;
}

function statusVariant(status: GuardApprovalStatus): 'success' | 'danger' | 'warning' | 'neutral' {
  if (status === 'APPROVED') return 'success';
  if (status === 'REJECTED') return 'danger';
  if (status === 'PENDING') return 'warning';
  return 'neutral';
}

/** api 错误码 → 本地化文案；未知码显示通用文案，不显示 api 原文（#711：原文可能是中文或内部细节）。 */
function errorText(t: T, body: ApiErrorBody, item: InboxItem): string {
  switch (body.error) {
    case 'role_mismatch':
      return t('errors.role_mismatch', {
        role: item.requiredRole ?? '',
        roles: body.verifiedRoles?.length ? body.verifiedRoles.join(', ') : t('noRoles'),
      });
    case 'segregation_of_duties':
      return t('errors.segregation_of_duties');
    case 'approval_not_pending':
      return t('errors.approval_not_pending');
    case 'input_snapshot_mismatch':
      return t('errors.input_snapshot_mismatch');
    case 'comment_required':
      return t('commentRequired');
    case 'forbidden':
      return t('errors.forbidden');
    case 'approval_not_found':
      return t('errors.approval_not_found');
    case 'receipt_unavailable':
      return t('errors.receipt_unavailable');
    case 'invalid_approval':
      return t('errors.invalid_approval');
    case 'user_required':
      return t('errors.user_required');
    case 'upstream_unavailable':
      return t('errors.upstream_unavailable');
    default:
      return t('errors.generic');
  }
}

function subjectOf(item: InboxItem): string {
  if (item.policyModule && item.policyFunction) return `${item.policyModule}.${item.policyFunction}`;
  return item.policyModule ?? item.decisionId;
}

function actionOf(item: InboxItem): string {
  const resource = [item.resourceType, item.resourceId].filter(Boolean).join(':');
  return [item.actionName, resource].filter(Boolean).join(' → ') || '—';
}

/**
 * 收件箱对某条审批已取得的输入视图：undefined = 未展开 / 加载中；null = 不可用（旧 api、网络错误）；
 * 其余为面板当前展示的视图（打码或本人解除后的视图）。
 */
type LoadedView = GuardApprovalInput | null | undefined;

function keyOf(item: InboxItem): string {
  return `${item.tenantId}:${item.id}`;
}

/**
 * 批准 / 拒绝要等输入视图加载出来（ADR 0042 §12 D10）：审批人先看过输入再下结论，提交时带上所见视图的哈希。
 * 视图不可用（null 或 status ≠ available）时直接可用、不带哈希。
 */
function RowActions({ item, view, t, onPick }: {
  item: InboxItem; view: LoadedView; t: T; onPick: (item: InboxItem, verb: Verb) => void;
}) {
  if (item.canAct) {
    const ready = view !== undefined;
    return (
      <div className="flex flex-col gap-1">
        <div className="flex gap-2">
          <Button size="sm" variant="primary" onClick={() => onPick(item, 'approve')} disabled={!ready}>
            {t('approve')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onPick(item, 'reject')} disabled={!ready}>
            {t('reject')}
          </Button>
        </div>
        {!ready && <span className="text-xs text-fg-muted">{t('input.reviewFirst')}</span>}
      </div>
    );
  }
  if (item.status === 'PENDING') {
    return (
      <Badge variant="neutral" title={t('readOnlyHint', { role: item.requiredRole ?? t('anyMember') })}>
        {t('readOnly')}
      </Badge>
    );
  }
  return (
    <div className="text-xs text-fg-muted">
      {item.decidedBy && <div>{t('decidedBy', { user: item.decidedBy })}</div>}
      {item.comment && <div className="mt-1 italic">{item.comment}</div>}
    </div>
  );
}

/** 提交审批时随附的快照哈希：只有可用视图才有。 */
function snapshotHashOf(view: LoadedView): string | undefined {
  return view && view.status === 'available' ? view.inputSnapshotHash : undefined;
}

function DecisionDialog({
  item,
  verb,
  inputSnapshotHash,
  t,
  onCancel,
  onDone,
  onStaleInput,
}: {
  item: InboxItem;
  verb: Verb;
  inputSnapshotHash: string | undefined;
  t: T;
  onCancel: () => void;
  onDone: () => void;
  /** 409 input_snapshot_mismatch：所见视图已过时，让输入面板重新拉取 */
  onStaleInput: () => void;
}) {
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    // 驳回必须给理由（ADR 0042 §5.2），本地先拦，api 侧同样校验
    if (verb === 'reject' && comment.trim() === '') {
      setError(t('commentRequired'));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const url = `/api/approvals/${encodeURIComponent(item.tenantId)}/${encodeURIComponent(item.id)}/${verb}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: comment.trim() || undefined, inputSnapshotHash }),
      });
      if (r.ok) return onDone();
      const body = (await r.json().catch(() => ({}))) as ApiErrorBody;
      setError(errorText(t, body, item));
      if (body.error === 'input_snapshot_mismatch') onStaleInput();
    } catch {
      // 网络异常（离线、连接被重置）：不暴露底层报错，给通用提示
      setError(t('errors.generic'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div role="dialog" aria-label={t(verb === 'approve' ? 'approveTitle' : 'rejectTitle')}
      className="mt-4 rounded-lg border border-border bg-bg-subtle p-4">
      <h3 className="text-sm font-semibold text-fg">
        {t(verb === 'approve' ? 'approveTitle' : 'rejectTitle')} · {subjectOf(item)}
      </h3>
      <div className="mt-3 flex flex-col gap-2">
        <Label htmlFor="approval-comment">{t(verb === 'approve' ? 'commentOptional' : 'commentLabel')}</Label>
        <Textarea id="approval-comment" value={comment} rows={3} placeholder={t('commentPlaceholder')}
          onChange={(e) => setComment(e.target.value)} />
      </div>
      {error && <Alert variant="danger" className="mt-3">{error}</Alert>}
      <div className="mt-3 flex gap-2">
        <Button variant={verb === 'approve' ? 'primary' : 'destructive'} onClick={submit} disabled={submitting}>
          {submitting ? t('submitting') : t(verb === 'approve' ? 'confirmApprove' : 'confirmReject')}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}

/**
 * 策略版本审批分区。只负责「找得到」：批准/驳回仍在版本页完成（approveVersion），这里不重复审批逻辑。
 * 作者本人的提交只读，标注等待他人审批（四眼原则）。
 */
function VersionApprovalsSection({ items, locale, t }: { items: PendingVersionApproval[]; locale: string; t: T }) {
  return (
    <section aria-labelledby="version-approvals-title" className="mb-8">
      <h2 id="version-approvals-title" className="text-lg font-semibold text-fg">{t('versions.title')}</h2>
      <p className="mt-1 mb-3 text-sm text-fg-muted">{t('versions.subtitle')}</p>
      {items.length === 0 ? (
        <p className="rounded-lg border border-border px-4 py-6 text-sm text-fg-muted">{t('versions.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase text-fg-muted">
                <th className="px-4 py-2 text-left">{t('thPolicy')}</th>
                <th className="px-4 py-2 text-left">{t('versions.thVersion')}</th>
                <th className="px-4 py-2 text-left">{t('versions.thSubmitter')}</th>
                <th className="px-4 py-2 text-left">{t('versions.thSubmitted')}</th>
                <th className="px-4 py-2 text-left">{t('thActions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.versionId} data-version-id={item.versionId} className="border-b border-border">
                  <td className="px-4 py-3 font-medium text-fg">{item.policyName}</td>
                  <td className="px-4 py-3">v{item.version}</td>
                  <td className="px-4 py-3">{item.submittedBy ?? t('versions.unknownUser')}</td>
                  <td className="px-4 py-3 text-fg-muted">{formatCreatedAt(item.submittedAt, locale)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {!item.canAct && !item.noEligibleReviewer && (
                        <Badge variant="neutral">{t('versions.awaitingOthers')}</Badge>
                      )}
                      {/* 团队里除作者外没有 owner/admin：四眼原则下无人能审批，引导去团队成员管理任命管理员 */}
                      {item.noEligibleReviewer && item.teamId && (
                        <Link href={`/teams/${item.teamId}/members`} data-testid="no-eligible-reviewer"
                          className="text-xs text-warning underline hover:text-warning/80">
                          {t('versions.noEligibleReviewer')}
                        </Link>
                      )}
                      <Link href={`/policies/${item.policyId}/versions`}
                        className="text-sm font-medium text-primary hover:text-primary-hover">
                        {t(item.canAct ? 'versions.review' : 'versions.view')} →
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function ApprovalsContent({
  locale, initialStatus, initialItems, initialUnavailable, versionApprovals, highlightDecisionId,
}: Props) {
  const t = useTranslations('approvals');
  const [status, setStatus] = useState<GuardApprovalStatus>(initialStatus);
  const [items, setItems] = useState<InboxItem[]>(initialItems);
  const [unavailable, setUnavailable] = useState<string[]>(initialUnavailable);
  const [loadError, setLoadError] = useState(false);
  const [picked, setPicked] = useState<{ item: InboxItem; verb: Verb } | null>(null);
  // 展开的行与各行已加载的输入视图（键为 tenantId:approvalId）；输入只在展开时拉取，不随列表首屏加载
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [views, setViews] = useState<Record<string, LoadedView>>({});
  // 每行输入面板的重载计数：作为面板 key 的一部分，递增即重新挂载并重新拉取
  const [reloads, setReloads] = useState<Record<string, number>>({});
  // 当前在途的列表请求：快速切换 tab 时中止旧请求，并丢弃晚到的旧响应
  const inflight = useRef<AbortController | null>(null);

  // 需求验证（B 线）：收件箱访问量是「人工审批」是否被使用的直接信号；每次挂载记一次，不带任何条目信息。
  useEffect(() => {
    trackProductEvent('approvals_inbox_viewed');
  }, []);

  // 从通知/日志页跳入时滚动到被定位的那一行
  useEffect(() => {
    if (!highlightDecisionId) return;
    const row = document.querySelector(`[data-decision-id="${CSS.escape(highlightDecisionId)}"]`);
    row?.scrollIntoView?.({ block: 'center' });
  }, [highlightDecisionId]);

  const load = async (next: GuardApprovalStatus) => {
    setStatus(next);
    setPicked(null);
    setExpanded({});
    setViews({});
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    try {
      const r = await fetch(`/api/approvals?status=${next}`, { signal: controller.signal });
      const body = r.ok ? ((await r.json()) as { items: InboxItem[]; unavailableTenants: string[] }) : null;
      if (controller.signal.aborted) return;
      setLoadError(!body);
      if (!body) return;
      setItems(body.items);
      setUnavailable(body.unavailableTenants);
    } catch {
      // 被新请求中止属预期；其余为网络异常，提示加载失败
      if (!controller.signal.aborted) setLoadError(true);
    }
  };

  return (
    <Container size="xl" className="py-6 sm:py-10">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        breadcrumbs={<Breadcrumbs items={[{ label: t('title') }]} />}
        className="mb-6"
      />

      <VersionApprovalsSection items={versionApprovals} locale={locale} t={t} />

      <h2 className="mb-3 text-lg font-semibold text-fg">{t('guardTitle')}</h2>
      <div role="tablist" className="mb-4 flex flex-wrap gap-2">
        {STATUSES.map((s) => (
          <Button key={s} role="tab" aria-selected={s === status} size="sm"
            variant={s === status ? 'primary' : 'secondary'} onClick={() => load(s)}>
            {t(`status.${s}`)}
          </Button>
        ))}
      </div>

      {unavailable.length > 0 && (
        <Alert variant="warning" className="mb-4">{t('unavailable', { count: unavailable.length })}</Alert>
      )}
      {loadError && <Alert variant="danger" className="mb-4">{t('loadFailed')}</Alert>}

      {items.length === 0 ? (
        <EmptyState title={t('empty')} description={t('emptyDesc')} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase text-fg-muted">
                <th className="px-4 py-2 text-left">{t('thPolicy')}</th>
                <th className="px-4 py-2 text-left">{t('thAction')}</th>
                <th className="px-4 py-2 text-left">{t('thRole')}</th>
                <th className="px-4 py-2 text-left">{t('thWorkspace')}</th>
                <th className="px-4 py-2 text-left">{t('thCreated')}</th>
                <th className="px-4 py-2 text-left">{t('thStatus')}</th>
                <th className="px-4 py-2 text-left">{t('thActions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const highlighted = item.decisionId === highlightDecisionId;
                const key = keyOf(item);
                const open = !!expanded[key];
                return (
                  <Fragment key={key}>
                  <tr data-decision-id={item.decisionId}
                    data-highlighted={highlighted ? 'true' : undefined}
                    className={`border-b border-border ${highlighted ? 'bg-primary/10 ring-2 ring-inset ring-primary' : ''}`}>
                    <td className="px-4 py-3">
                      <div className="font-medium text-fg">{subjectOf(item)}</div>
                      {item.reason && <div className="mt-1 text-xs text-fg-muted">{item.reason}</div>}
                      <button type="button" className="mt-1 text-xs text-primary underline" aria-expanded={open}
                        onClick={() => setExpanded((e) => ({ ...e, [key]: !open }))}>
                        {t(open ? 'input.toggleHide' : 'input.toggleShow')}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-fg-muted">{actionOf(item)}</td>
                    <td className="px-4 py-3">{item.requiredRole ?? t('anyMember')}</td>
                    <td className="px-4 py-3">{item.tenantName || t('personalTenant')}</td>
                    <td className="px-4 py-3 text-fg-muted">
                      {item.createdAt ? formatCreatedAt(item.createdAt, locale) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={statusVariant(item.status)}>{t(`status.${item.status}`)}</Badge>
                      {/* 签发方吊销导致的过期（ADR 0040 §11 D4）：只在收件箱标注原因，不另发通知（ADR 0046 §11.7 裁定 15） */}
                      {item.status === 'EXPIRED' && item.expiredReason === 'fact_issuer_revoked' && (
                        <div className="mt-1">
                          <Badge variant="danger">{t('expiredReason.fact_issuer_revoked')}</Badge>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <RowActions item={item} view={views[key]} t={t}
                        onPick={(it, verb) => setPicked({ item: it, verb })} />
                    </td>
                  </tr>
                  {open && (
                    <tr className="border-b border-border bg-bg-subtle" data-input-row={key}>
                      <td colSpan={7} className="px-4 py-3">
                        <ApprovalInputPanel key={reloads[key] ?? 0} tenantId={item.tenantId} approvalId={item.id}
                          canReveal={item.canAct && item.requiredRole != null}
                          onViewLoaded={(view) => setViews((v) => ({ ...v, [key]: view }))} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {picked && (
        <DecisionDialog key={`${picked.item.id}:${picked.verb}`} item={picked.item} verb={picked.verb}
          inputSnapshotHash={snapshotHashOf(views[keyOf(picked.item)])} t={t}
          onStaleInput={() => {
            const key = keyOf(picked.item);
            setViews((v) => ({ ...v, [key]: undefined }));
            setReloads((r) => ({ ...r, [key]: (r[key] ?? 0) + 1 }));
          }}
          onCancel={() => setPicked(null)} onDone={() => load(status)} />
      )}
    </Container>
  );
}
