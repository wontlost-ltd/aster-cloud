/*
 * 签发方设置面板（ADR 0040 §11 D3；ADR 0046 §11.7 裁定 4、14）：团队设置页与个人设置子页共用。
 * 自取 GET /api/fact-issuers/[tenantId]，按 canManage 决定是否渲染写操作；
 * 「启用 Aster Cloud 签发方」只在平台密钥可用且本租户尚未登记同一 issuer#kid 时出现；吊销须二次确认。
 */
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  useLocale: () => 'en',
}));

import { FactIssuersPanel } from '@/components/guard/fact-issuers-panel';

const CLOUD = { issuer: 'aster-cloud', kid: 'k-2026-11', publicKey: 'c'.repeat(43) };
const OWNER_ID = '784d38c4-f433-4369-b4dc-ab0f4f0cc2b9';
const EXTERNAL = {
  alg: 'Ed25519', createdAt: '2026-11-01T00:00:00Z', createdBy: OWNER_ID, enabled: true,
  createdByUser: { name: 'Olivia Owner', email: 'owner@example.com', image: null },
  issuer: 'idp.example.com', kid: '2026-11', notAfter: '2027-01-01T00:00:00Z', publicKey: 'e'.repeat(43),
};
const REVOKED = { ...EXTERNAL, kid: '2026-10', enabled: false, notAfter: undefined };

const fetchMock = vi.fn();

