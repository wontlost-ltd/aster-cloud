/*
 * 审批输入面板（ADR 0042 §12 D10）：展开时才拉取；$pii 与 unknown 徽标、来源徽标、横幅与状态文案；
 * 「显示原值」只对持所需角色且有已声明 @pii 字段的可用视图出现，且须先确认。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));
vi.mock('@/components/ui', () => ({
  Alert: ({ children, ...rest }: { children: React.ReactNode; 'data-testid'?: string }) => (
    <div role="alert" data-testid={rest['data-testid']}>{children}</div>
  ),
  Badge: ({ children, title, ...rest }: { children: React.ReactNode; title?: string; 'data-testid'?: string }) => (
    <span title={title} data-testid={rest['data-testid']}>{children}</span>
  ),
  Button: ({ children, variant: _v, size: _s, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button {...rest}>{children}</button>
  ),
}));

import { ApprovalInputPanel } from './approval-input-panel';
import type { GuardApprovalInput } from '@/services/policy/guard-types';

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function fail(status: number, body: unknown) {
  return { ok: false, status, json: async () => body };
}

const VIEW: GuardApprovalInput = {
  approvalId: 'a1',
  decisionId: 'd1',
  contextHash: 'c'.repeat(64),
  status: 'available',
  marksSource: 'evaluation',
  inputBinding: 'evaluated',
  maskRules: 'v1',
  revealed: false,
  revealedByMe: false,
  inputSnapshotHash: 'h'.repeat(64),
  input: {
    principal: { id: 'agent-7' },
    context: {
      applicant: {
        amount: 250000,
        email: { $pii: { level: 'L2', category: 'email' } },
        extra: { $pii: { level: 'unknown' } },
      },
    },
  },
  piiMarks: [{ path: 'context.applicant.email', level: 'L2', category: 'email', source: 'ir' }],
  inputSources: { verified: ['context.applicant.amount'], factIssuers: ['cloud#k1'], factSources: ['context.applicant.amount=fixture.creditPilot'] },
};

function renderPanel(view: unknown, canReveal = true, onViewLoaded = vi.fn()) {
  fetchMock.mockResolvedValueOnce(ok(view));
  render(<ApprovalInputPanel tenantId="team1" approvalId="a1" canReveal={canReveal} onViewLoaded={onViewLoaded} />);
  return onViewLoaded;
}

describe('ApprovalInputPanel', () => {
  it('rendersMaskedBadgeWithLevelAndCategory：GET 当前审批的输入，$pii 显示级别 + 类别，视图交给收件箱', async () => {
    const onViewLoaded = renderPanel(VIEW);
    const badge = await screen.findByTestId('pii-masked');
    expect(badge.textContent).toBe('input.badge.pii:{"level":"L2","category":"email"}');
    expect(fetchMock).toHaveBeenCalledWith('/api/approvals/team1/a1/input');
    expect(onViewLoaded).toHaveBeenCalledWith(VIEW);
    expect(screen.getByText('250000')).toBeTruthy();
  });

  it('unknownShowsNotVisibleBadge', async () => {
    renderPanel(VIEW);
    expect((await screen.findByTestId('pii-unknown')).textContent).toBe('input.badge.unknown');
  });

  it('verifiedLeafShowsSourceBadgeWithFactSource：已验证叶子悬停显示 factSources 条目，其余为自报', async () => {
    renderPanel(VIEW);
    const verified = await screen.findByTestId('source-verified');
    expect(verified.getAttribute('title')).toBe('context.applicant.amount=fixture.creditPilot');
    expect(screen.getAllByTestId('source-declared').length).toBeGreaterThan(0);
  });

  it('unboundBanner / marksSourceNoneBanner / factsStaleBanner', async () => {
    renderPanel({ ...VIEW, inputBinding: 'unbound', marksSource: 'none', factsStale: true });
    expect(await screen.findByTestId('banner-unbound')).toBeTruthy();
    expect(screen.getByTestId('banner-marks-none')).toBeTruthy();
    expect(screen.getByTestId('banner-facts-stale')).toBeTruthy();
  });

  it('statusTexts：四种不可用状态显示对应文案，不渲染输入，也不显示解除按钮', async () => {
    for (const status of ['unavailable', 'purged', 'integrity_failed', 'too_large'] as const) {
      renderPanel({ approvalId: 'a1', decisionId: 'd1', status, maskRules: 'v1', revealed: false, revealedByMe: false });
      expect((await screen.findByTestId('input-status')).textContent).toBe(`input.status.${status}`);
      expect(screen.queryByText('input.reveal')).toBeNull();
      cleanup();
    }
  });

  it('取不到视图（旧 api / 网络错误）：显示不可用并交 null，收件箱照常审批', async () => {
    fetchMock.mockResolvedValueOnce(fail(502, { error: 'upstream_unavailable' }));
    const onViewLoaded = vi.fn();
    render(<ApprovalInputPanel tenantId="team1" approvalId="a1" canReveal onViewLoaded={onViewLoaded} />);
    expect((await screen.findByTestId('input-status')).textContent).toBe('input.status.unavailable');
    expect(onViewLoaded).toHaveBeenCalledWith(null);
  });

  it('revealButtonHiddenWithoutRole', async () => {
    renderPanel(VIEW, false);
    await screen.findByTestId('pii-masked');
    expect(screen.queryByText('input.reveal')).toBeNull();
  });

  it('revealButtonHiddenWhenNoDeclaredPii', async () => {
    renderPanel({ ...VIEW, piiMarks: [] });
    await screen.findByTestId('approval-input-panel');
    expect(screen.queryByText('input.reveal')).toBeNull();
  });

  it('revealRequiresConfirm：先确认再 POST 解除；成功后展示解除视图并交给收件箱', async () => {
    const onViewLoaded = renderPanel(VIEW);
    fireEvent.click(await screen.findByText('input.reveal'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('input.revealConfirm')).toBeTruthy();

    const revealed = {
      ...VIEW, revealed: true, revealedByMe: true, inputSnapshotHash: 'r'.repeat(64),
      input: { context: { applicant: { amount: 250000, email: 'a@b.cc' } } },
    };
    fetchMock.mockResolvedValueOnce(ok(revealed));
    fireEvent.click(screen.getByText('input.revealConfirmButton'));
    await waitFor(() => expect(screen.getByText('a@b.cc')).toBeTruthy());
    expect(fetchMock).toHaveBeenLastCalledWith('/api/approvals/team1/a1/input/reveal', { method: 'POST' });
    expect(onViewLoaded).toHaveBeenLastCalledWith(revealed);
    expect(screen.getByTestId('banner-revealed')).toBeTruthy();
    expect(screen.queryByText('input.reveal')).toBeNull();
  });

  it('解除失败：按错误码显示文案，不显示原值', async () => {
    renderPanel(VIEW);
    for (const code of ['reveal_not_permitted', 'receipt_unavailable', 'something_else']) {
      fireEvent.click(await screen.findByText('input.reveal'));
      fetchMock.mockResolvedValueOnce(fail(code === 'reveal_not_permitted' ? 403 : 503, { error: code }));
      fireEvent.click(screen.getByText('input.revealConfirmButton'));
      const expected = code === 'something_else' ? 'input.errors.generic' : `input.errors.${code}`;
      await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
      fireEvent.click(screen.getByText('cancel'));
    }
  });
});
