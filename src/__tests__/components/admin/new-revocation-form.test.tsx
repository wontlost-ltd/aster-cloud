// 许可证撤销表单（Q2）：ID 不在已签发记录中时，确认框与演练结果都要醒目提示，但不阻止撤销。
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { NewRevocationForm } from '@/app/[locale]/(dashboard)/admin/license-revoke/components/new-revocation-form';

const pkgEn = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../../../node_modules/@aster-cloud/ui-messages/en-US.json'),
    'utf8',
  ),
);
const messages = deepMergeMessages(pkgEn, DEMO_SUPPLEMENT.en);
const F = (messages as { admin: { licenseRevoke: { newForm: Record<string, string> } } }).admin
  .licenseRevoke.newForm;
const LIC = 'lic_E2ETEST0000000000000000AB';

function setup(knownLicense: boolean) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    return new Response(
      JSON.stringify(
        body.dryRun
          ? { dryRun: true, licenseId: LIC, knownLicense }
          : { licenseId: LIC, publishedVersion: '7', knownLicense },
      ),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <NewRevocationForm />
    </NextIntlClientProvider>,
  );
  fireEvent.change(screen.getByLabelText(F.licenseIdLabel), { target: { value: LIC } });
  fireEvent.change(screen.getByLabelText(F.reasonLabel), { target: { value: 'fraud' } });
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('NewRevocationForm 未知许可证提示', () => {
  it('★真实撤销的确认框里显示提示，确认后仍会提交撤销', async () => {
    const fetchMock = setup(false);
    fireEvent.click(screen.getByRole('button', { name: F.submit }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(F.unknownLicenseWarning);
    // 预检只发 dryRun，不产生撤销
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).dryRun).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: F.confirmCta }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string).dryRun).toBe(false);
  });

  it('★演练完成后保留醒目提示', async () => {
    setup(false);
    fireEvent.click(screen.getByLabelText(F.dryRun));
    fireEvent.click(screen.getByRole('button', { name: F.submit }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: F.confirmCta }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('alert').textContent).toBe(F.unknownLicenseWarning);
  });

  it('已签发的许可证不提示', async () => {
    setup(true);
    fireEvent.click(screen.getByRole('button', { name: F.submit }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).not.toContain(F.unknownLicenseWarning);
  });
});
