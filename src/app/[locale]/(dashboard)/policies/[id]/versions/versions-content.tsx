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
import { isSelfApproval } from '@/services/policy/version-approval-rules';

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
 * Self-approval guard is enforced both client-side (action menu
 * hides Approve when the version's createdBy === current user) and
 * server-side (the backend's 403 still wins if the client is stale).
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
  labels: { backToPolicy: string; policiesLink: string };
}

export function VersionsContent({
  policyId,
  policyName,
  locale,
  currentUserId,
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

  /** Build the per-row action set, respecting the version's state +
   *  self-approval rule. */
  const allowedActions = (v: VersionRow): ActionKind[] => {
    const isSelf = isSelfApproval(v.createdBy, currentUserId);
    switch (v.status) {
      case 'DRAFT':
        return isSelf ? ['submit'] : ['submit'];
      case 'PENDING_APPROVAL':
        // Cannot approve own version (SOX); reject by anyone with role
        // is fine — server has final say.
        return isSelf ? ['reject'] : ['approve', 'reject'];
      case 'APPROVED':
        return v.isDefault
          ? ['deprecate', 'archive']
          : ['setDefault', 'deprecate', 'archive'];
      case 'REJECTED':
      case 'DEPRECATED':
        return ['archive'];
      case 'ARCHIVED':
        return [];
    }
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
      // Backend returns code='segregation_of_duties' or
      // 'invite_reviewer_required' for SOX violations on /approve.
      if (data?.code === 'segregation_of_duties') {
        toast.error(t('sox.selfApprovalNotAllowed'));
      } else if (data?.code === 'invite_reviewer_required') {
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
                  if (actions.length === 0) return null;
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
