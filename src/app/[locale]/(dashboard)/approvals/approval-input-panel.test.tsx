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
  Alert: ({ children, variant, ...rest }: { children: React.ReactNode; variant?: string; 'data-testid'?: string }) => (
    <div role="alert" data-variant={variant} data-testid={rest['data-testid']}>{children}</div>
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
import { FACT_TTL_MS } from '@/services/guard/fact-signer';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';

/** 在 demoPage 补充文案树里找出 `input.banner.factsStale`（各 locale 的挂载层级一致，不写死父键）。 */
function findFactsStale(tree: unknown): string | undefined {
  if (!tree || typeof tree !== 'object') return undefined;
  const node = tree as Record<string, unknown>;
  const banner = (node.input as { banner?: { factsStale?: string } } | undefined)?.banner;
  if (banner?.factsStale) return banner.factsStale;
  for (const child of Object.values(node)) {
    const found = findFactsStale(child);
    if (found) return found;
  }
  return undefined;
}

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
    const stale = screen.getByTestId('banner-facts-stale');
    expect(stale.getAttribute('data-variant')).toBe('info');
    expect(stale.textContent).toBe('input.banner.factsStale');
    expect(screen.getByTestId('banner-unbound').getAttribute('data-variant')).toBe('warning');
  });

  it('factsStale 文案：四个 locale 都说明事实已过期但不影响批准，且分钟数与 FACT_TTL_MS 一致', () => {
    const minutes = String(FACT_TTL_MS / 60_000);
    // 各语言的关键语义：已过期 / 不影响批准 / 吊销则已自动拒绝
    const keyPhrases = {
      en: ['expired', "doesn't affect whether you can approve", 'rejected automatically'],
      zh: ['已过期', '不影响你是否可以批准', '自动拒绝'],
      de: ['abgelaufen', 'keinen Einfluss darauf, ob Sie genehmigen können', 'automatisch abgelehnt'],
      hi: ['समाप्त हो चुके हैं', 'कोई असर नहीं पड़ता', 'अपने-आप अस्वीकृत'],
    } as const;
    for (const locale of ['en', 'zh', 'de', 'hi'] as const) {
      const text = findFactsStale(DEMO_SUPPLEMENT[locale]);
      expect(text, locale).toBeTruthy();
      expect(text, locale).toContain(minutes);
      for (const phrase of keyPhrases[locale]) expect(text, `${locale}: ${phrase}`).toContain(phrase);
    }
    expect(findFactsStale(DEMO_SUPPLEMENT.en)).toBe(
      "The signed facts were verified when this decision was made (valid for 10 minutes) and have since expired. This doesn't affect whether you can approve. If the issuer had been revoked, this request would have been rejected automatically.",
    );
  });

  it('statusTexts：四种不可用状态显示对应文案，不渲染输入，也不显示解除按钮', async () => {
    for (const status of ['unavailable', 'purged', 'integrity_failed', 'too_large'] as const) {
      renderPanel({ approvalId: 'a1', decisionId: 'd1', status, maskRules: 'v1', revealed: false, revealedByMe: false });
      expect((await screen.findByTestId('input-status')).textContent).toBe(`input.status.${status}`);
      expect(screen.queryByText('input.reveal')).toBeNull();
      cleanup();
    }
  });

  it('非临时错误（如 403 / 404 未知码）：显示不可用并交 null，收件箱照常审批（ADR 0042 §12 D10）', async () => {
    fetchMock.mockResolvedValueOnce(fail(403, { error: 'forbidden' }));
    const onViewLoaded = vi.fn();
    render(<ApprovalInputPanel tenantId="team1" approvalId="a1" canReveal onViewLoaded={onViewLoaded} />);
    expect((await screen.findByTestId('input-status')).textContent).toBe('input.status.unavailable');
    expect(onViewLoaded).toHaveBeenLastCalledWith(null);
  });

  it('临时失败（502 / 网络错误）：显示重试，不交视图（批准 / 拒绝保持禁用）；重试成功后交视图', async () => {
    fetchMock.mockResolvedValueOnce(fail(502, { error: 'upstream_unavailable' }));
    const onViewLoaded = vi.fn();
    render(<ApprovalInputPanel tenantId="team1" approvalId="a1" canReveal onViewLoaded={onViewLoaded} />);
    await screen.findByTestId('input-failed');
    expect(onViewLoaded.mock.calls.every(([v]) => v === undefined)).toBe(true);

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fireEvent.click(screen.getByText('input.retry'));
    await screen.findByTestId('input-failed');

    fetchMock.mockResolvedValueOnce(ok(VIEW));
    fireEvent.click(screen.getByText('input.retry'));
    await screen.findByTestId('pii-masked');
    expect(onViewLoaded).toHaveBeenLastCalledWith(VIEW);
  });

  it('只有 unknown 占位、没有可解除的 @pii 值时不提供「显示原值」', async () => {
    renderPanel({ ...VIEW, input: { context: { applicant: { extra: { $pii: { level: 'unknown' } } } } } });
    await screen.findByTestId('pii-unknown');
    expect(screen.queryByText('input.reveal')).toBeNull();
  });

  it('解除时 input_not_available：视图作废并重新拉取（期间交 undefined）', async () => {
    const onViewLoaded = renderPanel(VIEW);
    fireEvent.click(await screen.findByText('input.reveal'));
    fetchMock.mockResolvedValueOnce(fail(409, { error: 'input_not_available' }));
    const purged = { approvalId: 'a1', decisionId: 'd1', status: 'purged', maskRules: 'v1', revealed: false, revealedByMe: false };
    fetchMock.mockResolvedValueOnce(ok(purged));
    fireEvent.click(screen.getByText('input.revealConfirmButton'));
    await waitFor(() => expect(onViewLoaded).toHaveBeenLastCalledWith(purged));
    expect(onViewLoaded).toHaveBeenCalledWith(undefined);
    expect(fetchMock).toHaveBeenCalledTimes(3);
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

  // aster-api#460 生产缺陷：本人已解除后面板重新挂载（收起再展开、刷新页面），GET 只回打码视图，
  // 收件箱随之提交打码哈希，审批被记为 inputRevealed=false，而链上已有本人的解除记录
  it('restoresOwnRevealOnRemount：GET 视图 revealedByMe 时自动取回本人的解除视图（幂等，不再入链），交给收件箱', async () => {
    const revealed = {
      ...VIEW, revealed: true, revealedByMe: true, inputSnapshotHash: 'r'.repeat(64),
      input: { context: { applicant: { amount: 250000, email: 'a@b.cc' } } },
    };
    fetchMock.mockResolvedValueOnce(ok({ ...VIEW, revealedByMe: true }));
    fetchMock.mockResolvedValueOnce(ok(revealed));
    const onViewLoaded = vi.fn();
    render(<ApprovalInputPanel tenantId="team1" approvalId="a1" canReveal onViewLoaded={onViewLoaded} />);
    await waitFor(() => expect(screen.getByText('a@b.cc')).toBeTruthy());
    expect(fetchMock).toHaveBeenLastCalledWith('/api/approvals/team1/a1/input/reveal', { method: 'POST' });
    // 打码视图不得先交给收件箱，否则此间点批准会提交打码哈希
    expect(onViewLoaded).toHaveBeenCalledTimes(1);
    expect(onViewLoaded).toHaveBeenCalledWith(revealed);
    expect(screen.getByTestId('banner-revealed')).toBeTruthy();
  });

  it('restoreOwnReveal 临时失败：显示重试、不交视图（批准保持禁用）', async () => {
    fetchMock.mockResolvedValueOnce(ok({ ...VIEW, revealedByMe: true }));
    fetchMock.mockResolvedValueOnce(fail(503, { error: 'upstream_unavailable' }));
    const onViewLoaded = vi.fn();
    render(<ApprovalInputPanel tenantId="team1" approvalId="a1" canReveal onViewLoaded={onViewLoaded} />);
    await screen.findByTestId('input-failed');
    expect(onViewLoaded).not.toHaveBeenCalled();
  });

  it('restoreOwnReveal 非临时失败（如审批已不再待审）：退回打码视图并提示', async () => {
    const masked = { ...VIEW, revealedByMe: true };
    fetchMock.mockResolvedValueOnce(ok(masked));
    fetchMock.mockResolvedValueOnce(fail(403, { error: 'reveal_not_permitted' }));
    const onViewLoaded = vi.fn();
    render(<ApprovalInputPanel tenantId="team1" approvalId="a1" canReveal onViewLoaded={onViewLoaded} />);
    await screen.findByText('input.errors.reveal_not_permitted');
    expect(onViewLoaded).toHaveBeenCalledWith(masked);
  });

  it('无解除权限时 revealedByMe 不触发自动取回', async () => {
    renderPanel({ ...VIEW, revealedByMe: true }, false);
    await screen.findByTestId('pii-masked');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('revealHintAboveInput：可解除时在输入树之前给出提示与按钮，说明打码字段数与留痕', async () => {
    renderPanel(VIEW);
    const hint = await screen.findByTestId('reveal-hint');
    expect(hint.textContent).toContain('input.revealHint:{"count":1}');
    const panel = screen.getByTestId('approval-input-panel');
    const tree = panel.querySelector('ul');
    // 提示在输入树之前（DOM 顺序），不再埋在长输入树的末尾
    expect(hint.compareDocumentPosition(tree as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
