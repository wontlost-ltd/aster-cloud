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
    <div data-testid="workspace-ai" data-base={p.base} data-policy={p.policyId} />
  ),
}));
vi.mock('@/components/policy/cnl-syntax-reference-panel', () => ({ CNLSyntaxReferencePanel: () => null }));
vi.mock('@/components/policy/policy-alias-panel', () => ({ PolicyAliasPanel: () => null }));

import { SidePanel } from '@/components/policy/policy-form/side-panel';
import type { AiWorkspaceConfig } from '@/components/ai-workspace-context';

const messages = deepMergeMessages(zhBase as Record<string, unknown>, DEMO_SUPPLEMENT.zh);
const noop = () => {};

function renderPanel(aiWorkspace: AiWorkspaceConfig | null, policyId: string | null = 'p1') {
  return render(
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
        initialTab="ai"
        policyId={policyId}
        aiWorkspace={aiWorkspace}
      />
    </IntlClientProvider>,
  );
}

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
});
