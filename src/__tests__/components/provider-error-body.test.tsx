// provider 错误展示体：主文案 + provider 原话 + 设置入口按视图渲染。
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ProviderErrorBody } from '@/components/policy/provider-error-body';
import { providerErrorView } from '@/lib/provider-error';

afterEach(cleanup);
const t = (key: string, values?: Record<string, string>) => `${key}${values ? JSON.stringify(values) : ''}`;

describe('ProviderErrorBody', () => {
  it('bad_request：主文案 + provider 原话 + 指向 AI 密钥设置的链接', () => {
    const view = providerErrorView({ code: 'provider_bad_request', model: 'm', providerMessage: 'not scoped to a workspace' })!;
    render(<ProviderErrorBody view={view} t={t} href="/en/settings/ai-keys" />);
    expect(screen.getByText('errorProviderBadRequest')).toBeDefined();
    expect(screen.getByTestId('provider-error-detail').textContent).toBe('not scoped to a workspace');
    expect(screen.getByRole('link').getAttribute('href')).toBe('/en/settings/ai-keys');
  });

  it('限流：无链接、无原话行', () => {
    const view = providerErrorView({ code: 'provider_rate_limited', model: null, providerMessage: null })!;
    render(<ProviderErrorBody view={view} t={t} href="/en/settings/ai-keys" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByTestId('provider-error-detail')).toBeNull();
  });

  it('rejected_model 把 model 传给文案', () => {
    const view = providerErrorView({ code: 'provider_rejected_model', model: 'claude-x', providerMessage: null })!;
    render(<ProviderErrorBody view={view} t={t} href="/x" />);
    expect(screen.getByText('errorProviderRejectedModel{"model":"claude-x"}')).toBeDefined();
  });
});
