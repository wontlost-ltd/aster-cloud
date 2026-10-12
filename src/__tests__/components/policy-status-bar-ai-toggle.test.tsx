import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));

import { StatusBar } from '@/components/policy/policy-form/status-bar';
import { AiInlineCompletionToggle } from '@/app/[locale]/(dashboard)/settings/settings-client';
import {
  AI_INLINE_COMPLETION_KEY,
  aiInlineCompletionPreference,
  useAiInlineCompletion,
} from '@/lib/preferences/ai-inline-completion';

/**
 * 状态栏与设置页两个入口：按钮语义、hydrating 期间禁用、两处共用同一份偏好。
 */

const baseProps = { content: '', cnlLocale: 'zh', isDirty: false, lastSavedAt: 0 };

/** 与 policy-form 相同的接法：状态栏读写共享偏好。 */
function WiredStatusBar() {
  const ai = useAiInlineCompletion();
  return (
    <StatusBar
      {...baseProps}
      aiCompletion={{ enabled: ai.value, hydrating: ai.hydrating, onToggle: () => ai.setValue(!ai.value) }}
    />
  );
}

beforeEach(() => {
  window.localStorage.clear();
  aiInlineCompletionPreference.write(true);
  window.localStorage.removeItem(AI_INLINE_COMPLETION_KEY);
});

describe('状态栏 AI 补全开关', () => {
  it('不传 aiCompletion 时不渲染开关', () => {
    render(<StatusBar {...baseProps} />);
    expect(screen.queryByTestId('status-ai-completion-toggle')).toBeNull();
  });

  it('switch 语义与文案跟随 enabled', () => {
    const { rerender } = render(
      <StatusBar {...baseProps} aiCompletion={{ enabled: true, hydrating: false, onToggle: () => {} }} />,
    );
    const btn = screen.getByTestId('status-ai-completion-toggle');
    expect(btn.getAttribute('role')).toBe('switch');
    expect(btn.getAttribute('aria-checked')).toBe('true');
    expect(btn.textContent).toContain('statusAiCompletionOn');
    rerender(<StatusBar {...baseProps} aiCompletion={{ enabled: false, hydrating: false, onToggle: () => {} }} />);
    expect(screen.getByTestId('status-ai-completion-toggle').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('status-ai-completion-toggle').textContent).toContain('statusAiCompletionOff');
  });

  it('hydrating 期间禁用，点击不触发', () => {
    const onToggle = vi.fn();
    render(<StatusBar {...baseProps} aiCompletion={{ enabled: true, hydrating: true, onToggle }} />);
    const btn = screen.getByTestId('status-ai-completion-toggle') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('★状态栏与设置页共用同一份偏好：一处关闭，另一处同步并持久化', () => {
    render(
      <>
        <WiredStatusBar />
        <AiInlineCompletionToggle ariaLabel="ai" enabledHint="on-hint" disabledHint="off-hint" />
      </>,
    );
    const status = screen.getByTestId('status-ai-completion-toggle');
    const settings = screen.getByTestId('settings-ai-completion-toggle');
    expect(status.getAttribute('aria-checked')).toBe('true');
    expect(settings.getAttribute('aria-checked')).toBe('true');

    act(() => settings.click());
    expect(settings.getAttribute('aria-checked')).toBe('false');
    expect(status.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('off-hint')).toBeTruthy();
    expect(window.localStorage.getItem(AI_INLINE_COMPLETION_KEY)).toBe('false');

    act(() => status.click());
    expect(settings.getAttribute('aria-checked')).toBe('true');
    expect(window.localStorage.getItem(AI_INLINE_COMPLETION_KEY)).toBe('true');
  });
});
