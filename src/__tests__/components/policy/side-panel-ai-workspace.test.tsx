// 编辑器侧栏「AI」tab（ADR 0049 Part B）：工作台启用时嵌入 iframe 面板，未启用时保持原 AIAssistantPanel。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import zhBase from '@aster-cloud/ui-messages/zh-CN.json';
import { IntlClientProvider } from '@/i18n/intl-client-provider';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';

// 全局 setup 的 lucide mock 只含固定图标集；侧栏 header 需要全部图标。
vi.mock('lucide-react', async () => ({ ...(await vi.importActual<Record<string, unknown>>('lucide-react')) }));
vi.mock('@/components/policy/ai-assistant-panel', () => ({ AIAssistantPanel: () => <div data-testid="legacy-ai" /> }));
vi.mock('@/components/policy/ai-workspace-panel', () => ({
  AiWorkspacePanel: (p: { base: string; policyId: string }) => (
    <div data-testid="workspace-ai" data-base={p.base} data-policy={p.policyId}>
      <iframe title="workspace-frame" src={`${p.base}/panel`} />
    </div>
  ),
}));
vi.mock('@/components/policy/cnl-syntax-reference-panel', () => ({ CNLSyntaxReferencePanel: () => null }));
vi.mock('@/components/policy/policy-alias-panel', () => ({ PolicyAliasPanel: () => null }));

import { SidePanel, type SidePanelTab } from '@/components/policy/policy-form/side-panel';
import type { AiWorkspaceConfig } from '@/components/ai-workspace-context';

const messages = deepMergeMessages(zhBase as Record<string, unknown>, DEMO_SUPPLEMENT.zh);
const noop = () => {};

function panel(aiWorkspace: AiWorkspaceConfig | null, policyId: string | null, initialTab: SidePanelTab) {
  return (
    <IntlClientProvider locale="zh" messages={messages as never}>
      <SidePanel
        editor={null}
        cnlLocale="zh-CN"
        uiLocale="zh"
        name=""
        description=""
        groupId={null}
        isPublic={false}
        onNameChange={noop}
        onDescriptionChange={noop}
        onGroupIdChange={noop}
        onIsPublicChange={noop}
        aliasSet={{}}
        reservedSets={{} as never}
        allowStructuralAliases={false}
        onAliasSetChange={noop}
        onApplyContent={noop}
        onApplyTemplate={noop}
        onClose={noop}
        initialTab={initialTab}
        policyId={policyId}
        aiWorkspace={aiWorkspace}
      />
    </IntlClientProvider>
  );
}

function renderPanel(aiWorkspace: AiWorkspaceConfig | null, policyId: string | null = 'p1', initialTab: SidePanelTab = 'ai') {
  return render(panel(aiWorkspace, policyId, initialTab));
}

const ENABLED: AiWorkspaceConfig = { base: 'https://ai.aster-lang.cloud', enabled: true };

afterEach(cleanup);

describe('SidePanel AI tab 与 AI 工作台', () => {
  it('未启用 → 原 AIAssistantPanel', () => {
    renderPanel(null);
    expect(screen.getByTestId('legacy-ai')).toBeTruthy();
    expect(screen.queryByTestId('workspace-ai')).toBeNull();
  });

  it('启用 → 工作台 iframe 面板', () => {
    renderPanel({ base: 'https://ai.aster-lang.cloud', enabled: true });
    const panel = screen.getByTestId('workspace-ai');
    expect(panel.getAttribute('data-base')).toBe('https://ai.aster-lang.cloud');
    expect(panel.getAttribute('data-policy')).toBe('p1');
    expect(screen.queryByTestId('legacy-ai')).toBeNull();
  });

  it('未保存策略 → policyId 为 new', () => {
    renderPanel({ base: 'https://ai.aster-lang.cloud', enabled: true }, null);
    expect(screen.getByTestId('workspace-ai').getAttribute('data-policy')).toBe('new');
  });

  it('切到其他 tab 再切回：iframe 常驻（同一节点、src 不变），其他 tab 时隐藏', () => {
    const { rerender } = renderPanel(ENABLED);
    const frame = screen.getByTitle('workspace-frame');
    const src = frame.getAttribute('src');

    rerender(panel(ENABLED, 'p1', 'problems'));
    expect(screen.getByTitle('workspace-frame')).toBe(frame);
    expect((screen.getByTestId('workspace-ai').parentElement as HTMLElement).hidden).toBe(true);

    rerender(panel(ENABLED, 'p1', 'ai'));
    expect(screen.getByTitle('workspace-frame')).toBe(frame);
    expect(frame.getAttribute('src')).toBe(src);
    expect((screen.getByTestId('workspace-ai').parentElement as HTMLElement).hidden).toBe(false);
  });

  it('从未打开 AI tab 时不加载工作台（不提前交接）', () => {
    renderPanel(ENABLED, 'p1', 'problems');
    expect(screen.queryByTestId('workspace-ai')).toBeNull();
  });

  it('未启用：旧面板仍随 tab 卸载（行为不变）', () => {
    const { rerender } = renderPanel(null);
    expect(screen.getByTestId('legacy-ai')).toBeTruthy();
    rerender(panel(null, 'p1', 'problems'));
    expect(screen.queryByTestId('legacy-ai')).toBeNull();
  });
});
