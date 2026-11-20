/*
 * 孤儿行（ADR 0061 §3.5 / §3.6，计划 T6 / T7）：上报方文本惰性渲染与折叠、确认信息、决策上下文的各状态
 * 与按 kind 的 404 措辞、无 decisionId 不请求、确认入口的显隐与 409 行内说明。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string, values?: Record<string, unknown>) => {
    const full = ns ? `${ns}.${key}` : key;
    return values ? `${full}:${JSON.stringify(values)}` : full;
  },
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

import { OrphanRow } from './orphan-row';
import type { DecisionContext } from '@/lib/guard-reconciliation/decision-context';
import type { OrphanItem } from '@/lib/guard-reconciliation/ui';

const DECISION_ID = '0b9c6f2e-6f1d-4c39-9d0a-4f1b8d2c7e11';
const fetchMock = vi.fn();

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function orphan(over: Partial<OrphanItem> = {}): OrphanItem {
  return {
    id: 7, kind: 'side_effect_mismatch', severity: 'critical', status: 'OPEN', executor: 'aster-guard-mcp',
    executorId: 'mcp@host-1', decisionId: DECISION_ID, detectedAt: '2026-11-20T08:00:00Z',
    detail: { effectId: 'eff-1', actionName: 'delete_customer_record', reason: 'hash_mismatch' },
    ...over,
  };
}

function ctx(over: Partial<DecisionContext> = {}): DecisionContext {
  return {
    decisionId: DECISION_ID,
    decision: {
      state: 'ok',
      value: {
        decisionId: DECISION_ID, effectiveOutcome: 'ALLOW', reasonCode: 'rule_allow',
        executionReceipt: { payload: { policyModule: 'guard.customer', policyFunction: 'decide' } },
        consumedBy: { attemptId: 'a-1', consumedAt: '2026-11-20T08:01:00Z', executorId: 'mcp@host-1' },
        result: { resultAt: '2026-11-20T08:02:00Z', status: 'succeeded' },
      },
    },
    chain: {
      state: 'ok',
      value: {
        decision: {
          auditId: 101, currentHash: 'h', prevHash: null, hashVersion: 3, eventType: 'ACTION_GUARD_DECISION',
          timestamp: '2026-11-20T08:00:00Z', metadata: {}, authoritativeConsumeAuditId: 102,
        },
        consumes: [
          { auditId: 102, currentHash: 'h2', decisionId: DECISION_ID, authoritative: true, attemptId: 'a-1', executorId: 'mcp@host-1', outcome: 'consumed' },
          { auditId: 104, currentHash: 'h4', decisionId: DECISION_ID, authoritative: false, attemptId: 'a-2', executorId: '<i>x</i>', outcome: 'receipt_consumed' },
        ],
        results: [
          { auditId: 103, currentHash: 'h3', decisionId: DECISION_ID, authoritative: true, attemptId: 'a-1', executorId: 'mcp@host-1', status: 'succeeded' },
        ],
        approvals: [{
          auditId: 99, decisionId: DECISION_ID, outcome: 'APPROVED', decidedBy: 'u-2', requiredRole: 'DPO', comment: null,
          decidedAt: '2026-11-20T07:59:00Z', currentHash: 'h0', decisionReceiptHash: null, inputSnapshotHash: null,
          inputSnapshotMatched: null, inputRevealed: null, inputStatus: null,
        }],
      },
    },
    execution: { policyId: 'pol-1', executionId: 'exec-1' },
    approvalLink: { status: 'APPROVED' },
    ...over,
  };
}

function renderRow(o: OrphanItem = orphan(), canAck = true) {
  const onAckResult = vi.fn();
  render(
    <table><tbody>
      <OrphanRow orphan={o} tenantId="team-1" canAck={canAck} locale="en" onAckResult={onAckResult} />
    </tbody></table>,
  );
  return { onAckResult };
}

function expand() {
  fireEvent.click(screen.getByRole('button', { name: 'guardReconciliation.expand' }));
}

beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('OrphanRow', () => {
  it('行：severity 徽章、kind 名称与字面量、UTC 检出时间、执行方、状态；决策上下文展开前不请求', () => {
    renderRow();
    const row = within(screen.getByTestId('orphan-7'));
    expect(row.getByText('guardReconciliation.severity.critical')).toBeTruthy();
    expect(row.getByText('guardReconciliation.kinds.side_effect_mismatch.name')).toBeTruthy();
    expect(row.getByText('side_effect_mismatch')).toBeTruthy();
    expect(row.getByText(/UTC$/)).toBeTruthy();
    expect(row.getByText('aster-guard-mcp')).toBeTruthy();
    expect(row.getByText('guardReconciliation.status.OPEN')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('decision context ok：结论、原因码、策略地址、consumedBy、结果、链事件、执行链接与审批链接', async () => {
    fetchMock.mockResolvedValueOnce(json(200, ctx()));
    renderRow();
    expand();
    const panel = within(await screen.findByTestId('decision-ok'));
    expect(fetchMock).toHaveBeenCalledWith(`/api/guard-reconciliation/team-1/decisions/${DECISION_ID}`, expect.anything());
    expect(panel.getByText('ALLOW')).toBeTruthy();
    expect(panel.getByText('rule_allow')).toBeTruthy();
    expect(panel.getByText('guard.customer.decide')).toBeTruthy();
    expect(panel.getByText('mcp@host-1')).toBeTruthy();
    expect(panel.getByText(/^succeeded · /)).toBeTruthy();
    expect(screen.getByTestId('chain-ok').textContent).toContain('ACTION_GUARD_DECISION · #101');
    // 链上 consume 尝试 / 结果 / 审批逐条列出，权威那条带标记；执行方 id 按纯文本
    const consumes = screen.getByTestId('chain-consumes').querySelectorAll('li');
    expect(consumes).toHaveLength(2);
    expect(consumes[0].textContent).toBe('#102 · consumed · a-1 · mcp@host-1guardReconciliation.decision.authoritative');
    expect(consumes[1].textContent).toBe('#104 · receipt_consumed · a-2 · <i>x</i>');
    expect(document.querySelector('i')).toBeNull();
    expect(screen.getByTestId('chain-results').textContent).toContain('#103 · succeeded · a-1');
    expect(screen.getByTestId('chain-approvals').textContent).toMatch(/^#99 · APPROVED · .* UTC$/);
    expect(screen.getByTestId('execution-link').getAttribute('href')).toBe('/policies/pol-1/logs');
    expect(screen.getByTestId('approval-link').getAttribute('href')).toBe(`/approvals?status=APPROVED&decisionId=${DECISION_ID}`);
  });

  it.each([
    ['orphan_receipt', 'guardReconciliation.decision.notFound.orphan_receipt'],
    ['side_effect_without_decision', 'guardReconciliation.decision.notFound.side_effect_without_decision'],
    ['side_effect_unconsumed', 'guardReconciliation.decision.notFound.other'],
  ] as const)('decision not_found 按 kind 措辞：%s', async (kind, text) => {
    fetchMock.mockResolvedValueOnce(json(200, ctx({ decision: { state: 'not_found' }, execution: null, approvalLink: null })));
    renderRow(orphan({ kind }));
    expand();
    expect((await screen.findByTestId('decision-not-found')).textContent).toBe(text);
    // orphan_receipt 的典型形状：决策 404 但链事件照常显示
    expect(screen.getByTestId('chain-ok')).toBeTruthy();
    expect(screen.queryByTestId('execution-link')).toBeNull();
  });

  it('decision / chain unavailable：分别说明并给重试；整体请求失败显示可重试错误', async () => {
    fetchMock.mockResolvedValueOnce(json(200, ctx({ decision: { state: 'unavailable' }, chain: { state: 'unavailable' }, execution: null, approvalLink: null })));
    renderRow();
    expand();
    expect(await screen.findByTestId('decision-unavailable')).toBeTruthy();
    expect(screen.getByTestId('chain-unavailable')).toBeTruthy();
    fetchMock.mockResolvedValueOnce(json(502, { error: 'upstream_unavailable' }));
    fireEvent.click(screen.getByRole('button', { name: 'guardReconciliation.decision.retry' }));
    expect(await screen.findByTestId('decision-context-failed')).toBeTruthy();
    fetchMock.mockResolvedValueOnce(json(200, ctx()));
    fireEvent.click(screen.getByRole('button', { name: 'guardReconciliation.decision.retry' }));
    expect(await screen.findByTestId('decision-ok')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('无 decisionId：说明「上报未带决策 id」且不请求决策上下文', () => {
    renderRow(orphan({ kind: 'side_effect_without_decision', decisionId: undefined }));
    expand();
    expect(screen.getByTestId('no-decision-id').textContent).toBe('guardReconciliation.decision.noDecisionId');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders reporter text inertly：注入的标签、javascript: 资源 id 与 10 KB 字符串都作纯文本，长值折叠可展开', () => {
    const huge = 'A'.repeat(10 * 1024);
    renderRow(orphan({
      decisionId: undefined,
      executor: '<b>exec</b>',
      detail: { actionName: '<img src=x onerror=alert(1)>', resourceId: 'javascript:alert(1)', source: huge, nested: { a: 1 } },
    }));
    expand();
    const details = screen.getByTestId('orphan-details-7');
    expect(details.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(details.textContent).toContain('javascript:alert(1)');
    expect(details.textContent).toContain('{"a":1}');
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
    expect([...document.querySelectorAll('a')].some((a) => (a.getAttribute('href') ?? '').includes('javascript:'))).toBe(false);
    // 折叠：只显示前 256 字符，展开后完整
    expect(details.textContent).not.toContain(huge);
    expect(details.textContent).toContain(`${'A'.repeat(256)}…`);
    fireEvent.click(within(details).getByRole('button', { name: 'guardReconciliation.showAll' }));
    expect(screen.getByTestId('orphan-details-7').textContent).toContain(huge);
    // 已知 detail 键用本地化字段名，未知键原样
    expect(within(details).getByText('guardReconciliation.detailFields.actionName')).toBeTruthy();
    expect(within(details).getByText('nested')).toBeTruthy();
  });

  it('确认信息：确认人资料、说明、关闭时间与解除方式；离队成员显示未知用户', () => {
    renderRow(orphan({
      status: 'ACKNOWLEDGED', decisionId: undefined, acknowledgedBy: 'u-1', ackComment: 'known old SDK',
      acknowledgedByUser: { name: 'Ada Admin', email: 'ada@example.com', image: null },
      resolvedAt: '2026-11-20T09:00:00Z', resolution: 'acknowledged',
    }));
    expand();
    const info = within(screen.getByTestId('ack-info'));
    expect(info.getByText('Ada Admin')).toBeTruthy();
    expect(info.getByText('ada@example.com')).toBeTruthy();
    expect(info.getByText('known old SDK')).toBeTruthy();
    expect(info.getByText(/guardReconciliation\.resolution\.acknowledged/)).toBeTruthy();
    cleanup();
    renderRow(orphan({ status: 'ACKNOWLEDGED', decisionId: undefined, acknowledgedBy: 'u-gone', acknowledgedByUser: null }));
    expand();
    expect(within(screen.getByTestId('ack-info')).getByText('guardReconciliation.unknownUser')).toBeTruthy();
  });

  it('tenant without canAck shows no ack button；非 OPEN 行也不显示', () => {
    renderRow(orphan(), false);
    expect(screen.queryByRole('button', { name: 'guardReconciliation.ack.button' })).toBeNull();
    cleanup();
    renderRow(orphan({ status: 'RESOLVED' }), true);
    expect(screen.queryByRole('button', { name: 'guardReconciliation.ack.button' })).toBeNull();
  });

  it('409 not_open：行内说明当前状态并交给列表更新该行', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(url.includes('/ack')
      ? json(409, { error: 'not_open', status: 'RESOLVED' })
      : json(200, ctx())));
    const { onAckResult } = renderRow();
    fireEvent.click(screen.getByRole('button', { name: 'guardReconciliation.ack.button' }));
    fireEvent.change(screen.getByLabelText('guardReconciliation.ack.commentLabel'), { target: { value: 'checked' } });
    fireEvent.click(screen.getByRole('button', { name: 'guardReconciliation.ack.submit' }));
    await waitFor(() => expect(onAckResult).toHaveBeenCalledWith(7, { kind: 'not_open', status: 'RESOLVED' }));
    expect(screen.getByTestId('ack-not-open').textContent)
      .toBe('guardReconciliation.ack.notOpen:{"status":"guardReconciliation.status.RESOLVED"}');
    expect(screen.queryByTestId('ack-dialog-7')).toBeNull();
  });
});
