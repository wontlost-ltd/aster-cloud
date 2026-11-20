/*
 * 确认对话框（ADR 0061 §3.3，计划 T7）：说明去首尾空白后 1–1000 字符才可提交；不可撤销警示；
 * 可自动解除的类别额外提示；结果（成功 / 409 not_open / 403）交给调用方，其余错误按码本地化留在对话框内。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

import { AckDialog } from './ack-dialog';
import type { GuardOrphan } from '@/services/policy/guard-types';

const fetchMock = vi.fn();

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function orphan(over: Partial<GuardOrphan> = {}): GuardOrphan {
  return {
    id: 42, kind: 'side_effect_mismatch', severity: 'critical', status: 'OPEN', executor: 'aster-guard-mcp',
    detectedAt: '2026-11-20T08:00:00Z', detail: {}, ...over,
  };
}

function setup(o: GuardOrphan = orphan()) {
  const onDone = vi.fn();
  const onCancel = vi.fn();
  render(<AckDialog tenantId="team-1" orphan={o} onDone={onDone} onCancel={onCancel} />);
  const textarea = screen.getByLabelText('commentLabel') as HTMLTextAreaElement;
  const submit = screen.getByRole('button', { name: 'submit' }) as HTMLButtonElement;
  return { onDone, onCancel, textarea, submit };
}

beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('AckDialog', () => {
  it('submit disabled for blank and 1001 chars；1000 字符（去空白后）可提交，计数显示去空白后的长度', () => {
    const { textarea, submit } = setup();
    expect(submit.disabled).toBe(true);
    fireEvent.change(textarea, { target: { value: '   \n  ' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(textarea, { target: { value: 'x'.repeat(1001) } });
    expect(submit.disabled).toBe(true);
    expect(screen.getByTestId('ack-counter').textContent).toBe('counter:{"count":1001,"max":1000}');
    fireEvent.change(textarea, { target: { value: `  ${'x'.repeat(1000)}  ` } });
    expect(submit.disabled).toBe(false);
    expect(screen.getByTestId('ack-counter').textContent).toBe('counter:{"count":1000,"max":1000}');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('总是显示不可撤销警示', () => {
    setup();
    expect(screen.getByText('irreversible')).toBeTruthy();
  });

  it('auto-resolvable kinds show the hint（allow_unconsumed 有，side_effect_mismatch 无）', () => {
    setup(orphan({ kind: 'allow_unconsumed', severity: 'info' }));
    expect(screen.getByTestId('ack-auto-resolve-hint').textContent).toBe('autoResolveHint');
    cleanup();
    setup(orphan());
    expect(screen.queryByTestId('ack-auto-resolve-hint')).toBeNull();
  });

  it('成功：POST 去空白的说明到确认路由，把确认后的行交给调用方', async () => {
    const acked = orphan({ status: 'ACKNOWLEDGED', resolution: 'acknowledged', ackComment: 'checked' });
    fetchMock.mockResolvedValueOnce(json(200, acked));
    const { onDone, textarea, submit } = setup();
    fireEvent.change(textarea, { target: { value: '  checked  ' } });
    fireEvent.click(submit);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ kind: 'acknowledged', orphan: acked }));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/guard-reconciliation/team-1/orphans/42/ack');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ comment: 'checked' });
  });

  it('409 not_open：把响应里的当前状态交给调用方', async () => {
    fetchMock.mockResolvedValueOnce(json(409, { error: 'not_open', message: 'x', status: 'RESOLVED' }));
    const { onDone, textarea, submit } = setup();
    fireEvent.change(textarea, { target: { value: 'late' } });
    fireEvent.click(submit);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ kind: 'not_open', status: 'RESOLVED' }));
  });

  it('403（会话中被降级）：交给调用方隐藏确认入口', async () => {
    fetchMock.mockResolvedValueOnce(json(403, { error: 'forbidden', message: 'x' }));
    const { onDone, textarea, submit } = setup();
    fireEvent.change(textarea, { target: { value: 'demoted' } });
    fireEvent.click(submit);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ kind: 'forbidden' }));
  });

  it('502 留在对话框内：本地化错误 + requestId，不调用 onDone', async () => {
    fetchMock.mockResolvedValueOnce(json(502, { error: 'upstream_unavailable', message: 'x', requestId: 'req-1' }));
    const { onDone, textarea, submit } = setup();
    fireEvent.change(textarea, { target: { value: 'retry later' } });
    fireEvent.click(submit);
    expect(await screen.findByText('errors.upstream_unavailable')).toBeTruthy();
    expect(screen.getByText('requestId:{"id":"req-1"}')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    expect(submit.disabled).toBe(false);
  });

  it('未知错误码与网络异常显示通用文案', async () => {
    fetchMock.mockResolvedValueOnce(json(400, { error: 'something_else' }));
    const { textarea, submit } = setup();
    fireEvent.change(textarea, { target: { value: 'x' } });
    fireEvent.click(submit);
    expect(await screen.findByText('errors.generic')).toBeTruthy();
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    fireEvent.click(submit);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('errors.generic')).toBeTruthy();
  });

  it('取消调用 onCancel', () => {
    const { onCancel } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
