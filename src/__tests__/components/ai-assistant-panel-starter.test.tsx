// AI 助手「生成」：编辑器里仍是未改动的入门模板时，按全新生成处理（不把入门模板当 existingSource）。
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { editor } from 'monaco-editor';

const h = vi.hoisted(() => ({ generate: vi.fn() }));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));
vi.mock('@/hooks/useAIAssistant', () => ({
  useAIAssistant: () => ({
    streaming: false,
    content: '',
    error: null,
    denial: null,
    errorDetail: null,
    validationError: null,
    completed: false,
    validated: false,
    repairProgress: null,
    generate: h.generate,
    suggest: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
  }),
}));
vi.mock('@/lib/mixpanel', () => ({ track: vi.fn(), Events: {} }));

import { AIAssistantPanel } from '@/components/policy/ai-assistant-panel';

const STARTER = 'Module starter.loan.\n';

function generateWith(editorValue: string, starterSource: string | null) {
  const ed = { getValue: () => editorValue } as unknown as editor.IStandaloneCodeEditor;
  render(
    <AIAssistantPanel editor={ed} locale="en-US" starterSource={starterSource} onApply={vi.fn()} onClose={vi.fn()} />,
  );
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'shipping fee rule' } });
  fireEvent.click(screen.getByText('generate'));
  return h.generate.mock.calls[0][0] as { existingSource?: string };
}

afterEach(() => {
  cleanup();
  h.generate.mockReset();
});

describe('AIAssistantPanel 生成与入门模板', () => {
  it('★编辑器内容就是未改动的入门模板 → 不带 existingSource', () => {
    expect(generateWith(STARTER, STARTER).existingSource).toBeUndefined();
  });

  it('入门模板被改过 → 照常带上当前源码', () => {
    expect(generateWith(`${STARTER}edited`, STARTER).existingSource).toBe(`${STARTER}edited`);
  });

  it('没有入门模板（编辑或深链）→ 照常带上当前源码', () => {
    expect(generateWith('Module a.\n', null).existingSource).toBe('Module a.\n');
  });
});
