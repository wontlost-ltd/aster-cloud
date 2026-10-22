'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Breadcrumbs,
  Button,
  ConfirmDialog,
  Container,
  DataTable,
  EmptyState,
  PageHeader,
  Badge,
  Dropdown,
  DropdownItem,
  IconButton,
  Stack,
  Textarea,
  toast,
} from '@/components/ui';
import { GitBranch, MoreVertical } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useApi } from '@/lib/api';
import {
  decideVersionApproval,
  lacksEligibleReviewer,
  type VersionReviewContext,
} from '@/services/policy/version-approval-rules';

/**
 * Version management + approval workflow UI.
 *
 * Backend surfaces a complete 4-eye approval state machine via
 * /api/v1/policies/[id]/versions/[version]/{submit, approve, reject,
 * archive, deprecate, set-default}. This page is the dashboard's
 * single touch-point for that workflow:
 *
 *   - Table of versions with status badges, isDefault tag, author,
 *     and an action menu per row.
 *   - Action handlers run via useMutation, then revalidate the SWR
 *     cache so the table reflects the new state without reload.
 *   - SOX guard responses from /approve (segregation_of_duties,
 *     invite_reviewer_required) surface as targeted toasts so
 *     reviewers understand why their click was rejected.
 *
 * 审批权限与服务端 approveVersion 用同一判定（decideVersionApproval）：
 * 团队策略由团队 owner/admin 审批且作者不能自审；个人策略所有者可自审，
 * 确认框里说明这是记录在案的自审。客户端只决定显示哪些操作，服务端 403 仍是最终裁决。
 */

type VersionStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'DEPRECATED'
  | 'ARCHIVED';

interface VersionRow {
  id: string;
  version: number;
  sourceHash: string;
  status: VersionStatus;
  isDefault: boolean;
  releaseNote: string | null;
  createdBy: string;
  createdAt: string;
  deprecatedAt: string | null;
  deprecatedBy: string | null;
  archivedAt: string | null;
  archivedBy: string | null;
  _count: { approvals: number };
}

type ActionKind =
  | 'submit'
  | 'approve'
  | 'reject'
  | 'setDefault'
  | 'deprecate'
  | 'archive';

interface PendingAction {
  kind: ActionKind;
  version: number;
}

interface VersionsContentProps {
  policyId: string;
  policyName: string;
  locale: string;
  currentUserId: string;
  /** 审阅判定上下文（服务端按策略与当前用户的团队角色算好） */
  review: Omit<VersionReviewContext, 'reviewerId'>;
  /** 策略所属团队全部 owner/admin 的用户 id；用于提示「团队里没有其他人能审批」。个人策略为空。 */
  teamReviewerIds?: readonly string[];
  labels: { backToPolicy: string; policiesLink: string };
}

