'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Breadcrumbs, Container, Input, PageHeader, Toggle } from '@/components/ui';

interface AccessUser {
  id: string;
  email: string | null;
  name: string | null;
  isAdmin: boolean;
  aiWorkspaceEnabled: boolean;
  createdAt: string;
}

export function AiWorkspaceAccessContent() {
  const t = useTranslations('admin.aiWorkspaceAccess');
  const tNav = useTranslations('dashboardNav');
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<AccessUser[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const loadUsers = useCallback(async () => {
    setError('');
    try {
      const response = await fetch(`/api/admin/ai-workspace-access?q=${encodeURIComponent(query)}`);
      if (!response.ok) throw new Error(String(response.status));
      const result = await response.json() as { users: AccessUser[] };
      setUsers(result.users);
    } catch {
      setError(t('loadError'));
    }
  }, [query, t]);

  useEffect(() => {
    // 数据加载需随搜索词变化；更新状态发生在异步请求完成后。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadUsers();
  }, [loadUsers]);

  async function setEnabled(user: AccessUser, enabled: boolean) {
    setBusy(user.id);
    setError('');
    setUsers((rows) => rows.map((row) => row.id === user.id ? { ...row, aiWorkspaceEnabled: enabled } : row));
    try {
      const response = await fetch('/api/admin/ai-workspace-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, enabled }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const result = await response.json() as { user: AccessUser };
      setUsers((rows) => rows.map((row) => row.id === user.id ? result.user : row));
    } catch {
      setUsers((rows) => rows.map((row) => row.id === user.id ? user : row));
      setError(t('saveError'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Container size="xl" className="py-6 sm:py-10">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        breadcrumbs={<Breadcrumbs items={[{ label: tNav('groupAdmin') }, { label: t('title') }]} />}
        className="mb-6"
      />
      <p className="mb-4 text-sm text-fg-muted">{t('adminDefault')}</p>
      <label className="mb-4 block max-w-md text-sm">
        {t('search')}
        <Input className="mt-1" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      {error && <p role="alert" className="mb-4 text-sm text-red-700">{error}</p>}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-bg-muted">
            <tr>
              <th className="p-3">{t('email')}</th>
              <th className="p-3">{t('name')}</th>
              <th className="p-3">{t('administrator')}</th>
              <th className="p-3">{t('enabled')}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-t border-border">
                <td className="p-3">{user.email ?? '—'}</td>
                <td className="p-3">{user.name ?? '—'}</td>
                <td className="p-3">{user.isAdmin ? <Badge>{t('administrator')}</Badge> : '—'}</td>
                <td className="p-3">
                  <Toggle
                    checked={user.aiWorkspaceEnabled}
                    onChange={(enabled) => void setEnabled(user, enabled)}
                    disabled={busy === user.id}
                    ariaLabel={t('toggle', { email: user.email ?? user.id })}
                  />
                </td>
              </tr>
            ))}
            {users.length === 0 && <tr><td colSpan={4} className="p-4 text-center text-fg-muted">{t('empty')}</td></tr>}
          </tbody>
        </table>
      </div>
    </Container>
  );
}
