// AI 助手面板：无输出内容时，错误/拒绝/校验失败反馈仍必须可见。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const hookState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    `${key}${values ? JSON.stringify(values) : ''}`,
  useLocale: () => 'en',
}));
vi.mock('@/hooks/useAIAssistant', () => ({
  useAIAssistant: () => hookState.current,
}));
vi.mock('@/lib/mixpanel', () => ({ track: vi.fn(), Events: {} }));

import { AIAssistantPanel } from '@/components/policy/ai-assistant-panel';

const base = {
  streaming: false,
  content: '',
  error: null,
  denial: null,
  errorDetail: null,
  validationError: null,
  completed: false,
  validated: false,
  repairProgress: null,
  generate: vi.fn(),
  suggest: vi.fn(),
  cancel: vi.fn(),
  reset: vi.fn(),
};

function renderPanel(overrides: Record<string, unknown>) {
  hookState.current = { ...base, ...overrides };
  return render(
    <AIAssistantPanel editor={null} locale="en" onApply={vi.fn()} onClose={vi.fn()} />,
  );
}

beforeEach(() => {
  hookState.current = base;
});
afterEach(cleanup);

describe('AIAssistantPanel 无内容时的错误反馈', () => {
  it('provider 错误：错误框 + provider 原话 + 设置链接', () => {
    renderPanel({
      error: 'provider failed',
      completed: true,
      errorDetail: { code: 'provider_bad_request', model: 'm', providerMessage: 'not scoped to a workspace' },
    });
    expect(screen.getByText('errorProviderBadRequest')).toBeDefined();
    expect(screen.getByTestId('provider-error-detail').textContent).toBe('not scoped to a workspace');
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/en/settings/ai-keys');
  });

  it('denial（邮箱未验证）：本地化文案 + 验证链接', () => {
    renderPanel({
      error: 'HTTP 403',
      denial: { reason: 'ai_email_unverified' },
    });
    expect(screen.getByText(/errorEmailUnverified/)).toBeDefined();
    expect(screen.getByText('goVerifyEmail')).toBeDefined();
  });

  it('validationError（编译未通过）：校验失败提示可见', () => {
    renderPanel({ completed: true, validated: false, validationError: 'bad syntax' });
    expect(screen.getByText(/validationFailed: bad syntax/)).toBeDefined();
  });

  it('错误态不渲染空内容盒与应用按钮', () => {
    const { container } = renderPanel({
      error: 'provider failed',
      completed: true,
      errorDetail: { code: 'provider_bad_request', model: 'm', providerMessage: 'x' },
    });
    expect(container.querySelector('.max-h-64')).toBeNull();
    expect(screen.queryByText('apply')).toBeNull();
  });

  it('无错误、无内容、非流式：不渲染输出区', () => {
    const { container } = renderPanel({});
    expect(container.querySelector('.max-h-64')).toBeNull();
    expect(container.querySelector('.bg-red-50')).toBeNull();
    expect(container.querySelector('.bg-amber-50')).toBeNull();
  });
});
