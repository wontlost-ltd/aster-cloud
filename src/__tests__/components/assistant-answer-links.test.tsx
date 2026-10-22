// @vitest-environment jsdom
import { afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
import { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => 'zh',
}));

import { AssistantPanel } from '@/components/assistant/assistant-panel';
import { AssistantProvider, useAssistant } from '@/components/assistant/assistant-context';
import { registerAssistantAnswerProvider } from '@/lib/assistant/provider';

/** F28：答复中的 `[标题](href)` 渲染为真正的链接，而不是原样文本。 */

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => registerAssistantAnswerProvider(null));

const handle: { current: ReturnType<typeof useAssistant> } = { current: null };
function Controls() {
  const state = useAssistant();
  useEffect(() => {
    handle.current = state;
  });
  return null;
}

async function ask(answer: string) {
  registerAssistantAnswerProvider({
    id: 'fake',
    async *answer() {
      yield { delta: answer };
    },
  });
  render(
    <AssistantProvider>
      <Controls />
      <AssistantPanel />
    </AssistantProvider>,
  );
  act(() => {
    handle.current!.setEnabled(true);
    handle.current!.setOpen(true);
  });
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '如何创建 API 密钥？' } });
  fireEvent.submit(input.closest('form')!);
}

describe('助手答复中的链接', () => {
  it('★站内链接渲染为同标签页链接，不显示 Markdown 原文', async () => {
    await ask('请前往 [API 密钥](/zh/settings/api-keys) 创建。');
    const link = await screen.findByRole('link', { name: 'API 密钥' });
    expect(link.getAttribute('href')).toBe('/zh/settings/api-keys');
    expect(link.getAttribute('target')).toBeNull();
    expect(screen.queryByText(/\]\(/)).toBeNull();
  });

  it('站外链接新标签页打开并带 rel=noopener', async () => {
    await ask('参考 [语言指南](https://www.aster-lang.dev/zh/docs/guide)。');
    const link = await screen.findByRole('link', { name: '语言指南' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('★javascript: 链接不渲染为链接', async () => {
    await ask('点 [这里](javascript:alert(1)) 。');
    await waitFor(() => expect(screen.getByText(/点 这里/)).toBeTruthy());
    expect(screen.queryByRole('link', { name: '这里' })).toBeNull();
  });
});
