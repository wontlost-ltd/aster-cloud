// AI 熔断器页（F18）：状态取值与 API 对齐（不再显示 "—"），并提供带确认的手动熔断。
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';

const { useApiMock, mutate } = vi.hoisted(() => ({ useApiMock: vi.fn(), mutate: vi.fn() }));
vi.mock('@/lib/api', () => ({ useApi: useApiMock }));

import { CircuitBreakerContent } from '@/app/[locale]/(dashboard)/admin/ai-circuit-breaker/circuit-breaker-content';

const pkgEn = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../../../node_modules/@aster-cloud/ui-messages/en-US.json'),
    'utf8',
  ),
);
const messages = deepMergeMessages(pkgEn, DEMO_SUPPLEMENT.en);
const en = messages as {
  settings: { aiCircuitBreakerPage: Record<string, string> };
};
const L = en.settings.aiCircuitBreakerPage;

function renderWith(state: string, banState: string, manual = false) {
  useApiMock.mockReturnValue({
    data: {
      today_cents: 100,
      today_usd: '1.00',
      state,
      ban_state: banState,
      manual,
      thresholds: { free_stop_usd: 200, trial_stop_usd: 500 },
    },
    error: undefined,
    isLoading: false,
    mutate,
  });
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CircuitBreakerContent />
    </NextIntlClientProvider>,
  );
}

// jsdom 未实现 <dialog>.showModal/close（ConfirmDialog 依赖）：补最小桩，只切换 open 属性。
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('CircuitBreakerContent', () => {
  it('★closed 显示「允许调用」状态，而不是 "—"', () => {
    renderWith('closed', 'closed');
    expect(screen.getByText(L.stateOpen)).toBeDefined();
    expect(screen.queryByText('—')).toBeNull();
  });

  it('手动熔断生效时显示对应档位与「手动」说明', () => {
    renderWith('free_trial_stopped', 'free_trial_stopped', true);
    expect(screen.getByText(L.stateClosedTrial)).toBeDefined();
    expect(screen.getByText(L.manualNote)).toBeDefined();
  });

  it('★手动熔断需确认后才 POST trip', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, affected: 2 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderWith('closed', 'closed');
    fireEvent.click(screen.getByRole('button', { name: L.trip }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: L.tripConfirmAction }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ action: 'trip' });
    await waitFor(() => expect(mutate).toHaveBeenCalled());
  });

  it('没有生效的熔断时「解除」不可用', () => {
    renderWith('closed', 'closed');
    const releaseButtons = screen.getAllByRole('button', { name: L.release });
    expect(releaseButtons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });
});
