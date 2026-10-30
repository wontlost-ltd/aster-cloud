/**
 * 注册页对 409 email_already_registered 的处理（#682）：此前后端对已注册邮箱返回同形 200，
 * 页面显示「账号已就绪」却没有建号。现在后端明确 409，页面给出本地化提示与登录 / 重置密码入口，
 * 且不进入「账号已就绪」状态。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('next-auth/react', () => ({ signIn: vi.fn() }));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
  useLocale: () => 'en',
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

import { SignupContent } from '@/app/[locale]/(auth)/signup/signup-content';

/** 已注册提示下方的「登录」入口（与「忘记密码」同一行） */
function loginLinkHref(): string | null {
  const row = screen.getByText('forgotPassword').closest('a')?.parentElement;
  return row?.querySelector('a')?.getAttribute('href') ?? null;
}

function submit(email: string) {
  fireEvent.change(screen.getByLabelText('emailLabel'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('passwordLabel'), { target: { value: 'longenough1' } });
  fireEvent.click(screen.getByRole('button', { name: 'createAccount' }));
}

describe('SignupContent — 邮箱已注册', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('精确地址已注册：提示已注册并给出登录与重置密码入口，不显示「账号已就绪」', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'x', code: 'email_already_registered', alias: false }),
    });
    render(<SignupContent />);
    submit('a@example.com');

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('errors.emailAlreadyRegistered'));
    expect(screen.getByText('forgotPassword').closest('a')?.getAttribute('href')).toBe('/forgot-password');
    expect(screen.queryByText('checkEmailTitle')).toBeNull();
  });

  it('+别名与既有账号同一邮箱：提示别名已注册', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'x', code: 'email_already_registered', alias: true }),
    });
    render(<SignupContent />);
    submit('a+team@example.com');

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('errors.emailAliasRegistered'));
    expect(screen.queryByText('checkEmailTitle')).toBeNull();
  });

  it('+别名对 +别名：提示里给出已有账号地址的掩码（#682）', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'x', code: 'email_already_registered', alias: true, existingAccountHint: 'r***+adr…@wontlost.com' }),
    });
    render(<SignupContent />);
    submit('ryan.pang+member@wontlost.com');

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('errors.emailAliasRegisteredAs:{"hint":"r***+adr…@wontlost.com"}'),
    );
  });

  it('从邀请深链来注册：已注册时「登录」入口带回 callbackUrl；站外地址不带', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'x', code: 'email_already_registered', alias: false }),
    });
    render(<SignupContent returnTo="/en/teams/invite?token=abc" />);
    submit('a@example.com');
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(loginLinkHref()).toBe(
      `/login?callbackUrl=${encodeURIComponent('/en/teams/invite?token=abc')}`,
    );
    cleanup();

    render(<SignupContent returnTo="//evil.example/x" />);
    submit('a@example.com');
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(loginLinkHref()).toBe('/login');
  });

  it('新账号：进入「账号已就绪」状态', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    render(<SignupContent />);
    submit('new@example.com');

    await waitFor(() => expect(screen.getByText('checkEmailTitle')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
