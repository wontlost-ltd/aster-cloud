// @vitest-environment jsdom
/**
 * 上手清单卡片（#796）：普通用户条目、可选条目、按用户收起、并入的偏好表单、文档入口走浮层。
 */
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';
import type { GettingStartedItem } from '@/lib/onboarding/getting-started';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }), usePathname: () => '/dashboard' }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
// 全局 setup 对 lucide-react 做了精简 mock，这里用真实图标
vi.mock('lucide-react', async () => ({ ...(await vi.importActual<Record<string, unknown>>('lucide-react')) }));
const openDocs = vi.fn();
vi.mock('@/components/docs/docs-overlay-context', () => ({ useOptionalDocsOverlay: () => ({ openDocs }) }));

import { GettingStartedCard } from '@/components/dashboard/getting-started-card';

const messages = deepMergeMessages(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../node_modules/@aster-cloud/ui-messages/en-US.json'), 'utf8')),
  DEMO_SUPPLEMENT.en,
);

function regularItems(over: Partial<Record<GettingStartedItem['id'], boolean>> = {}): GettingStartedItem[] {
  const d = (id: GettingStartedItem['id']) => over[id] ?? false;
  return [
    { id: 'preferences', done: d('preferences'), optional: true, action: { kind: 'preferences' } },
    { id: 'createPolicy', done: d('createPolicy'), optional: false, action: { kind: 'link', href: '/policies/new' } },
    { id: 'runPolicy', done: d('runPolicy'), optional: false, action: { kind: 'link', href: '/policies' } },
    { id: 'joinTeam', done: d('joinTeam'), optional: false, action: { kind: 'link', href: '/teams' } },
    { id: 'submitApproval', done: d('submitApproval'), optional: false, action: { kind: 'link', href: '/policies' } },
    { id: 'connectGuard', done: d('connectGuard'), optional: true, action: { kind: 'docs', slug: 'how-to/guard' } },
  ];
}

function renderCard(items: GettingStartedItem[], { isAdmin = false, userId = 'u1' } = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <GettingStartedCard userId={userId} isAdmin={isAdmin} items={items} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  refresh.mockReset();
  openDocs.mockReset();
});
// fetch 间谍在用例间可能沿用同一实例，先清掉调用记录，断言只看本用例的请求
beforeEach(() => {
  if (vi.isMockFunction(globalThis.fetch)) vi.mocked(globalThis.fetch).mockClear();
});

