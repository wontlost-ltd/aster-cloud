'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Container, Input, PageHeader, Toggle } from '@/components/ui';

/*
 * 平台管理员的能力授权页（ADR 0058 §4.10），对接 /api/admin/capabilities/[capability]/** 。
 * 用户标签：搜索、来源列、授予 / 撤销（只撤 direct 来源：团队委派归团队 owner，团队授权在团队标签撤）。
 * 团队标签：团队授权开关、委派额度（seatCap / ownerGrantingEnabled）与已用座位。
 */

const CAPABILITY = 'structured_authoring';
const API = `/api/admin/capabilities/${CAPABILITY}`;
const SEARCH_DEBOUNCE_MS = 250;

type GrantSource =
  | { kind: 'admin' }
  | { kind: 'direct'; grantId: string }
  | { kind: 'team'; grantId: string; teamId: string; teamName: string | null }
  | { kind: 'delegated'; grantId: string; teamId: string; teamName: string | null };

interface GrantUser {
  id: string;
  email: string | null;
  name: string | null;
  sources: GrantSource[];
}

interface GrantTeam {
  id: string;
  name: string;
  slug: string;
  grantId: string | null;
  allotment: { seatCap: number; ownerGrantingEnabled: boolean } | null;
  seatsUsed: number;
}

interface AllotmentDraft {
  seatCap: string;
  ownerGrantingEnabled: boolean;
}

type Tab = 'users' | 'teams';

class ApiError extends Error {
  constructor(readonly code: string | undefined) {
    super(code);
  }
}

/** 统一的写请求：非 2xx 时带上服务端 `code` 抛出，便于调用方挑选文案。 */
async function send(method: 'POST' | 'DELETE' | 'PUT', path: string, body: unknown) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { code?: string } | null;
    throw new ApiError(payload?.code);
  }
}

function sourceLabel(source: GrantSource): string {
  switch (source.kind) {
    case 'team':
      return `team:${source.teamName ?? source.teamId}`;
    case 'delegated':
      return `delegated:${source.teamName ?? source.teamId}`;
    default:
      return source.kind;
  }
}

function toDraft(team: GrantTeam): AllotmentDraft {
  return {
    seatCap: String(team.allotment?.seatCap ?? 0),
    ownerGrantingEnabled: team.allotment?.ownerGrantingEnabled ?? false,
  };
}

