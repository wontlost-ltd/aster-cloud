// 单条词条表单的 domain / locale 格式校验（#612）：与服务端共用同一规则，提示走本地化文案。
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('lucide-react', async (orig) => ({ ...((await orig()) as Record<string, unknown>) }));
const t = vi.hoisted(() => (key: string) => key);
vi.mock('next-intl', () => ({ useTranslations: () => t }));

import { VocabularyDialog } from '@/app/[locale]/(dashboard)/domain-vocabularies/vocabulary-dialog';

function fill(id: string, value: string) {
  fireEvent.change(document.getElementById(id)!, { target: { value } });
}

async function submit(domain: string, locale: string) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<VocabularyDialog isOpen mode="create" onClose={vi.fn()} onSave={onSave} />);
  fill('vd-domain', domain);
  fill('vd-locale', locale);
  fill('vd-canonical', 'Loan');
  fill('vd-localized', 'Kredit');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
  });
  return onSave;
}

describe('VocabularyDialog — 格式校验（#612）', () => {
  it('domain 不是小写标识符时拦下并提示 domainInvalid', async () => {
    const onSave = await submit('E2E 1026', 'de');
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('domainInvalid')).toBeInTheDocument();
  });

  it('locale 不是 BCP-47 时拦下并提示 localeInvalid', async () => {
    const onSave = await submit('finance', 'xx_INVALID!!');
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('localeInvalid')).toBeInTheDocument();
  });

  it('合法输入提交规范大小写的 locale', async () => {
    const onSave = await submit('finance.loan', 'de-de');
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'finance.loan', locale: 'de-DE' }),
    );
  });
});
