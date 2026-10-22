'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { Breadcrumbs, ConfirmDialog, Container, Input, Label, PageHeader, Select, toast } from '@/components/ui';
import { extractErrorMessage } from '@/lib/api/error-envelope';
import { TeamLanguageCard } from '@/components/teams/team-language-card';

interface Team {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export default function TeamSettingsPage() {
  const t = useTranslations('teams');
  const params = useParams();
  const router = useRouter();
  const teamId = params.teamId as string;

  const [team, setTeam] = useState<Team | null>(null);
  const [userRole, setUserRole] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  // 编辑表单
  const [formData, setFormData] = useState({ name: '', slug: '' });
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // 删除确认
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  // 所有权转让
  const [transferOpen, setTransferOpen] = useState(false);
  const [eligibleMembers, setEligibleMembers] = useState<
    Array<{ id: string; userId: string; user: { name: string | null; email: string } }>
  >([]);
  const [transferTargetId, setTransferTargetId] = useState<string>('');
  const [isTransferring, setIsTransferring] = useState(false);

  const fetchTeam = useCallback(async () => {
    try {
      const res = await fetch(`/api/teams/${teamId}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(extractErrorMessage(data) || 'Failed to fetch team');
      }

      const data = await res.json();
      setTeam(data.team);
      setUserRole(data.role);
      setFormData({ name: data.team.name, slug: data.team.slug });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToLoad'));
    } finally {
      setIsLoading(false);
    }
  }, [teamId, t]);

  useEffect(() => {
    // 挂载时异步拉取团队数据，setState 发生在 fetch 完成后的回调中（非渲染期同步），属合法的数据加载副作用。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchTeam();
  }, [fetchTeam]);

  const canEdit = userRole === 'owner' || userRole === 'admin';
  const canDelete = userRole === 'owner';

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setError('');
    setSaveSuccess(false);

    try {
      const res = await fetch(`/api/teams/${teamId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(extractErrorMessage(data) || 'Failed to update team');
      }

      setTeam(data.team);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  /** Load eligible members (anyone other than the current user) when
   *  the transfer dialog opens — kept lazy to skip the fetch entirely
   *  on the common path where the owner never opens this section. */
  const openTransferDialog = async () => {
    setTransferOpen(true);
    try {
      const res = await fetch(`/api/teams/${teamId}/members?limit=100`);
      const data = await res.json();
      if (res.ok) {
        // The new owner must be an existing member; the backend
        // additionally rejects transferring to yourself.
        const eligible = (data.members ?? []).filter(
          (m: { userId: string }) => m.userId !== data.currentUserId,
        );
        setEligibleMembers(eligible);
        if (eligible.length > 0) setTransferTargetId(eligible[0].userId);
      }
    } catch {
      // Silent — the dialog will show the empty-state hint.
    }
  };

  const handleTransfer = async () => {
    if (!transferTargetId) return;
    setIsTransferring(true);
    try {
      const res = await fetch(`/api/teams/${teamId}/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newOwnerId: transferTargetId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(t('settings.transferFailed', { error: extractErrorMessage(data) || res.status }));
        return;
      }
      toast.success(t('settings.transferSuccess'));
      setTransferOpen(false);
      // Refresh team to pick up new role (we're now an admin, not owner).
      await fetchTeam();
    } finally {
      setIsTransferring(false);
    }
  };

  const handleDelete = async () => {
    if (deleteConfirmText !== team?.name) return;

    setIsDeleting(true);
    try {
      const res = await fetch(`/api/teams/${teamId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(extractErrorMessage(data) || 'Failed to delete team');
      }

      router.push('/teams');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.deleteFailed'));
      setIsDeleting(false);
    }
  };

  if (isLoading) {
    return (
      <Container size="xl" className="py-6 sm:py-10">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      </Container>
    );
  }

  if (!team) {
    return (
      <Container size="xl" className="py-6 sm:py-10">
        <div className="text-center py-12">
          <p className="text-red-600">{error || t('teamNotFound')}</p>
          <Link href="/teams" className="mt-4 text-primary hover:text-primary-hover">
            {t('backToTeams')}
          </Link>
        </div>
      </Container>
    );
  }

  if (!canEdit) {
    return (
      <Container size="xl" className="py-6 sm:py-10">
        <div className="text-center py-12">
          <p className="text-fg-muted">{t('settings.noPermission')}</p>
          <Link
            href={`/teams/${teamId}`}
            className="mt-4 inline-flex items-center text-primary hover:text-primary-hover"
          >
            {t('backToTeam')}
          </Link>
        </div>
      </Container>
    );
  }

  return (
    <Container size="xl" className="py-6 sm:py-10">
      {/* 设置页（deep）：保留 Breadcrumbs（放进 PageHeader 的 breadcrumbs slot），
          替代原来手抄的返回箭头链接，用作上一级导航回到团队详情。 */}
      <PageHeader
        title={t('settings.title')}
        breadcrumbs={
          <Breadcrumbs
            items={[
              { label: t('backToTeam'), href: `/teams/${teamId}` },
              { label: t('settings.title') },
            ]}
          />
        }
        className="mb-8"
      />

      {/* 基本信息 */}
      <div className="bg-bg shadow rounded-lg mb-8">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-medium text-fg">{t('settings.generalTitle')}</h2>
          <p className="mt-1 text-sm text-fg-muted">{t('settings.generalSubtitle')}</p>
        </div>
        <form onSubmit={handleSave} className="px-6 py-4 space-y-4">
          {error && (
            <div className="rounded-md bg-red-50 p-4">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}
          {saveSuccess && (
            <div className="rounded-md bg-green-50 p-4">
              <p className="text-sm text-green-700">{t('settings.saveSuccess')}</p>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="name">{t('settings.nameLabel')}</Label>
            <Input
              type="text"
              id="name"
              name="name"
              required
              minLength={2}
              maxLength={50}
              value={formData.name}
              onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="slug">{t('settings.slugLabel')}</Label>
            <div className="flex">
              <span className="inline-flex items-center rounded-l-md border border-r-0 border-border bg-bg-subtle px-3 text-sm text-fg-muted">
                /teams/
              </span>
              {/* Pattern escaped for unicode-sets ('v') regex mode —
                  see teams/new/page.tsx for the same fix. */}
              <Input
                type="text"
                id="slug"
                name="slug"
                required
                minLength={2}
                maxLength={50}
                pattern="[a-z0-9\-]+"
                value={formData.slug}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''),
                  }))
                }
                className="rounded-l-none"
              />
            </div>
            <p className="text-xs text-fg-muted">{t('settings.slugHint')}</p>
          </div>

          <div className="pt-4">
            <button
              type="submit"
              disabled={isSaving}
              className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-primary-hover disabled:opacity-50"
            >
              {isSaving ? t('saving') : t('settings.saveChanges')}
            </button>
          </div>
        </form>
      </div>

      {/* 语言可用性 — owner/admin 设置开放给团队用户的 UI 语言（ADR 0017）。 */}
      <TeamLanguageCard teamId={teamId} />

      {/* Ownership transfer — owner-only, separate card so it doesn't
          look like part of the destructive zone. */}
      {canDelete && (
        <div className="bg-bg shadow rounded-lg border border-border">
          <div className="px-6 py-4 border-b border-border">
            <h2 className="text-lg font-medium text-fg">{t('settings.transferOwnership')}</h2>
            <p className="mt-1 text-sm text-fg-muted">{t('settings.transferOwnershipDesc')}</p>
          </div>
          <div className="px-6 py-4 flex items-center justify-between">
            <p className="text-sm text-fg-muted">{t('settings.transferDialogBody')}</p>
            <button
              type="button"
              onClick={openTransferDialog}
              className="ml-4 inline-flex shrink-0 items-center rounded-md border border-border-strong bg-bg px-3 py-2 text-sm font-medium text-fg hover:bg-bg-subtle"
            >
              {t('settings.transferOwnership')}
            </button>
          </div>
        </div>
      )}

      {/* 危险区域 */}
      {canDelete && (
        <div className="bg-bg shadow rounded-lg border-2 border-red-200">
          <div className="px-6 py-4 border-b border-border">
            <h2 className="text-lg font-medium text-red-600">{t('settings.dangerZone')}</h2>
            <p className="mt-1 text-sm text-fg-muted">{t('settings.dangerZoneSubtitle')}</p>
          </div>
          <div className="px-6 py-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-fg">{t('settings.deleteTeamTitle')}</h3>
                <p className="text-sm text-fg-muted">{t('settings.deleteTeamDescription')}</p>
              </div>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="inline-flex items-center rounded-md bg-red-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-700"
              >
                {t('settings.deleteTeam')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认模态框 */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-bg rounded-lg shadow-xl max-w-md w-full mx-4">
            <div className="px-6 py-4 border-b border-border">
              <h3 className="text-lg font-medium text-red-600">{t('settings.confirmDeleteTitle')}</h3>
            </div>
            <div className="px-6 py-4 space-y-4">
              <p className="text-sm text-fg-muted">{t('settings.confirmDeleteWarning')}</p>
              <ul className="text-sm text-fg-muted list-disc list-inside space-y-1">
                <li>{t('settings.deleteWarning1')}</li>
                <li>{t('settings.deleteWarning2')}</li>
                <li>{t('settings.deleteWarning3')}</li>
              </ul>
              <div>
                <label htmlFor="deleteConfirm" className="block text-sm font-medium text-fg">
                  {t('settings.typeToConfirm', { value: team.name })}
                </label>
                <input
                  type="text"
                  id="deleteConfirm"
                  name="deleteConfirm"
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  className="mt-1 block w-full rounded-md border-border-strong shadow-sm focus:border-red-500 focus:ring-red-500 sm:text-sm"
                  placeholder={team.name}
                />
              </div>
              <div className="flex justify-end space-x-3 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowDeleteConfirm(false);
                    setDeleteConfirmText('');
                  }}
                  className="rounded-md border border-border-strong bg-bg px-4 py-2 text-sm font-medium text-fg hover:bg-bg-subtle"
                >
                  {t('cancel')}
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deleteConfirmText !== team.name || isDeleting}
                  className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isDeleting ? t('deleting') : t('settings.confirmDelete')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SSO 和审计日志即将推出 */}
      <div className="mt-8 space-y-4">
        <div className="bg-bg-subtle rounded-lg p-6 border border-border">
          <div className="flex items-center">
            <div className="flex-shrink-0 p-2 bg-bg-muted rounded-lg">
              <svg className="h-6 w-6 text-fg-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
            </div>
            <div className="ml-4">
              <h3 className="text-sm font-medium text-fg">{t('settings.ssoTitle')}</h3>
              <p className="text-sm text-fg-muted">{t('settings.ssoDescription')}</p>
            </div>
            <span className="ml-auto inline-flex items-center rounded-full bg-bg-muted px-2.5 py-0.5 text-xs font-medium text-fg-muted">
              {t('comingSoon')}
            </span>
          </div>
        </div>

        <div className="bg-bg-subtle rounded-lg p-6 border border-border">
          <div className="flex items-center">
            <div className="flex-shrink-0 p-2 bg-bg-muted rounded-lg">
              <svg className="h-6 w-6 text-fg-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
              </svg>
            </div>
            <div className="ml-4">
              <h3 className="text-sm font-medium text-fg">{t('settings.auditLogsTitle')}</h3>
              <p className="text-sm text-fg-muted">{t('settings.auditLogsDescription')}</p>
            </div>
            <span className="ml-auto inline-flex items-center rounded-full bg-bg-muted px-2.5 py-0.5 text-xs font-medium text-fg-muted">
              {t('comingSoon')}
            </span>
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={transferOpen}
        title={t('settings.transferDialogTitle')}
        description={
          <div className="space-y-3">
            <p>{t('settings.transferDialogBody')}</p>
            {eligibleMembers.length === 0 ? (
              <p className="text-sm text-warning">
                {t('settings.transferNoEligible')}
              </p>
            ) : (
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-fg">
                  {t('settings.transferSelectLabel')}
                </span>
                <Select
                  value={transferTargetId}
                  onChange={(e) => setTransferTargetId(e.target.value)}
                >
                  {eligibleMembers.map((m) => (
                    <option key={m.id} value={m.userId}>
                      {m.user.name ?? m.user.email}
                    </option>
                  ))}
                </Select>
              </label>
            )}
          </div>
        }
        confirmLabel={t('settings.transferConfirm')}
        cancelLabel={t('settings.transferCancel')}
        variant="warning"
        isLoading={isTransferring}
        onConfirm={handleTransfer}
        onCancel={() => !isTransferring && setTransferOpen(false)}
      />
    </Container>
  );
}
