// ADR 0058 §4.10：平台管理页（用户 / 团队两个标签）。fetch 全部桩掉，断言来源列、请求载荷与错误文案。
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { locales } from '@/i18n/config';
import { CapabilityGrantsContent } from '@/components/admin/capability-grants-content';

const L = (DEMO_SUPPLEMENT.en.admin as { structuredAuthoring: Record<string, string> }).structuredAuthoring;

const USERS = {
  users: [
    {
      id: 'u-1',
      email: 'direct@x.io',
      name: 'Dee',
      sources: [
        { kind: 'direct', grantId: 'g-direct' },
        { kind: 'team', grantId: 'g-team', teamId: 't-1', teamName: 'Alpha' },
        { kind: 'delegated', grantId: 'g-del', teamId: 't-2', teamName: 'Beta' },
        { kind: 'admin' },
      ],
    },
    { id: 'u-2', email: 'none@x.io', name: null, sources: [] },
    { id: 'u-3', email: 'viaTeam@x.io', name: null, sources: [{ kind: 'team', grantId: 'g-t2', teamId: 't-1', teamName: 'Alpha' }] },
  ],
};
const TEAMS = {
  teams: [
    { id: 't-1', name: 'Alpha', slug: 'alpha', grantId: 'g-t1', allotment: { seatCap: 5, ownerGrantingEnabled: true }, seatsUsed: 3 },
    { id: 't-2', name: 'Beta', slug: 'beta', grantId: null, allotment: null, seatsUsed: 0 },
  ],
};

const json = (status: number, body: unknown) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

let fetchMock: ReturnType<typeof vi.fn>;

function setup(locale: (typeof locales)[number] = 'en', handler?: (url: string, init?: RequestInit) => Promise<Response>) {
  fetchMock = vi.fn(
    handler ??
      ((url: string) => json(200, url.includes('subject=team') ? TEAMS : USERS)),
  );
  vi.stubGlobal('fetch', fetchMock);
  return render(
    <NextIntlClientProvider locale={locale} messages={DEMO_SUPPLEMENT[locale]}>
      <CapabilityGrantsContent />
    </NextIntlClientProvider>,
  );
}

