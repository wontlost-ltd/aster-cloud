import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import enBase from '@aster-cloud/ui-messages/en-US.json';
import { IntlClientProvider } from '@/i18n/intl-client-provider';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';
import { PolicyVersionList } from '@/components/policy/policy-version-list';
import { toast } from '@/components/ui';

const messages = deepMergeMessages(enBase as Record<string, unknown>, DEMO_SUPPLEMENT.en);
const version = {
  id: 'pv-1', version: 2, status: 'DRAFT' as const, isDefault: false, releaseNote: null,
  sourceHash: null, createdBy: 'user-1', createdAt: '2026-01-01T00:00:00Z',
  deprecatedAt: null, deprecatedBy: null, archivedAt: null, archivedBy: null,
};

function renderList(onSubmitForApproval: (id: string, note?: string) => Promise<void>) {
  return render(
    <IntlClientProvider locale="en" messages={messages as never}>
      <PolicyVersionList versions={[version]} onSubmitForApproval={onSubmitForApproval} />
    </IntlClientProvider>,
  );
}

afterEach(() => cleanup());

HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};

describe('版本提交发布说明', () => {
  it('将对话框说明传给提交回调', async () => {
    const submit = vi.fn(async () => {});
    renderList(submit);
    fireEvent.click(screen.getByText('Submit for approval'));
    fireEvent.change(screen.getByPlaceholderText('Add a release note (optional)'), { target: { value: 'Rate model revision' } });
    const buttons = screen.getAllByRole('button', { name: 'Submit for approval' });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(submit).toHaveBeenCalledWith('pv-1', 'Rate model revision'));
  });

  it('提交失败时显示本地化错误 toast', async () => {
    const errorToast = vi.spyOn(toast, 'error');
    renderList(async () => { throw new Error('Submission failed'); });
    fireEvent.click(screen.getByText('Submit for approval'));
    const buttons = screen.getAllByRole('button', { name: 'Submit for approval' });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(errorToast).toHaveBeenCalledWith('Something went wrong'));
    errorToast.mockRestore();
  });
});
