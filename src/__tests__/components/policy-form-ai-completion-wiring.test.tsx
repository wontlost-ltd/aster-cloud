import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

/**
 * PolicyForm → MonacoPolicyEditor 的 enableAICompletion 接线。
 *
 * ★这是开关在生产中的唯一调用点。偏好存储、状态栏按钮、编辑器 provider 各自测得再好，
 *   若这里改回写死的 `enableAICompletion`，开关整体失效而其余测试全绿。
 *   本文件渲染真实的 PolicyForm 与 StatusBar，只把编辑器换成记录 props 的探针。
 */

const editorProps: Array<Record<string, unknown>> = [];

// next/dynamic：直接返回探针，跳过真实 Monaco 的异步加载
vi.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => (props: Record<string, unknown>) => {
    editorProps.push(props);
    return null;
  },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/zh/policies/new',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-intl', () => ({
  useTranslations: () => Object.assign((k: string) => k, { rich: (k: string) => k, raw: (k: string) => k, has: () => true }),
  useLocale: () => 'zh',
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
// 与本断言无关的重组件桩掉
vi.mock('@/components/policy/policy-form/side-panel', () => ({ SidePanel: () => null }));
vi.mock('@/components/policy/policy-form/editor-palette', () => ({ EditorPalette: () => null }));
vi.mock('@/components/policy/policy-form/editor-rail', () => ({ EditorRail: () => null }));
vi.mock('@/components/policy/cnl-syntax-converter-dialog', () => ({ CNLSyntaxConverterDialog: () => null }));
// jsdom 无 matchMedia；本断言只关心桌面布局
vi.mock('@/components/policy/policy-form/use-is-mobile', () => ({ useIsMobile: () => false }));

import { PolicyForm } from '@/components/policy/policy-form';
import { AI_INLINE_COMPLETION_KEY, aiInlineCompletionPreference } from '@/lib/preferences/ai-inline-completion';

function renderForm() {
  return render(
    <PolicyForm
      mode="create"
      uiLocale="zh"
      policyId={null}
      initial={{ name: '', description: '', content: '', isPublic: false, groupId: null, aliasSet: null }}
      title="t"
      subtitle="s"
      onSave={async () => ({ id: 'x' })}
      cancelHref="/zh/policies"
      detailHrefFor={(id) => `/zh/policies/${id}`}
      breadcrumbs={[]}
    />,
  );
}

const lastEnable = () => editorProps.at(-1)?.enableAICompletion;

beforeEach(() => {
  editorProps.length = 0;
  window.localStorage.clear();
});

describe('PolicyForm：AI 行内补全接线', () => {
  it('★默认开启：编辑器收到 enableAICompletion=true', async () => {
    renderForm();
    await waitFor(() => expect(lastEnable()).toBe(true));
  });

  it('★偏好为关闭：编辑器收到 false（写死 enableAICompletion 时变红）', async () => {
    window.localStorage.setItem(AI_INLINE_COMPLETION_KEY, 'false');
    renderForm();
    await waitFor(() => expect(editorProps.length).toBeGreaterThan(0));
    expect(editorProps.every((p) => p.enableAICompletion === false)).toBe(true);
  });

  it('★点击状态栏开关：编辑器收到的值随之切换', async () => {
    renderForm();
    await waitFor(() => expect(lastEnable()).toBe(true));
    const toggle = await screen.findByTestId('status-ai-completion-toggle');
    act(() => toggle.click());
    expect(lastEnable()).toBe(false);
    expect(window.localStorage.getItem(AI_INLINE_COMPLETION_KEY)).toBe('false');
    act(() => toggle.click());
    expect(lastEnable()).toBe(true);
  });

  it('★首帧（读取本地偏好前）不按默认值开启（去掉 hydrating 判定时变红）', () => {
    // renderToString 不执行客户端挂载，hydrating 恒为 true
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { renderToString } = require('react-dom/server') as typeof import('react-dom/server');
    editorProps.length = 0;
    renderToString(
      <PolicyForm
        mode="create"
        uiLocale="zh"
        policyId={null}
        initial={{ name: '', description: '', content: '', isPublic: false, groupId: null, aliasSet: null }}
        title="t"
        subtitle="s"
        onSave={async () => ({ id: 'x' })}
        cancelHref="/zh/policies"
        detailHrefFor={(id) => `/zh/policies/${id}`}
        breadcrumbs={[]}
      />,
    );
    expect(editorProps.length).toBeGreaterThan(0);
    expect(editorProps.every((p) => p.enableAICompletion === false)).toBe(true);
    aiInlineCompletionPreference.write(true);
  });
});