export function CapabilityGrantsContent() {
  const t = useTranslations('admin.structuredAuthoring');
  const [tab, setTab] = useState<Tab>('users');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  // 只接受最新一次读取的结果，避免慢响应覆盖新搜索词的列表
  const loadSeq = useRef(0);
  const [users, setUsers] = useState<GrantUser[]>([]);
  const [teams, setTeams] = useState<GrantTeam[]>([]);
  const [drafts, setDrafts] = useState<Record<string, AllotmentDraft>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setError('');
    try {
      const subject = tab === 'users' ? 'user' : 'team';
      const response = await fetch(`${API}/grants?subject=${subject}&q=${encodeURIComponent(debouncedQuery)}`);
      if (!response.ok) throw new Error(String(response.status));
      const result = (await response.json()) as { users?: GrantUser[]; teams?: GrantTeam[] };
      if (seq !== loadSeq.current) return;
      if (tab === 'users') {
        setUsers(result.users ?? []);
      } else {
        const rows = result.teams ?? [];
        setTeams(rows);
        setDrafts(Object.fromEntries(rows.map((team) => [team.id, toDraft(team)])));
      }
    } catch {
      if (seq === loadSeq.current) setError(t('loadError'));
    }
  }, [tab, debouncedQuery, t]);

  useEffect(() => {
    // 数据加载需随标签与搜索词变化；更新状态发生在异步请求完成后。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  /** 执行一次写操作：成功后重新拉取，失败按错误码映射文案；busy 标记防止同一行重复提交。 */
  async function mutate(busyKey: string, run: () => Promise<void>, failure: (e: ApiError) => string) {
    setBusy(busyKey);
    setError('');
    try {
      await run();
      await load();
    } catch (e) {
      setError(failure(e instanceof ApiError ? e : new ApiError(undefined)));
    } finally {
      setBusy(null);
    }
  }

  const grantUser = (user: GrantUser) =>
    mutate(`user:${user.id}`, () => send('POST', '/grants', { subjectType: 'user', subjectId: user.id }), () => t('saveError'));

  const revokeGrant = (busyKey: string, grantId: string) =>
    mutate(busyKey, () => send('DELETE', '/grants', { grantId }), () => t('saveError'));

  const toggleTeamGrant = (team: GrantTeam, enabled: boolean) =>
    enabled
      ? mutate(`team:${team.id}`, () => send('POST', '/grants', { subjectType: 'team', subjectId: team.id }), () => t('saveError'))
      : revokeGrant(`team:${team.id}`, team.grantId ?? '');

  const saveAllotment = (team: GrantTeam) => {
    const draft = drafts[team.id] ?? toDraft(team);
    return mutate(
      `allot:${team.id}`,
      () => send('PUT', `/teams/${team.id}/allotment`, { seatCap: Number(draft.seatCap), ownerGrantingEnabled: draft.ownerGrantingEnabled }),
      (e) => (e.code === 'seat_cap_below_active' ? t('seatCapBelowActive', { used: team.seatsUsed }) : t('saveError')),
    );
  };

  const patchDraft = (team: GrantTeam, patch: Partial<AllotmentDraft>) =>
    setDrafts((all) => ({ ...all, [team.id]: { ...(all[team.id] ?? toDraft(team)), ...patch } }));

  return (
    <Container size="xl" className="py-6 sm:py-10">
      <PageHeader title={t('title')} subtitle={t('subtitle')} className="mb-6" />
      <div role="tablist" className="mb-4 flex gap-2">
        {(['users', 'teams'] as const).map((id) => (
          <Button
            key={id}
            role="tab"
            aria-selected={tab === id}
            variant={tab === id ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setTab(id)}
          >
            {t(id === 'users' ? 'tabUsers' : 'tabTeams')}
          </Button>
        ))}
      </div>
      <label className="mb-4 block max-w-md text-sm">
        {t('search')}
        <Input className="mt-1" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      {error && <p role="alert" className="mb-4 text-sm text-red-700">{error}</p>}
      <div tabIndex={0} role="region" aria-label={t(tab === 'users' ? 'tabUsers' : 'tabTeams')} data-scroll-region className="overflow-x-auto rounded-lg border border-border">
        {tab === 'users' ? (
          <table className="w-full text-left text-sm">
            <thead className="bg-bg-muted">
              <tr>
                <th className="p-3">{t('email')}</th>
                <th className="p-3 max-sm:hidden">{t('name')}</th>
                <th className="p-3">{t('sources')}</th>
                <th className="p-3">{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const direct = user.sources.find((s) => s.kind === 'direct');
                return (
                  <tr key={user.id} className="border-t border-border">
                    <td className="p-3">{user.email ?? '—'}</td>
                    <td className="p-3 max-sm:hidden">{user.name ?? '—'}</td>
                    <td className="p-3">
                      <div className="flex flex-wrap gap-1">
                        {user.sources.length === 0
                          ? '—'
                          : user.sources.map((source, index) => <Badge key={index}>{sourceLabel(source)}</Badge>)}
                      </div>
                    </td>
                    <td className="p-3">
                      {direct && direct.kind === 'direct' ? (
                        <Button size="sm" variant="secondary" disabled={busy === `user:${user.id}`} onClick={() => void revokeGrant(`user:${user.id}`, direct.grantId)}>
                          {t('revoke')}
                        </Button>
                      ) : (
                        <Button size="sm" disabled={busy === `user:${user.id}`} onClick={() => void grantUser(user)}>
                          {t('grant')}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {users.length === 0 && <tr><td colSpan={4} className="p-4 text-center text-fg-muted">{t('empty')}</td></tr>}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="bg-bg-muted">
              <tr>
                <th className="p-3">{t('team')}</th>
                <th className="p-3">{t('teamGrantColumn')}</th>
                <th className="p-3">{t('seatCap')}</th>
                <th className="p-3">{t('ownerGrantingColumn')}</th>
                <th className="p-3">{t('seatsUsed')}</th>
                <th className="p-3">{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {teams.map((team) => {
                const draft = drafts[team.id] ?? toDraft(team);
                const rowBusy = busy !== null && busy.endsWith(team.id);
                return (
                  <tr key={team.id} className="border-t border-border">
                    <td className="p-3">{team.name}<span className="ml-2 text-fg-muted">{team.slug}</span></td>
                    <td className="p-3">
                      <Toggle
                        checked={team.grantId !== null}
                        onChange={(enabled) => void toggleTeamGrant(team, enabled)}
                        disabled={rowBusy}
                        ariaLabel={t('teamGrant', { team: team.name })}
                      />
                    </td>
                    <td className="p-3">
                      <Input
                        type="number"
                        min={0}
                        max={10000}
                        step={1}
                        className="w-24"
                        aria-label={t('seatCapLabel', { team: team.name })}
                        value={draft.seatCap}
                        onChange={(event) => patchDraft(team, { seatCap: event.target.value })}
                      />
                    </td>
                    <td className="p-3">
                      <Toggle
                        checked={draft.ownerGrantingEnabled}
                        onChange={(enabled) => patchDraft(team, { ownerGrantingEnabled: enabled })}
                        disabled={rowBusy}
                        ariaLabel={t('ownerGranting', { team: team.name })}
                      />
                    </td>
                    <td className="p-3">{team.seatsUsed}</td>
                    <td className="p-3">
                      <Button size="sm" disabled={rowBusy} onClick={() => void saveAllotment(team)}>
                        {t('saveAllotment')}
                      </Button>
                    </td>
                  </tr>
                );
              })}
              {teams.length === 0 && <tr><td colSpan={6} className="p-4 text-center text-fg-muted">{t('empty')}</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </Container>
  );
}
