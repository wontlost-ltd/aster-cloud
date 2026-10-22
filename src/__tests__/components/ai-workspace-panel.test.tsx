// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));
const themeState = vi.hoisted(() => ({ resolvedTheme: 'light' as string | undefined }));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: themeState.resolvedTheme }) }));

import { AiWorkspacePanel } from '@/components/policy/ai-workspace-panel';

const BASE = 'https://ai.aster-lang.cloud/app';
const ORIGIN = 'https://ai.aster-lang.cloud';

function fakeEditor(value = 'Rule a.') {
  let listener: (() => void) | null = null;
  return {
    getModel: () => ({ getFullModelRange: () => 'FULL' }),
    getSelection: () => 'SEL',
    executeEdits: vi.fn(() => true),
    focus: vi.fn(),
    getValue: vi.fn(() => value),
    onDidChangeModelContent: vi.fn((fn: () => void) => {
      listener = fn;
      return { dispose: vi.fn() };
    }),
    fireChange: () => listener?.(),
  };
}

function setup(policyId = 'p1', ed: ReturnType<typeof fakeEditor> | null = fakeEditor()) {
  const onApplyContent = vi.fn();
  render(
    <AiWorkspacePanel base={BASE} policyId={policyId} editor={ed as never} cnlLocale="zh" uiLocale="zh" onApplyContent={onApplyContent} />,
  );
  const iframe = screen.getByTitle('aiWorkspace') as HTMLIFrameElement;
  const postMessage = vi.fn();
  Object.defineProperty(iframe, 'contentWindow', { value: { postMessage }, configurable: true });
  return { iframe, postMessage, onApplyContent, ed };
}

function send(origin: string, data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { origin, data }));
  });
}

const applyMsg = (over: object = {}) => ({
  type: 'aster.ai.apply', v: 1, action: 'insert', code: 'Rule b.\n', policyId: 'p1', requestId: 'r1', ...over,
});

afterEach(() => {
  vi.useRealTimers();
  themeState.resolvedTheme = 'light';
});