const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET');

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CapabilityGrantsContent', () => {
  it.each([
    ['en', 'Structured Authoring'],
    ['zh', '结构化编写'],
    ['de', 'Strukturiertes Verfassen'],
    ['hi', 'संरचित लेखन'],
  ] as const)('%s 标题为 %s', async (locale, title) => {
    setup(locale);
    expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
  });

  it('四种语言都提供全部文案键', () => {
    for (const locale of locales) {
      const ns = (DEMO_SUPPLEMENT[locale].admin as { structuredAuthoring: Record<string, string> }).structuredAuthoring;
      expect(Object.keys(ns).sort(), locale).toEqual(Object.keys(L).sort());
    }
  });

  it('用户行来源列显示 direct / team:<名> / delegated:<名> / admin', async () => {
    setup();
    const row = (await screen.findByText('direct@x.io')).closest('tr')!;
    expect(row.textContent).toContain('direct');
    expect(row.textContent).toContain('team:Alpha');
    expect(row.textContent).toContain('delegated:Beta');
    expect(row.textContent).toContain('admin');
  });

  it('搜索词带入 GET 查询串', async () => {
    setup();
    await screen.findByText('direct@x.io');
    fireEvent.change(screen.getByLabelText(L.search), { target: { value: 'dee' } });
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('subject=user') && String(u).includes('q=dee'))).toBe(true),
    );
  });

  it('慢响应乱序返回时不覆盖较新搜索词的结果', async () => {
    const resolvers: Record<string, (r: Response) => void> = {};
    setup('en', (url: string) => {
      if (url.includes('q=a&') || url.endsWith('q=a')) {
        return new Promise<Response>((resolve) => (resolvers.a = resolve));
      }
      if (url.includes('q=ab')) return json(200, { users: [{ id: 'u-9', email: 'fresh@x.io', name: null, sources: [] }] });
      return json(200, USERS);
    });
    await screen.findByText('direct@x.io');
    fireEvent.change(screen.getByLabelText(L.search), { target: { value: 'a' } });
    await waitFor(() => expect(resolvers.a).toBeDefined());
    fireEvent.change(screen.getByLabelText(L.search), { target: { value: 'ab' } });
    await screen.findByText('fresh@x.io');
    resolvers.a(await json(200, { users: [{ id: 'u-8', email: 'stale@x.io', name: null, sources: [] }] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('stale@x.io')).toBeNull();
    expect(screen.getByText('fresh@x.io')).toBeTruthy();
  });

  it('点「授予」发 POST {subjectType:user, subjectId}', async () => {
    setup(
      'en',
      (url, init) =>
        init?.method === 'POST' ? json(201, { grant: { id: 'g-new' } }) : json(200, url.includes('subject=team') ? TEAMS : USERS),
    );
    const row = (await screen.findByText('none@x.io')).closest('tr')!;
    fireEvent.click(row.querySelector('button')!);
    await waitFor(() => expect(writes()).toHaveLength(1));
    const [url, init] = writes()[0];
    expect(String(url)).toBe('/api/admin/capabilities/structured_authoring/grants');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ subjectType: 'user', subjectId: 'u-2' });
  });

  it('撤销只针对 direct 来源（DELETE {grantId}）；仅有团队来源的用户没有撤销按钮', async () => {
    setup('en', (url, init) => (init?.method === 'DELETE' ? json(200, { grant: {} }) : json(200, USERS)));
    const viaTeamRow = (await screen.findByText('viaTeam@x.io')).closest('tr')!;
    expect(viaTeamRow.querySelector('button')?.textContent).toBe(L.grant);
    const row = screen.getByText('direct@x.io').closest('tr')!;
    fireEvent.click(row.querySelector('button')!);
    await waitFor(() => expect(writes()).toHaveLength(1));
    const [, init] = writes()[0];
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body as string)).toEqual({ grantId: 'g-direct' });
  });

  it('团队标签：显示额度与已用座位，保存发 PUT {seatCap, ownerGrantingEnabled}', async () => {
    setup('en', (url, init) =>
      init?.method === 'PUT' ? json(200, { allotment: { seatCap: 8, ownerGrantingEnabled: false } }) : json(200, url.includes('subject=team') ? TEAMS : USERS),
    );
    fireEvent.click(await screen.findByRole('tab', { name: L.tabTeams }));
    const row = (await screen.findByText('Alpha')).closest('tr')!;
    expect(row.textContent).toContain('3');
    const cap = row.querySelector('input[type="number"]') as HTMLInputElement;
    expect(cap.value).toBe('5');
    fireEvent.change(cap, { target: { value: '8' } });
    fireEvent.click(row.querySelector('[role="switch"][aria-label="' + L.ownerGranting.replace('{team}', 'Alpha') + '"]')!);
    fireEvent.click(screen.getAllByRole('button', { name: L.saveAllotment })[0]);
    await waitFor(() => expect(writes()).toHaveLength(1));
    const [url, init] = writes()[0];
    expect(String(url)).toBe('/api/admin/capabilities/structured_authoring/teams/t-1/allotment');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ seatCap: 8, ownerGrantingEnabled: false });
  });

  it('团队授权开关：开启 POST team，关闭 DELETE grantId', async () => {
    setup('en', (url, init) => (init?.method ? json(200, { grant: { id: 'g-x' } }) : json(200, url.includes('subject=team') ? TEAMS : USERS)));
    fireEvent.click(await screen.findByRole('tab', { name: L.tabTeams }));
    const beta = (await screen.findByText('Beta')).closest('tr')!;
    fireEvent.click(beta.querySelector(`[role="switch"][aria-label="${L.teamGrant.replace('{team}', 'Beta')}"]`)!);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0][1].body as string)).toEqual({ subjectType: 'team', subjectId: 't-2' });
    const alpha = screen.getByText('Alpha').closest('tr')!;
    fireEvent.click(alpha.querySelector(`[role="switch"][aria-label="${L.teamGrant.replace('{team}', 'Alpha')}"]`)!);
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1][1].method).toBe('DELETE');
    expect(JSON.parse(writes()[1][1].body as string)).toEqual({ grantId: 'g-t1' });
  });

  it('409 seat_cap_below_active 显示含已用数的错误', async () => {
    setup('en', (url, init) =>
      init?.method === 'PUT'
        ? json(409, { error: 'seatCap 1 is below 3 active delegated seats', code: 'seat_cap_below_active' })
        : json(200, url.includes('subject=team') ? TEAMS : USERS),
    );
    fireEvent.click(await screen.findByRole('tab', { name: L.tabTeams }));
    const row = (await screen.findByText('Alpha')).closest('tr')!;
    fireEvent.change(row.querySelector('input[type="number"]')!, { target: { value: '1' } });
    fireEvent.click(screen.getAllByRole('button', { name: L.saveAllotment })[0]);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(L.seatCapBelowActive.replace('{used}', '3'));
  });

  it('加载失败显示 loadError', async () => {
    setup('en', () => json(500, {}));
    expect((await screen.findByRole('alert')).textContent).toBe(L.loadError);
  });
});