function listResponse(over: Partial<{ issuers: unknown[]; cloudIssuer: unknown; canManage: boolean }> = {}) {
  return new Response(JSON.stringify({ issuers: [EXTERNAL, REVOKED], cloudIssuer: CLOUD, canManage: true, ...over }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function calls(method: string) {
  return fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === method);
}

// jsdom 未实现 <dialog>.showModal/close（ConfirmDialog 依赖）：补最小桩，只切换 open 属性。
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('FactIssuersPanel', () => {
  it('rendersIssuersAndStatus：列出 issuer、kid、状态、notAfter 与创建人', async () => {
    fetchMock.mockResolvedValueOnce(listResponse());
    render(<FactIssuersPanel tenantId="team1" />);

    const row = await screen.findByTestId('fact-issuer-idp.example.com#2026-11');
    expect(fetchMock).toHaveBeenCalledWith('/api/fact-issuers/team1', expect.anything());
    expect(row.textContent).toContain('idp.example.com');
    expect(row.textContent).toContain('2026-11');
    expect(row.textContent).toContain('statusEnabled');
    expect(row.textContent).toContain('01/01/2027');
    expect(row.textContent).toContain('Olivia Owner');
    expect(row.textContent).toContain('owner@example.com');
    expect(row.innerHTML).not.toContain(OWNER_ID);

    const revoked = screen.getByTestId('fact-issuer-idp.example.com#2026-10');
    expect(revoked.textContent).toContain('statusRevoked');
    expect(revoked.textContent).toContain('noExpiry');
    // 已吊销的不再提供吊销按钮
    expect(within(revoked).queryByRole('button', { name: 'revoke' })).toBeNull();
  });

  it('登记人：无姓名显示邮箱；查不到（已删除 / anonymous）显示 unknownUser，任何情况都不显示原始 id', async () => {
    fetchMock.mockResolvedValueOnce(listResponse({
      issuers: [
        { ...EXTERNAL, kid: 'a', createdByUser: { name: null, email: 'mail-only@example.com', image: null } },
        { ...EXTERNAL, kid: 'b', createdByUser: null },
        { ...EXTERNAL, kid: 'c', createdBy: 'anonymous', createdByUser: null },
        { ...EXTERNAL, kid: 'd', createdByUser: undefined },
      ],
    }));
    const { container } = render(<FactIssuersPanel tenantId="team1" />);
    const a = await screen.findByTestId('fact-issuer-idp.example.com#a');
    expect(a.textContent).toContain('mail-only@example.com');
    for (const kid of ['b', 'c', 'd']) {
      expect(screen.getByTestId(`fact-issuer-idp.example.com#${kid}`).textContent).toContain('unknownUser');
    }
    expect(container.innerHTML).not.toContain(OWNER_ID);
    expect(container.innerHTML).not.toContain('anonymous');
  });

  it('enableCloudIssuerPutsConfiguredPublicKey：PUT 平台签发方的 issuer / kid 与公钥，成功后重新拉取', async () => {
    fetchMock
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(json(200, { ...CLOUD, alg: 'Ed25519', enabled: true, createdAt: 'x', createdBy: 'u' }))
      .mockResolvedValueOnce(listResponse({ issuers: [EXTERNAL, { ...CLOUD, alg: 'Ed25519', enabled: true, createdAt: '2026-11-13T00:00:00Z', createdBy: 'u' }] }));
    render(<FactIssuersPanel tenantId="team1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'enableCloud' }));
    await waitFor(() => expect(calls('PUT')).toHaveLength(1));
    const [url, init] = calls('PUT')[0] as [string, RequestInit];
    expect(url).toBe('/api/fact-issuers/team1/aster-cloud/k-2026-11');
    expect(JSON.parse(init.body as string)).toEqual({ publicKey: CLOUD.publicKey });

    await screen.findByTestId('fact-issuer-aster-cloud#k-2026-11');
    expect(screen.queryByRole('button', { name: 'enableCloud' })).toBeNull();
  });

  it('enableButtonHiddenWhenAlreadyRegistered：同 issuer#kid 已登记（含已吊销）或平台密钥不可用 → 不显示', async () => {
    fetchMock.mockResolvedValueOnce(listResponse({ issuers: [{ ...CLOUD, alg: 'Ed25519', enabled: false, createdAt: 'x', createdBy: 'u' }] }));
    render(<FactIssuersPanel tenantId="team1" />);
    await screen.findByTestId('fact-issuer-aster-cloud#k-2026-11');
    expect(screen.queryByRole('button', { name: 'enableCloud' })).toBeNull();
    cleanup();

    fetchMock.mockResolvedValueOnce(listResponse({ cloudIssuer: null }));
    render(<FactIssuersPanel tenantId="team1" />);
    await screen.findByTestId('fact-issuer-idp.example.com#2026-11');
    expect(screen.queryByRole('button', { name: 'enableCloud' })).toBeNull();
    expect(screen.getByText('cloudUnavailable')).toBeTruthy();
  });

  it('viewerSeesNoWriteControls：canManage=false 时无启用、登记与吊销控件', async () => {
    fetchMock.mockResolvedValueOnce(listResponse({ canManage: false }));
    render(<FactIssuersPanel tenantId="team1" />);
    await screen.findByTestId('fact-issuer-idp.example.com#2026-11');

    expect(screen.queryByRole('button', { name: 'enableCloud' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'revoke' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'register' })).toBeNull();
    expect(screen.queryByLabelText('publicKeyLabel')).toBeNull();
    expect(screen.getByText('readOnlyHint')).toBeTruthy();
  });

  it('revokeRequiresConfirm：点吊销先弹确认（说明不可恢复与自动拒绝），取消不发请求，确认才 DELETE', async () => {
    fetchMock.mockResolvedValueOnce(listResponse());
    render(<FactIssuersPanel tenantId="team1" />);
    const row = await screen.findByTestId('fact-issuer-idp.example.com#2026-11');

    fireEvent.click(within(row).getByRole('button', { name: 'revoke' }));
    expect(await screen.findByText(/revokeConfirmBody/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(calls('DELETE')).toHaveLength(0);

    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(listResponse({ issuers: [{ ...EXTERNAL, enabled: false }, REVOKED] }));
    fireEvent.click(within(row).getByRole('button', { name: 'revoke' }));
    fireEvent.click(await screen.findByRole('button', { name: 'revokeConfirm' }));
    await waitFor(() => expect(calls('DELETE')).toHaveLength(1));
    expect(calls('DELETE')[0][0]).toBe('/api/fact-issuers/team1/idp.example.com/2026-11');
    await waitFor(() =>
      expect(screen.getByTestId('fact-issuer-idp.example.com#2026-11').textContent).toContain('statusRevoked'),
    );
  });

  it('吊销 503 receipt_unavailable → 显示可重试的本地化文案', async () => {
    fetchMock.mockResolvedValueOnce(listResponse());
    render(<FactIssuersPanel tenantId="team1" />);
    const row = await screen.findByTestId('fact-issuer-idp.example.com#2026-11');
    fetchMock
      .mockResolvedValueOnce(json(503, { error: 'receipt_unavailable', message: 'x', retryable: true }))
      .mockResolvedValueOnce(listResponse());
    fireEvent.click(within(row).getByRole('button', { name: 'revoke' }));
    fireEvent.click(await screen.findByRole('button', { name: 'revokeConfirm' }));
    expect(await screen.findByText('errors.receipt_unavailable')).toBeTruthy();
  });

  it('登记外部签发方：提交 issuer / kid / publicKey / notAfter（UTC 当日结束）', async () => {
    fetchMock.mockResolvedValueOnce(listResponse()).mockResolvedValueOnce(json(200, EXTERNAL)).mockResolvedValueOnce(listResponse());
    render(<FactIssuersPanel tenantId="team1" />);
    fireEvent.change(await screen.findByLabelText('issuerLabel'), { target: { value: ' partner.example ' } });
    fireEvent.change(screen.getByLabelText('kidLabel'), { target: { value: 'k1' } });
    fireEvent.change(screen.getByLabelText('publicKeyLabel'), { target: { value: 'p'.repeat(43) } });
    fireEvent.change(screen.getByLabelText('notAfterLabel'), { target: { value: '2027-06-30' } });
    fireEvent.click(screen.getByRole('button', { name: 'register' }));

    await waitFor(() => expect(calls('PUT')).toHaveLength(1));
    const [url, init] = calls('PUT')[0] as [string, RequestInit];
    expect(url).toBe('/api/fact-issuers/team1/partner.example/k1');
    expect(JSON.parse(init.body as string)).toEqual({ publicKey: 'p'.repeat(43), notAfter: '2027-06-30T23:59:59Z' });
  });

  it('conflictShowsLocalizedMessage：409 issuer_key_conflict → 本地化文案，不显示 api 原文', async () => {
    fetchMock.mockResolvedValueOnce(listResponse()).mockResolvedValueOnce(
      json(409, { error: 'issuer_key_conflict', message: 'This key id is already registered with a different public key.' }),
    );
    render(<FactIssuersPanel tenantId="team1" />);
    fireEvent.change(await screen.findByLabelText('issuerLabel'), { target: { value: 'idp.example.com' } });
    fireEvent.change(screen.getByLabelText('kidLabel'), { target: { value: '2026-11' } });
    fireEvent.change(screen.getByLabelText('publicKeyLabel'), { target: { value: 'p'.repeat(43) } });
    fireEvent.click(screen.getByRole('button', { name: 'register' }));

    expect(await screen.findByText('errors.issuer_key_conflict')).toBeTruthy();
    expect(screen.queryByText(/already registered/)).toBeNull();
  });

  it('列表加载失败 → 显示 loadFailed', async () => {
    fetchMock.mockResolvedValueOnce(json(502, { error: 'upstream_unavailable' }));
    render(<FactIssuersPanel tenantId="team1" />);
    expect(await screen.findByText('loadFailed')).toBeTruthy();
  });
});