describe('AiWorkspacePanel', () => {
  it('iframe 指向交接路由并允许剪贴板写入', () => {
    const { iframe } = setup();
    expect(iframe.getAttribute('src')).toBe(
      `/api/ai-workspace/handoff?next=${encodeURIComponent('/panel?policyId=p1')}&locale=zh&theme=light`,
    );
    expect(iframe.getAttribute('allow')).toBe('clipboard-write');
  });

  it('工作台 origin 的 apply：写入编辑器、回填表单、回执 applied', () => {
    const { postMessage, onApplyContent, ed } = setup();
    send(ORIGIN, applyMsg());
    expect(ed!.executeEdits).toHaveBeenCalledWith('ai-workspace-insert', [
      { range: 'SEL', text: 'Rule b.\n', forceMoveMarkers: true },
    ]);
    expect(onApplyContent).toHaveBeenCalledWith('Rule a.');
    expect(postMessage).toHaveBeenCalledWith({ type: 'aster.ai.applied', v: 1, requestId: 'r1', ok: true }, ORIGIN);
  });

  it('policyId 不一致：不写入，回执带原因', () => {
    const { postMessage, onApplyContent, ed } = setup();
    send(ORIGIN, applyMsg({ policyId: 'other' }));
    expect(ed!.executeEdits).not.toHaveBeenCalled();
    expect(onApplyContent).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'aster.ai.applied', v: 1, requestId: 'r1', ok: false, reason: 'policy_mismatch' },
      ORIGIN,
    );
  });

  it('外域消息一律忽略', () => {
    const { postMessage, onApplyContent, ed } = setup();
    send('https://evil.example', applyMsg());
    send('https://evil.example', { type: 'aster.ai.ready', v: 1 });
    expect(ed!.executeEdits).not.toHaveBeenCalled();
    expect(onApplyContent).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('ready 时推送上下文', () => {
    const { postMessage } = setup();
    send(ORIGIN, { type: 'aster.ai.ready', v: 1 });
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'aster.ai.context', v: 1, policyId: 'p1', source: 'Rule a.', cnlLocale: 'zh' },
      ORIGIN,
    );
  });

  it('编辑器内容变化 500ms 防抖后推送上下文', () => {
    vi.useFakeTimers();
    const { postMessage, ed } = setup();
    ed!.fireChange();
    ed!.fireChange();
    act(() => { vi.advanceTimersByTime(499); });
    expect(postMessage).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'aster.ai.context' }), ORIGIN);
  });

  it('reauth 重新加载 iframe', () => {
    const { iframe } = setup();
    send(ORIGIN, { type: 'aster.ai.reauth', v: 1 });
    const reloaded = screen.getByTitle('aiWorkspace');
    expect(reloaded).not.toBe(iframe);
    expect(reloaded.getAttribute('src')).toBe(iframe.getAttribute('src'));
  });

  it('未保存策略用 new 作为 policyId', () => {
    const { iframe } = setup('new');
    expect(iframe.getAttribute('src')).toContain(encodeURIComponent('/panel?policyId=new'));
  });

  it('ready 先于 Monaco 挂载：编辑器可用后补发一次上下文', () => {
    const onApplyContent = vi.fn();
    const view = (ed: ReturnType<typeof fakeEditor> | null) => (
      <AiWorkspacePanel base={BASE} policyId="p1" editor={ed as never} cnlLocale="zh" uiLocale="zh" onApplyContent={onApplyContent} />
    );
    const { rerender } = render(view(null));
    const iframe = screen.getByTitle('aiWorkspace') as HTMLIFrameElement;
    const postMessage = vi.fn();
    Object.defineProperty(iframe, 'contentWindow', { value: { postMessage }, configurable: true });
    send(ORIGIN, { type: 'aster.ai.ready', v: 1 });
    postMessage.mockClear();

    rerender(view(fakeEditor('Rule late.')));

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'aster.ai.context', v: 1, policyId: 'p1', source: 'Rule late.', cnlLocale: 'zh' },
      ORIGIN,
    );
  });

  it('未收到 ready 时编辑器挂载不推送上下文', () => {
    const view = (ed: ReturnType<typeof fakeEditor> | null) => (
      <AiWorkspacePanel base={BASE} policyId="p1" editor={ed as never} cnlLocale="zh" uiLocale="zh" onApplyContent={vi.fn()} />
    );
    const { rerender } = render(view(null));
    const iframe = screen.getByTitle('aiWorkspace') as HTMLIFrameElement;
    const postMessage = vi.fn();
    Object.defineProperty(iframe, 'contentWindow', { value: { postMessage }, configurable: true });
    rerender(view(fakeEditor()));
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('★暗色主题：交接地址带 theme=dark（F29）', () => {
    themeState.resolvedTheme = 'dark';
    const { iframe } = setup();
    expect(new URLSearchParams(iframe.getAttribute('src')!.split('?')[1]).get('theme')).toBe('dark');
  });

  it('主题切换：iframe src 随之更新（重新交接以新主题加载）', () => {
    const view = render(
      <AiWorkspacePanel base={BASE} policyId="p1" editor={null} cnlLocale="zh" uiLocale="zh" onApplyContent={vi.fn()} />,
    );
    expect(view.container.querySelector('iframe')!.getAttribute('src')).toContain('theme=light');
    themeState.resolvedTheme = 'dark';
    view.rerender(
      <AiWorkspacePanel base={BASE} policyId="p1" editor={null} cnlLocale="zh" uiLocale="zh" onApplyContent={vi.fn()} />,
    );
    expect(view.container.querySelector('iframe')!.getAttribute('src')).toContain('theme=dark');
  });

  it('主题尚未解析时不加载 iframe（避免按错误主题加载后再重载）', () => {
    themeState.resolvedTheme = undefined;
    const view = render(
      <AiWorkspacePanel base={BASE} policyId="p1" editor={null} cnlLocale="zh" uiLocale="zh" onApplyContent={vi.fn()} />,
    );
    expect(view.container.querySelector('iframe')).toBeNull();
  });
});