describe('GettingStartedCard', () => {
  it('shows a regular user their own steps with progress over required items only', () => {
    renderCard(regularItems({ createPolicy: true }));
    expect(screen.getByRole('heading', { name: 'Get started with Aster' })).toBeTruthy();
    expect(screen.getByText('1 of 4 done')).toBeTruthy();
    expect(screen.getByText('Run a policy')).toBeTruthy();
    expect(screen.getByText('Invite a teammate or join a team')).toBeTruthy();
    expect(screen.getByText('Submit a version for approval')).toBeTruthy();
    expect(screen.getByTestId('getting-started-createPolicy').getAttribute('data-done')).toBe('true');
    // 偏好与 Guard 标为可选
    expect(within(screen.getByTestId('getting-started-preferences')).getByText('Optional')).toBeTruthy();
    expect(within(screen.getByTestId('getting-started-connectGuard')).getByText('Optional')).toBeTruthy();
  });

  it('hides once every required step is done, even with optional steps left', () => {
    const { container } = renderCard(regularItems({ createPolicy: true, runPolicy: true, joinTeam: true, submitApproval: true }));
    expect(container.textContent).toBe('');
  });

  it('dismissal is stored per user and survives a remount', () => {
    const first = renderCard(regularItems());
    fireEvent.click(screen.getByRole('button', { name: 'Hide this checklist' }));
    expect(first.container.textContent).toBe('');
    expect(window.localStorage.getItem('aster.gettingStarted.dismissed.u1')).toBe('1');
    cleanup();
    expect(renderCard(regularItems()).container.textContent).toBe('');
    cleanup();
    // 同一浏览器的另一个账号不受影响
    expect(renderCard(regularItems(), { userId: 'u2' }).container.textContent).not.toBe('');
  });

  it('the legacy admin dismissal keeps admins dismissed but does not hide it for regular users', () => {
    window.localStorage.setItem('aster.admin.launchpad.dismissed', '1');
    const admin: GettingStartedItem[] = [
      { id: 'createPolicy', done: false, optional: false, action: { kind: 'link', href: '/policies/new' } },
    ];
    expect(renderCard(admin, { isAdmin: true }).container.textContent).toBe('');
    cleanup();
    expect(renderCard(regularItems()).container.textContent).toContain('Get started with Aster');
  });

  it('the folded-in preference step saves industry and goals and ticks itself off', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"success":true}', { status: 200 }));
    renderCard(regularItems());
    const toggle = screen.getByRole('button', { name: 'Choose' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    // 未选行业：就地提示，不发保存请求
    fireEvent.click(save);
    expect(screen.getByRole('alert').textContent).toBe('Choose an industry first.');
    expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Insurance' }));
    fireEvent.click(screen.getByRole('button', { name: 'Compliance reporting' }));
    expect(screen.getByRole('button', { name: 'Insurance' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(save);

    await waitFor(() => expect(screen.getByTestId('getting-started-preferences').getAttribute('data-done')).toBe('true'));
    expect(fetchMock).toHaveBeenCalledWith('/api/user/onboarding', expect.objectContaining({ method: 'POST' }));
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    const body = JSON.parse((post![1] as RequestInit).body as string);
    expect(body).toEqual({ useCase: 'insurance', goals: ['compliance'] });
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByTestId('getting-started-preferences-form')).toBeNull();
  });

  it('changing saved preferences starts from the saved values, so goals are not wiped', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
      init?.method === 'POST'
        ? new Response('{"success":true}', { status: 200 })
        : new Response(JSON.stringify({ useCase: 'legal', goals: ['pii', 'team'] }), { status: 200 }),
    );
    renderCard(regularItems({ preferences: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Legal' }).getAttribute('aria-pressed')).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'POST')).toBe(true));
    const post = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST');
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({ useCase: 'legal', goals: ['pii', 'team'] });
  });

  it('when saved preferences cannot be read, changing them is refused instead of overwriting', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 503 }));
    renderCard(regularItems({ preferences: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await screen.findByText(/Could not load your saved choices/);
    fireEvent.click(screen.getByRole('button', { name: 'Legal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });

  it('a failed preference save shows an error and keeps the form open', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));
    renderCard(regularItems());
    fireEvent.click(screen.getByRole('button', { name: 'Choose' }));
    fireEvent.click(screen.getByRole('button', { name: 'Legal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Could not save your choices. Try again.');
    expect(screen.getByTestId('getting-started-preferences').getAttribute('data-done')).toBe('false');
  });

  it('the Guard step opens its guide in the docs overlay and keeps a real href', () => {
    renderCard(regularItems());
    const link = screen.getByRole('link', { name: /Read the guide/ });
    expect(link.getAttribute('href')).toBe('/docs/how-to/guard');
    fireEvent.click(link);
    expect(openDocs).toHaveBeenCalledWith('how-to/guard');
  });

  it('platform admins keep the admin copy', () => {
    const admin: GettingStartedItem[] = [
      { id: 'createPolicy', done: false, optional: false, action: { kind: 'link', href: '/policies/new' } },
      { id: 'addApiKey', done: false, optional: false, action: { kind: 'link', href: '/settings/api-keys' } },
    ];
    renderCard(admin, { isAdmin: true });
    expect(screen.getByRole('heading', { name: 'Set Aster up in 60 seconds' })).toBeTruthy();
    expect(screen.getByText('Issue an API key')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Manage API keys' }).getAttribute('href')).toBe('/settings/api-keys');
  });
});
