// ADR 0058 §4.6 / §4.10：团队设置页的「结构化编写座位」卡片。fetch 全部桩掉，断言座位计数、名单、请求载荷与错误文案。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { locales } from '@/i18n/config';
import { StructuredAuthoringSeatsCard } from '@/components/teams/structured-authoring-seats-card';

type Messages = Record<string, string | Record<string, string>>;
const seatsMessages = (locale: (typeof locales)[number]) =>
  (DEMO_SUPPLEMENT[locale].teams as { structuredAuthoringSeats: Messages }).structuredAuthoringSeats;
// 顶层文案（字符串）与 errors 子表分开取，便于按类型直接用作查询文本
const L = seatsMessages('en') as unknown as Record<string, string> & { errors: Record<string, string> };

const API = '/api/teams/t-1/capabilities/structured_authoring/grants';

const GRANTS = {
  allotment: { seatCap: 3, ownerGrantingEnabled: true },
  seatsUsed: 2,
  delegations: [
    { grantId: 'g-a', userId: 'u-a', email: 'alice@x.io', name: 'Alice', role: 'member', grantedAt: '2026-11-17T00:00:00.000Z' },
    { grantId: 'g-v', userId: 'u-v', email: 'vic@x.io', name: null, role: 'viewer', grantedAt: '2026-11-17T00:00:00.000Z' },
  ],
};
const MEMBERS = {
  members: [
    { id: 'm-o', userId: 'u-o', role: 'owner', user: { name: 'Olive', email: 'olive@x.io' } },
    { id: 'm-a', userId: 'u-a', role: 'member', user: { name: 'Alice', email: 'alice@x.io' } },
    { id: 'm-b', userId: 'u-b', role: 'admin', user: { name: 'Bob', email: 'bob@x.io' } },
    { id: 'm-v', userId: 'u-v', role: 'viewer', user: { name: null, email: 'vic@x.io' } },
    { id: 'm-w', userId: 'u-w', role: 'viewer', user: { name: 'Walt', email: 'walt@x.io' } },
  ],
  currentUserId: 'u-o',
};

const json = (status: number, body: unknown) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

let fetchMock: ReturnType<typeof vi.fn>;
type Handler = (url: string, init?: RequestInit) => Promise<Response>;

const defaultHandler: Handler = (url) => json(200, url.includes('/members') ? MEMBERS : GRANTS);

function setup(locale: (typeof locales)[number] = 'en', handler: Handler = defaultHandler) {
  fetchMock = vi.fn(handler);
  vi.stubGlobal('fetch', fetchMock);
  return render(
    <NextIntlClientProvider locale={locale} messages={DEMO_SUPPLEMENT[locale]}>
      <StructuredAuthoringSeatsCard teamId="t-1" />
    </NextIntlClientProvider>,
  );
}

const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET');

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StructuredAuthoringSeatsCard', () => {
  it.each([
    ['en', 'Structured Authoring'],
    ['zh', '结构化编写'],
    ['de', 'Strukturiertes Verfassen'],
    ['hi', 'संरचित लेखन'],
  ] as const)('%s 标题含产品名 %s', async (locale, product) => {
    setup(locale);
    const heading = await screen.findByRole('heading', { level: 2 });
    expect(heading.textContent).toContain(product);
  });

  it('四种语言都提供全部文案键', () => {
    const keysOf = (m: Messages) =>
      Object.entries(m)
        .flatMap(([k, v]) => (typeof v === 'string' ? [k] : Object.keys(v).map((sub) => `${k}.${sub}`)))
        .sort();
    for (const locale of locales) expect(keysOf(seatsMessages(locale)), locale).toEqual(keysOf(L));
  });

  it('显示「已用 n / seatCap」与委派名单；viewer 的委派标记为暂停', async () => {
    setup();
    expect(await screen.findByText(L.seatsUsed.replace('{used}', '2').replace('{cap}', '3'))).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('vic@x.io')).toBeTruthy();
    expect(screen.getAllByText(L.paused)).toHaveLength(1);
  });

  it('可委派的人 = 非 viewer 且尚未委派的成员', async () => {
    setup();
    const select = (await screen.findByLabelText(L.memberLabel)) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBeGreaterThan(0));
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['u-o', 'u-b']);
  });

  it('委派：POST { userId } 后重新拉取', async () => {
    setup();
    const select = (await screen.findByLabelText(L.memberLabel)) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    fireEvent.change(select, { target: { value: 'u-b' } });
    fireEvent.click(screen.getByRole('button', { name: L.delegate }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const [url, init] = writes()[0];
    expect(url).toBe(API);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ userId: 'u-b' });
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => u === API).length).toBeGreaterThanOrEqual(3));
  });

  it('seat_cap_reached → 显示座位已满文案', async () => {
    setup('en', (url, init) =>
      init?.method === 'POST' ? json(409, { error: 'seat_cap_reached', code: 'seat_cap_reached' }) : defaultHandler(url),
    );
    const select = (await screen.findByLabelText(L.memberLabel)) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: L.delegate }));
    expect((await screen.findByRole('alert')).textContent).toBe(L.errors.seatCapReached);
  });

  it('撤销：DELETE { grantId }', async () => {
    setup();
    await screen.findByText('Alice');
    fireEvent.click(screen.getByRole('button', { name: L.revokeFor.replace('{name}', 'Alice') }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const [url, init] = writes()[0];
    expect(url).toBe(API);
    expect(init?.method).toBe('DELETE');
    expect(JSON.parse(String(init?.body))).toEqual({ grantId: 'g-a' });
  });

  it('没有额度行 → 显示「未分配座位」，不出现委派按钮', async () => {
    setup('en', (url) =>
      json(200, url.includes('/members') ? MEMBERS : { allotment: null, seatsUsed: 0, delegations: [] }),
    );
    expect(await screen.findByText(L.noAllotment)).toBeTruthy();
    expect(screen.queryByRole('button', { name: L.delegate })).toBeNull();
  });

  it('额度存在但 ownerGrantingEnabled=false → 显示已暂停委派', async () => {
    setup('en', (url) =>
      json(
        200,
        url.includes('/members') ? MEMBERS : { ...GRANTS, allotment: { seatCap: 3, ownerGrantingEnabled: false } },
      ),
    );
    expect(await screen.findByText(L.delegationDisabled)).toBeTruthy();
    expect(screen.queryByRole('button', { name: L.delegate })).toBeNull();
  });
});