export function VersionsContent({
  policyId,
  policyName,
  locale,
  currentUserId,
  review,
  teamReviewerIds = [],
  labels,
}: VersionsContentProps) {
  const t = useTranslations('policies.versions');
  const tCommon = useTranslations('common');
  const listKey = `/api/v1/policies/${policyId}/versions`;
  // Backend wraps the array as { versions: [...] } — destructure here
  // rather than handing a wrong-shape `data` to DataTable, which would
  // try `data.map` on a plain object and crash with TypeError.
  const { data, error, isLoading, mutate: refresh } =
    useApi<{ versions: VersionRow[] }>(listKey);
  const versions = data?.versions;

  const [pending, setPending] = useState<PendingAction | null>(null);
  // The dialog input — release note for submit, comment for
  // approve/reject, reason for deprecate/archive. One field; the
  // backend ignores it for setDefault.
  const [dialogInput, setDialogInput] = useState('');

  // 提交、设默认、弃用、归档仍只属于策略所有者；批准/驳回按审批规则判定
  const isOwner = review.policyOwnerId === currentUserId;
  const approvalFor = (v: VersionRow) =>
    decideVersionApproval({ ...review, reviewerId: currentUserId, versionAuthorId: v.createdBy });

  const allowedActions = (v: VersionRow): ActionKind[] => {
    switch (v.status) {
      case 'DRAFT':
        return isOwner ? ['submit'] : [];
      case 'PENDING_APPROVAL':
        return approvalFor(v).allowed ? ['approve', 'reject'] : [];
      case 'APPROVED':
        if (!isOwner) return [];
        return v.isDefault
          ? ['deprecate', 'archive']
          : ['setDefault', 'deprecate', 'archive'];
      case 'REJECTED':
      case 'DEPRECATED':
        return isOwner ? ['archive'] : [];
      case 'ARCHIVED':
        return [];
    }
  };

  /** 当前用户批准/驳回该版本是否属于个人策略的自审（确认框据此给出说明）。 */
  const isSelfApprove = (version: number): boolean => {
    const row = versions?.find((v) => v.version === version);
    if (!row) return false;
    const verdict = approvalFor(row);
    return verdict.allowed && verdict.selfApproved;
  };

  // One mutation hook per verb; each closes over its path template.
  // useMutation's path is constant per hook instance, so we build
  // ad-hoc URLs via a small helper that calls fetch directly when
  // version is variable.
  const performAction = async (kind: ActionKind, version: number) => {
    const base = `/api/v1/policies/${policyId}/versions/${version}`;
    const url =
      kind === 'submit'
        ? `${base}/submit`
        : kind === 'approve'
          ? `${base}/approve`
          : kind === 'reject'
            ? `${base}/reject`
            : kind === 'setDefault'
              ? `${base}/set-default`
              : kind === 'deprecate'
                ? `${base}/deprecate`
                : `${base}/archive`;
    const body: Record<string, string | undefined> =
      kind === 'submit'
        ? { releaseNote: dialogInput || undefined }
        : kind === 'approve' || kind === 'reject'
          ? { comment: dialogInput || undefined }
          : kind === 'deprecate' || kind === 'archive'
            ? { reason: dialogInput || undefined }
            : {};
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as
      | { error?: string; code?: string }
      | null;
    if (!res.ok) {
      // 审批路由把错误码放在 error 字段（segregation_of_duties / invite_reviewer_required），
      // 个别入口用 code；两处都读，保证 SOX 提示显示本地化文案而不是原始错误码。
      const errorCode = data?.code ?? data?.error;
      if (errorCode === 'segregation_of_duties') {
        toast.error(t('sox.selfApprovalNotAllowed'));
      } else if (errorCode === 'invite_reviewer_required') {
        toast.error(t('sox.inviteReviewerRequired'));
      } else {
        toast.error(data?.error || tCommon('somethingWrong'));
      }
      return;
    }
    toast.success(t(`actions.${kind}`));
    setPending(null);
    setDialogInput('');
    await refresh();
  };

  // Dialog props derived from the pending action kind.
  const dialogConfig = (() => {
    if (!pending) return null;
    const variant: 'danger' | 'warning' | 'info' =
      pending.kind === 'reject' || pending.kind === 'archive'
        ? 'danger'
        : pending.kind === 'deprecate'
          ? 'warning'
          : 'info';
    const dialogKey = `${pending.kind}Dialog` as const;
    return {
      title: t(`${dialogKey}.title`, { n: pending.version }),
      body: t(`${dialogKey}.body`, { n: pending.version }),
      confirm: t(`${dialogKey}.confirm`),
      cancel: t(`${dialogKey}.cancel`),
      variant,
      inputLabel:
        pending.kind === 'submit'
          ? t('submitDialog.noteLabel')
          : pending.kind === 'approve'
            ? t('approveDialog.commentLabel')
            : pending.kind === 'reject'
              ? t('rejectDialog.commentLabel')
              : pending.kind === 'deprecate' || pending.kind === 'archive'
                ? t(`${dialogKey}.reasonLabel`)
                : null,
      inputPlaceholder:
        pending.kind === 'submit'
          ? t('submitDialog.notePlaceholder')
          : pending.kind === 'approve'
            ? t('approveDialog.commentPlaceholder')
            : pending.kind === 'reject'
              ? t('rejectDialog.commentPlaceholder')
              : null,
    };
  })();

  return (
    <Container size="xl" className="py-6 sm:py-10">
      <Stack gap={6}>
        <PageHeader
          breadcrumbs={
            <Breadcrumbs
              items={[
                { label: labels.policiesLink, href: '/policies' },
                { label: policyName, href: `/policies/${policyId}` },
                { label: t('breadcrumb') },
              ]}
            />
          }
          title={t('title')}
          subtitle={t('subtitle')}
          action={
            <Link href={`/policies/${policyId}/edit`}>
              <Button variant="primary">{t('newVersion')}</Button>
            </Link>
          }
        />

        {error ? (
          <EmptyState
            title={tCommon('somethingWrong')}
            description={error.message}
          />
        ) : !isLoading && (!versions || versions.length === 0) ? (
          <EmptyState
            icon={<GitBranch className="size-5" />}
            title={t('noVersions')}
            description={t('noVersionsBody')}
            action={
              <Link href={`/policies/${policyId}/edit`}>
                <Button variant="primary">{t('newVersion')}</Button>
              </Link>
            }
          />
        ) : (
          <DataTable<VersionRow>
            loading={isLoading}
            rows={versions ?? []}
            getRowKey={(v) => v.id}
            columns={[
              {
                key: 'version',
                header: t('table.version'),
                cell: (v) => (
                  <span className="font-mono font-semibold text-fg">
                    v{v.version}
                    {v.isDefault && (
                      <Badge variant="primary" className="ml-2">
                        {t('isDefault')}
                      </Badge>
                    )}
                  </span>
                ),
              },
              {
                key: 'status',
                header: t('table.status'),
                cell: (v) => <StatusBadge status={v.status} t={t} />,
              },
              {
                key: 'approvals',
                header: t('table.approvals'),
                cell: (v) => (
                  <span className="tabular-nums">
                    {v._count.approvals}
                  </span>
                ),
              },
              {
                key: 'releaseNote',
                header: t('table.releaseNote'),
                cell: (v) =>
                  v.releaseNote ? (
                    <span className="block max-w-xs truncate text-sm text-fg-muted">
                      {v.releaseNote}
                    </span>
                  ) : (
                    <span className="text-fg-subtle">—</span>
                  ),
              },
              {
                key: 'createdAt',
                header: t('table.createdAt'),
                cell: (v) => (
                  <span className="text-sm text-fg-muted">
                    {new Date(v.createdAt).toLocaleDateString(locale)}
                  </span>
                ),
              },
              {
                key: 'actions',
                header: t('table.actions'),
                srHeader: true,
                className: 'text-right',
                cell: (v) => {
                  const actions = allowedActions(v);
                  if (actions.length === 0) {
                    // 待审批但当前用户不能审批（作者本人或无审阅权）：说明在等谁，而不是留空
                    if (v.status !== 'PENDING_APPROVAL') return null;
                    // 团队里除作者外没有 owner/admin：「等待他人」永远等不到，指向团队成员管理去任命管理员
                    if (review.policyTeamId && lacksEligibleReviewer(review.policyTeamId, teamReviewerIds, v.createdBy)) {
                      return (
                        <Link
                          href={`/teams/${review.policyTeamId}/members`}
                          className="text-xs text-warning underline hover:text-warning/80"
                          data-testid="no-eligible-reviewer"
                        >
                          {t('noEligibleReviewer')}
                        </Link>
                      );
                    }
                    return <span className="text-xs text-warning">{t('awaitingOthers')}</span>;
                  }
                  return (
                    <Dropdown
                      align="right"
                      trigger={
                        <IconButton
                          variant="ghost"
                          size="sm"
                          aria-label={t('table.actions')}
                        >
                          <MoreVertical />
                        </IconButton>
                      }
                    >
                      {actions.map((kind) => (
                        <DropdownItem
                          key={kind}
                          variant={
                            kind === 'reject' || kind === 'archive'
                              ? 'danger'
                              : 'default'
                          }
                          onSelect={() => {
                            setPending({ kind, version: v.version });
                            setDialogInput('');
                          }}
                        >
                          {t(`actions.${kind}`)}
                        </DropdownItem>
                      ))}
                    </Dropdown>
                  );
                },
              },
            ]}
          />
        )}
      </Stack>

      {dialogConfig && pending && (
        <ConfirmDialog
          isOpen
          title={dialogConfig.title}
          description={
            <Stack gap={3}>
              <p>{dialogConfig.body}</p>
              {(pending.kind === 'approve' || pending.kind === 'reject') && isSelfApprove(pending.version) && (
                <p className="rounded-md bg-bg-subtle px-3 py-2 text-xs text-fg-muted" data-testid="self-approve-note">
                  {t('selfApproveNote')}
                </p>
              )}
              {dialogConfig.inputLabel && (
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-fg">
                    {dialogConfig.inputLabel}
                  </span>
                  <Textarea
                    value={dialogInput}
                    onChange={(e) => setDialogInput(e.target.value)}
                    placeholder={dialogConfig.inputPlaceholder ?? undefined}
                    rows={3}
                  />
                </label>
              )}
            </Stack>
          }
          confirmLabel={dialogConfig.confirm}
          cancelLabel={dialogConfig.cancel}
          variant={dialogConfig.variant}
          onConfirm={() => performAction(pending.kind, pending.version)}
          onCancel={() => {
            setPending(null);
            setDialogInput('');
          }}
        />
      )}
    </Container>
  );
}

function StatusBadge({
  status,
  t,
}: {
  status: VersionStatus;
  t: (key: string) => string;
}) {
  const variant = (() => {
    switch (status) {
      case 'DRAFT':
        return 'neutral' as const;
      case 'PENDING_APPROVAL':
        return 'warning' as const;
      case 'APPROVED':
        return 'success' as const;
      case 'REJECTED':
      case 'ARCHIVED':
        return 'danger' as const;
      case 'DEPRECATED':
        return 'outline' as const;
    }
  })();
  return <Badge variant={variant}>{t(`status.${status}`)}</Badge>;
}
