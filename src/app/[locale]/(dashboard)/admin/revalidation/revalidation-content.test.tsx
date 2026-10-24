/*
 * 策略重验页：启动确认必须走设计系统 ConfirmDialog，而不是浏览器原生 confirm()。
 * 锁住三点：点按钮只开对话框不发请求；确认后才 POST；取消不发请求。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('@/components/ui', () => ({
  Container: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
  Button: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
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

// postResult：POST /runs 的响应工厂，各用例按需覆盖（成功 / 409 / 500 / 抛错 / 挂起）。
let postResult: () => Promise<Response>;

beforeEach(() => {
  postResult = async () => new Response(JSON.stringify({ runId: 'r1', status: 'running' }), { status: 200 });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return postResult();
    if (String(url).includes('/runs/')) return new Response(JSON.stringify({ runId: 'r1', status: 'running' }), { status: 200 });
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  // 显式替换 window.confirm：若组件回退到原生确认，这里会被调用而被断言捕获。
  window.confirm = confirmSpy;
  window.localStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); confirmSpy.mockReset(); });

const postCalls = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
const openDialog = () => fireEvent.click(screen.getByRole('button', { name: 'startButton' }));
const confirmDialog = () => fireEvent.click(screen.getByRole('button', { name: 'confirm' }));

describe('RevalidationContent 启动确认', () => {
  it('点启动只打开对话框，不弹原生 confirm，也不发 POST', async () => {
    render(<RevalidationContent />);
    openDialog();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('data-variant')).toBe('warning');
    expect(dialog.getAttribute('data-loading')).toBe('false');
    expect(dialog.getAttribute('aria-label')).toBe('startButton');
    expect(screen.getByText('confirmStart')).toBeTruthy();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(postCalls().length).toBe(0);
  });

  it('请求挂起期间对话框处于 loading，且取消不生效', async () => {
    let settle!: (r: Response) => void;
    postResult = () => new Promise<Response>((resolve) => { settle = resolve; });
    render(<RevalidationContent />);
    openDialog();
    confirmDialog();
    await waitFor(() => expect(screen.getByRole('dialog').getAttribute('data-loading')).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    settle(new Response(JSON.stringify({ runId: 'r1' }), { status: 200 }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it.each([
    ['409 已在运行', async () => new Response('{}', { status: 409 }), 'alreadyRunning'],
    ['500 启动失败', async () => new Response('{}', { status: 500 }), 'startFailed'],
    ['fetch 抛错', async () => { throw new Error('offline'); }, 'startFailed'],
  ])('%s：给出提示、关闭对话框、清掉 loading', async (_name, result, expected) => {
    postResult = result;
    render(<RevalidationContent />);
    openDialog();
    confirmDialog();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(expected));
    expect(screen.queryByRole('dialog')).toBeNull();
    openDialog();
    expect(screen.getByRole('dialog').getAttribute('data-loading')).toBe('false');
  });

  it('确认后才 POST 启动，并关闭对话框', async () => {
    render(<RevalidationContent />);
    openDialog();
    confirmDialog();
    await waitFor(() => expect(postCalls().length).toBe(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('status').textContent).toBe('started');
    expect(window.localStorage.getItem('aster.admin.revalidation.recentRunId')).toBe('r1');
  });

  it('取消不发 POST', async () => {
    render(<RevalidationContent />);
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(postCalls().length).toBe(0);
  });
});
