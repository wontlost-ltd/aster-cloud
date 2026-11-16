'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Select } from '@/components/ui';

/*
 * 团队设置页的「结构化编写座位」卡片（ADR 0058 §4.6 / §4.10），仅 owner 渲染。
 * 额度与已用座位来自 /api/teams/[teamId]/capabilities/structured_authoring/grants；
 * 可委派的人 = 本团队非 viewer 且尚未委派的成员。被降为 viewer 的委派仍占座，标记为暂停。
 */

const CAPABILITY = 'structured_authoring';

interface Delegation {
  grantId: string;
  userId: string;
  email: string | null;
  name: string | null;
  role: string;
  grantedAt: string;
}

interface SeatsView {
  allotment: { seatCap: number; ownerGrantingEnabled: boolean } | null;
  seatsUsed: number;
  delegations: Delegation[];
  delegationOpen: boolean;
}

interface Member {
  userId: string;
  role: string;
  user: { name: string | null; email: string };
}

/** 服务端错误码 → 文案键；未列出的码统一用 saveError。 */
const ERROR_KEYS: Record<string, string> = {
  seat_cap_reached: 'errors.seatCapReached',
  team_delegation_disabled: 'errors.teamDelegationDisabled',
  not_team_member: 'errors.notTeamMember',
  viewer_not_eligible: 'errors.viewerNotEligible',
  not_team_owner: 'errors.notTeamOwner',
  delegation_not_supported: 'errors.delegationNotSupported',
};

export function StructuredAuthoringSeatsCard({ teamId }: { teamId: string }) {
  const t = useTranslations('teams.structuredAuthoringSeats');
  const api = `/api/teams/${teamId}/capabilities/${CAPABILITY}/grants`;
  const selectId = useId();
  const [view, setView] = useState<SeatsView | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [seatsRes, membersRes] = await Promise.all([fetch(api), fetch(`/api/teams/${teamId}/members?limit=100`)]);
      if (!seatsRes.ok || !membersRes.ok) throw new Error(String(seatsRes.status));
      setView((await seatsRes.json()) as SeatsView);
      setMembers(((await membersRes.json()) as { members?: Member[] }).members ?? []);
    } catch {
      setError(t('loadError'));
    }
  }, [api, teamId, t]);

  useEffect(() => {
    // 挂载时拉取额度与成员；状态更新发生在异步请求完成后。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const delegated = new Set(view?.delegations.map((d) => d.userId));
  const candidates = members.filter((m) => m.role !== 'viewer' && !delegated.has(m.userId));
  const selected = candidates.some((m) => m.userId === target) ? target : (candidates[0]?.userId ?? '');

  /** 一次写操作：成功后重新拉取，失败按错误码挑文案。 */
  async function send(method: 'POST' | 'DELETE', body: Record<string, string>) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(api, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { code?: string } | null;
        setError(t(ERROR_KEYS[payload?.code ?? ''] ?? 'errors.saveError'));
        return;
      }
      await load();
    } catch {
      setError(t('errors.saveError'));
    } finally {
      setBusy(false);
    }
  }

  const allotment = view?.allotment ?? null;
  const delegationOpen = view?.delegationOpen === true;

  return (
    <div className="bg-bg shadow rounded-lg mb-8">
      <div className="px-6 py-4 border-b border-border">
        <h2 className="text-lg font-medium text-fg">{t('title')}</h2>
        <p className="mt-1 text-sm text-fg-muted">{t('subtitle')}</p>
      </div>
      <div className="px-6 py-4 space-y-4">
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        {view && allotment === null && <p className="text-sm text-fg-muted">{t('noAllotment')}</p>}
        {view && allotment !== null && (
          <>
            <p className="text-sm font-medium text-fg">
              {t('seatsUsed', { used: view.seatsUsed, cap: allotment.seatCap })}
            </p>
            {!delegationOpen && (
              <p className="text-sm text-fg-muted">
                {t(allotment.ownerGrantingEnabled ? 'delegationUnavailable' : 'delegationDisabled')}
              </p>
            )}
          </>
        )}
        {view && view.delegations.length > 0 && (
          <ul className="divide-y divide-border rounded-md border border-border">
            {view.delegations.map((d) => {
              const label = d.name ?? d.email ?? d.userId;
              return (
                <li key={d.grantId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 truncate">
                    <span className="text-fg">{label}</span>
                    {d.name && d.email && <span className="ml-2 text-fg-muted">{d.email}</span>}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {d.role === 'viewer' && <Badge>{t('paused')}</Badge>}
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      aria-label={t('revokeFor', { name: label })}
                      onClick={() => void send('DELETE', { grantId: d.grantId })}
                    >
                      {t('revoke')}
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {view && view.delegations.length === 0 && allotment !== null && (
          <p className="text-sm text-fg-muted">{t('empty')}</p>
        )}
        {view && allotment !== null && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-48 flex-col gap-1 text-sm">
              <label htmlFor={selectId} className="font-medium text-fg">
                {t('memberLabel')}
              </label>
              <Select
                id={selectId}
                value={selected}
                onChange={(e) => setTarget(e.target.value)}
                disabled={!delegationOpen || candidates.length === 0}
              >
                {candidates.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.user.name ?? m.user.email}
                  </option>
                ))}
              </Select>
            </div>
            <Button size="sm" disabled={busy || !delegationOpen || !selected} onClick={() => void send('POST', { userId: selected })}>
              {t('delegate')}
            </Button>
          </div>
        )}
        <p className="text-xs text-fg-muted">{t('viewerNote')}</p>
      </div>
    </div>
  );
}
