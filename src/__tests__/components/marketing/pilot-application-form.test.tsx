import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enPackage from '@aster-cloud/ui-messages/en-US.json';
import { deepMergeMessages } from '@/i18n/request';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import { PilotApplicationForm } from '@/components/marketing/solutions/pilot-application-form';

const messages = deepMergeMessages(enPackage as Record<string, unknown>, DEMO_SUPPLEMENT.en);
const fetchMock = vi.fn();

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PilotApplicationForm page="credit-decisions" locale="en" defaultUseCase="credit_decisions" />
    </NextIntlClientProvider>,
  );
}

function fillRequired() {
  fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'jane@bank.example' } });
  fireEvent.change(screen.getByLabelText('Company or organisation'), { target: { value: 'Bank' } });
  fireEvent.change(screen.getByLabelText('Your role'), { target: { value: 'credit_risk' } });
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '/solutions/credit-decisions?utm_source=newsletter&utm_campaign=a2');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('PilotApplicationForm', () => {
  it('提交表单字段、本页、语种与 UTM 归因；蜜罐为空', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 201 }));
    renderForm();
    fillRequired();
    fireEvent.click(screen.getByLabelText('Something else'));
    fireEvent.change(screen.getByLabelText('What is hardest about this today? (optional)'), { target: { value: 'Reasons drift' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /I agree that Aster/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply for a pilot' }));

    await waitFor(() => expect(screen.getByText('Application received')).toBeTruthy());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/pilot-applications');
    expect(JSON.parse(init.body)).toEqual({
      email: 'jane@bank.example',
      company: 'Bank',
      role: 'credit_risk',
      useCases: ['credit_decisions', 'other'],
      painPoint: 'Reasons drift',
      consent: true,
      page: 'credit-decisions',
      locale: 'en',
      attribution: { utmSource: 'newsletter', utmCampaign: 'a2' },
      website: '',
    });
  });

  it('蜜罐字段对辅助技术隐藏且不可 Tab 聚焦', () => {
    renderForm();
    const honeypot = document.getElementById('pilot-website') as HTMLInputElement;
    expect(honeypot.tabIndex).toBe(-1);
    expect(honeypot.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('未勾选同意 → 本地提示，不发请求', async () => {
    renderForm();
    fillRequired();
    fireEvent.submit(screen.getByRole('button', { name: 'Apply for a pilot' }).closest('form')!);
    expect(await screen.findByText('Please tick the consent box to continue.')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('服务端字段错误按字段本地化；429 显示限流提示', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_field', field: 'email' }), { status: 400 }));
    renderForm();
    fillRequired();
    fireEvent.click(screen.getByRole('checkbox', { name: /I agree that Aster/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply for a pilot' }));
    expect(await screen.findByText(/Enter a valid email address/)).toBeTruthy();

    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply for a pilot' }));
    expect(await screen.findByText(/Too many attempts/)).toBeTruthy();
  });
});
