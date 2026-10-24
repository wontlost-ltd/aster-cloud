/*
 * 策略重验页：发起必须「先预估影响面、再经设计系统 ConfirmDialog 确认」，不用浏览器原生 confirm()。
 * 锁住：点按钮只取预估不发 POST；对话框展示预估文案与模式；确认后才 POST 且带 scope/mode；
 * 租户范围要求租户 id；取消与失败路径收口。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => values ? `${key}:${JSON.stringify(values)}` : key,
}));
vi.mock('@/components/ui', () => ({
  Container: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
  Button: ({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) => (
    <button type="button" onClick={onClick} disabled={disabled}>{children}</button>
  ),
  Select: (props: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} />,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  ConfirmDialog: ({ isOpen, title, description, variant, isLoading, onConfirm, onCancel }: { isOpen: boolean; title: string; description: string; variant?: string; isLoading?: boolean; onConfirm: () => void; onCancel: () => void }) =>
    isOpen ? (
      <div role="dialog" data-variant={variant} data-loading={String(Boolean(isLoading))} aria-label={title}>
        <p>{description}</p>
        <button type="button" onClick={onCancel}>cancel</button>
        <button type="button" onClick={onConfirm}>confirm</button>
      </div>
    ) : null,
}));

import { RevalidationContent } from './revalidation-content';

const fetchMock = vi.fn();
const confirmSpy = vi.fn();
let postResult: () => Promise<Response>;
let previewResult: () => Promise<Response>;

beforeEach(() => {
  postResult = async () => new Response(JSON.stringify({ runId: 'r1', status: 'queued', mode: 'enforce' }), { status: 202 });
  previewResult = async () => new Response(JSON.stringify({ toolchainId: 'tc', total: 1234, batchSize: 50, intervalSeconds: 30, estimatedMinutes: 13 }), { status: 200 });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return postResult();
    if (String(url).includes('/preview')) return previewResult();
    if (String(url).includes('/runs/')) return new Response(JSON.stringify({ runId: 'r1', status: 'running' }), { status: 200 });
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  window.confirm = confirmSpy;
  window.localStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); confirmSpy.mockReset(); });

const postCalls = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
const previewCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/preview'));
const clickStart = () => fireEvent.click(screen.getByRole('button', { name: 'startButton' }));
const confirmDialog = () => fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
const dialog = () => screen.findByRole('dialog');

describe('RevalidationContent 发起流程', () => {
  it('显示重验范围说明，包括估算对象为零时', async () => {
    window.localStorage.setItem('aster.admin.revalidation.recentRunId', 'r0');
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/runs/r0')) return new Response(JSON.stringify({ runId: 'r0', status: 'done', checked: 0, total: 0 }), { status: 200 });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    render(<RevalidationContent />);
    expect(await screen.findByText('scopeExplanation')).toBeTruthy();
    expect(screen.getByText(/progress: 0\/0/)).toBeTruthy();
  });

  it('点启动先取预估、开对话框，不弹原生 confirm，也不发 POST', async () => {
    render(<RevalidationContent />);
    clickStart();
    const d = await dialog();
    expect(previewCalls().length).toBe(1);
    expect(String(previewCalls()[0][0])).toContain('scope=all');
    expect(d.getAttribute('data-variant')).toBe('warning');
    expect(d.textContent).toContain('confirmEnforce:');
    expect(d.textContent).toContain('"total":1234');
    expect(d.textContent).toContain('"minutes":13');
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(postCalls().length).toBe(0);
  });

  it('确认后 POST 带 scope/mode，并关闭对话框', async () => {
    render(<RevalidationContent />);
    clickStart();
    await dialog();
    confirmDialog();
    await waitFor(() => expect(postCalls().length).toBe(1));
    expect(JSON.parse(String((postCalls()[0][1] as RequestInit).body))).toEqual({ scope: 'all', mode: 'enforce' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('status').textContent).toBe('started');
    expect(window.localStorage.getItem('aster.admin.revalidation.recentRunId')).toBe('r1');
  });

  it('只报告模式：info 变体、report 确认文案、POST mode=report', async () => {
    render(<RevalidationContent />);
    fireEvent.change(screen.getByLabelText('modeLabel'), { target: { value: 'report' } });
    clickStart();
    const d = await dialog();
    expect(d.getAttribute('data-variant')).toBe('info');
    expect(d.textContent).toContain('confirmReport:');
    confirmDialog();
    await waitFor(() => expect(postCalls().length).toBe(1));
    expect(JSON.parse(String((postCalls()[0][1] as RequestInit).body))).toEqual({ scope: 'all', mode: 'report' });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('startedReport'));
  });

  it('租户范围：未填租户 id 不能发起；填了则预估与 POST 都带 trim 并 URL 编码后的 tenantId', async () => {
    render(<RevalidationContent />);
    fireEvent.change(screen.getByLabelText('scopeLabel'), { target: { value: 'tenant' } });
    expect((screen.getByRole('button', { name: 'startButton' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('tenantIdLabel'), { target: { value: ' a b&c?=1 ' } });
    clickStart();
    const d = await dialog();
    expect(String(previewCalls()[0][0])).toContain('scope=tenant&tenantId=a%20b%26c%3F%3D1');
    expect(d.textContent).toContain('"scope":"a b&c?=1"');
    confirmDialog();
    await waitFor(() => expect(postCalls().length).toBe(1));
    expect(JSON.parse(String((postCalls()[0][1] as RequestInit).body))).toEqual({ scope: 'tenant', mode: 'enforce', tenantId: 'a b&c?=1' });
  });

  it('预估等待与确认期间参数被锁定：确认用的是预估时的参数，不是改后的表单', async () => {
    let settle!: (r: Response) => void;
    previewResult = () => new Promise<Response>((resolve) => { settle = resolve; });
    render(<RevalidationContent />);
    clickStart();
    // 预估请求挂起时表单已禁用；即便强行改值，确认也不该读到它。
    expect((screen.getByLabelText('modeLabel') as HTMLSelectElement).disabled).toBe(true);
    settle(new Response(JSON.stringify({ toolchainId: 'tc', total: 5, batchSize: 50, intervalSeconds: 30, estimatedMinutes: 1 }), { status: 200 }));
    const d = await dialog();
    expect(d.textContent).toContain('confirmEnforce:');
    confirmDialog();
    await waitFor(() => expect(postCalls().length).toBe(1));
    expect(JSON.parse(String((postCalls()[0][1] as RequestInit).body))).toEqual({ scope: 'all', mode: 'enforce' });
  });

  it('最近 run 显示模式徽标与发起者', async () => {
    window.localStorage.setItem('aster.admin.revalidation.recentRunId', 'r9');
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/runs/r9')) return new Response(JSON.stringify({ runId: 'r9', status: 'done', mode: 'enforce', triggeredBy: 'admin:u1', checked: 3, total: 3, invalidCount: 1 }), { status: 200 });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    render(<RevalidationContent />);
    await waitFor(() => expect(screen.getByText(/modeEnforceBadge/)).toBeTruthy());
    expect(screen.getByText(/triggeredBy: admin:u1/)).toBeTruthy();
    expect(screen.getByText(/needsRepair: 1/)).toBeTruthy();
  });

  it('预估失败：提示并且不开对话框', async () => {
    previewResult = async () => new Response('{}', { status: 502 });
    render(<RevalidationContent />);
    clickStart();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('previewFailed:{"status":502}'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(postCalls().length).toBe(0);
  });

  it('取消不发 POST', async () => {
    render(<RevalidationContent />);
    clickStart();
    await dialog();
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(postCalls().length).toBe(0);
  });

  it.each([
    ['409 已在运行', async () => new Response('{}', { status: 409 }), 'alreadyRunning'],
    ['500 启动失败', async () => new Response('{}', { status: 500 }), 'startFailed:{"status":500}'],
    ['fetch 抛错', async () => { throw new Error('offline'); }, 'startFailed:{"status":0}'],
  ])('%s：给出提示、关闭对话框', async (_name, result, expected) => {
    postResult = result;
    render(<RevalidationContent />);
    clickStart();
    await dialog();
    confirmDialog();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(expected));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('无效列表区分参考与生效判定', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/invalid')) return new Response(JSON.stringify({ items: [
        { versionId: 7, advisory: true, diagnostics: [{ code: 'E012', message: 'x' }] },
        { versionId: 8, advisory: false, diagnostics: [] },
      ] }), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    render(<RevalidationContent />);
    await waitFor(() => expect(screen.getByText('verdictAdvisory')).toBeTruthy());
    expect(screen.getByText('verdictBinding')).toBeTruthy();
  });
});
