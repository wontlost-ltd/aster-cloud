import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { computeSourceEnvelope } from '@/lib/policy-alias';
import { resolveStoredVersionLocale } from '@/lib/policy-version-locale';

/**
 * #627：德语界面编辑英文策略时，状态栏显示 CNL DE-DE、别名面板规范列显示德语关键词。
 * 编辑器的 CNL 语言必须是策略的语言，且与执行端（resolveStoredVersionLocale）同一判定；
 * 源码看起来是另一种语言时只提示，由用户显式切换后保存才改变 locale。
 */

const h = vi.hoisted(() => ({
  translate: vi.fn((key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  ),
}));

vi.mock('next/dynamic', () => ({ __esModule: true, default: () => () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/de/policies/p1/edit',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-intl', () => ({
  useTranslations: () => Object.assign(h.translate, { rich: (k: string) => k, raw: (k: string) => k, has: () => true }),
  useLocale: () => 'de',
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
/** 侧栏换成探针：暴露别名面板等子面板拿到的 CNL 语言。 */
vi.mock('@/components/policy/policy-form/side-panel', () => ({
  SidePanel: ({ cnlLocale }: { cnlLocale: string }) => <div data-testid="side-panel" data-cnl-locale={cnlLocale} />,
}));
vi.mock('@/components/policy/policy-form/editor-palette', () => ({ EditorPalette: () => null }));
/** 左侧栏换成一个按钮：点击打开别名面板（编辑模式下侧栏默认收起）。 */
vi.mock('@/components/policy/policy-form/editor-rail', () => ({
  EditorRail: ({ onSelect }: { onSelect: (tab: string) => void }) => (
    <button type="button" onClick={() => onSelect('aliases')}>open-aliases</button>
  ),
}));
vi.mock('@/components/policy/cnl-syntax-converter-dialog', () => ({ CNLSyntaxConverterDialog: () => null }));
vi.mock('@/components/policy/policy-form/use-is-mobile', () => ({ useIsMobile: () => false }));

import { PolicyForm, type PolicySaveContext } from '@/components/policy/policy-form';

const ENGLISH = `Module e2e.alias.

Rule score given age as Int, produce Int:
  If age at least 18:
    Return 1.
  Return 0.
`;
const GERMAN = `Modul e2e.vocab.

Definiere Fahrer hat alter als Ganzzahl.
`;

function renderForm(opts: { mode: 'create' | 'edit'; content: string; policyCnlLocale?: string | null }) {
  const onSave = vi.fn(async (_fields: unknown, _ctx: PolicySaveContext) => ({ id: 'p1' }));
  render(
    <PolicyForm
      mode={opts.mode}
      uiLocale="de"
      policyCnlLocale={opts.policyCnlLocale}
      policyId={opts.mode === 'edit' ? 'p1' : null}
      initial={{ name: 'n', description: '', content: opts.content, isPublic: false, groupId: null, aliasSet: null }}
      title="t"
      subtitle="s"
      onSave={onSave}
      cancelHref="/de/policies"
      detailHrefFor={(id) => `/de/policies/${id}`}
      breadcrumbs={[]}
    />,
  );
  return { onSave };
}

function panelLocale(): string | null {
  if (!screen.queryByTestId('side-panel')) fireEvent.click(screen.getByRole('button', { name: 'open-aliases' }));
  return screen.getByTestId('side-panel').getAttribute('data-cnl-locale');
}

function statusLocale(): string {
  const bar = screen.getByTestId('policy-status-bar');
  const match = /statusLocale:(\{[^}]*\})/.exec(bar.textContent ?? '');
  return (JSON.parse(match![1]) as { locale: string }).locale;
}

async function saveAndGetLocale(onSave: ReturnType<typeof renderForm>['onSave'], button = 'save'): Promise<string> {
  fireEvent.click(screen.getByRole('button', { name: button }));
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  return onSave.mock.calls[0][1].locale;
}

describe('PolicyForm 的 CNL 语言跟随策略而非界面语言（#627）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('德语界面编辑英文策略：状态栏 EN-US，别名面板拿到 en-US，无提示，保存提交 en-US', async () => {
    const { onSave } = renderForm({ mode: 'edit', content: ENGLISH, policyCnlLocale: 'en-US' });

    expect(statusLocale()).toBe('EN-US');
    expect(panelLocale()).toBe('en-US');
    expect(screen.queryByTestId('policy-locale-mismatch')).toBeNull();
    expect(await saveAndGetLocale(onSave)).toBe('en-US');
  });

  describe('历史版本记录为 en-US、源码看起来是德语', () => {
    const recorded = () =>
      resolveStoredVersionLocale({
        source: GERMAN,
        aliasSet: null,
        sourceEnvelopeSha256: computeSourceEnvelope(GERMAN, null, 'en-US', 'tc-1', ''),
        sourceToolchainId: 'tc-1',
        vocabularySnapshotIds: null,
        // 无作者的草稿：envelope 词汇段为空，不触库
        status: 'DRAFT',
        createdBy: null,
      });

    it('执行端与编辑器同为 en-US，编辑器给出切换提示；不切换时保存仍提交 en-US', async () => {
      const locale = await recorded();
      expect(locale).toBe('en-US'); // 执行（secure-execute / 审批冻结）使用的值
      const { onSave } = renderForm({ mode: 'edit', content: GERMAN, policyCnlLocale: locale });

      expect(statusLocale()).toBe('EN-US');
      expect(panelLocale()).toBe('en-US');
      expect(screen.getByTestId('policy-locale-mismatch').textContent).toContain('"detected":"DE-DE"');
      expect(await saveAndGetLocale(onSave)).toBe('en-US');
    });

    it('用户显式切换后：显示 DE-DE、提示消失，保存提交 de-DE', async () => {
      const { onSave } = renderForm({ mode: 'edit', content: GERMAN, policyCnlLocale: await recorded() });

      fireEvent.click(screen.getByRole('button', { name: 'localeMismatchSwitch:{"locale":"DE-DE"}' }));

      expect(statusLocale()).toBe('DE-DE');
      expect(panelLocale()).toBe('de-DE');
      expect(screen.queryByTestId('policy-locale-mismatch')).toBeNull();
      expect(await saveAndGetLocale(onSave)).toBe('de-DE');
    });
  });

  it('识别器不认识的语言（hi-IN）按服务端解析值显示，不提示', () => {
    renderForm({ mode: 'edit', content: 'x', policyCnlLocale: 'hi-IN' });
    expect(statusLocale()).toBe('HI-IN');
    expect(panelLocale()).toBe('hi-IN');
    expect(screen.queryByTestId('policy-locale-mismatch')).toBeNull();
  });

  it('新建英文策略（德语界面）：EN-US，保存提交 en-US 而非界面语言', async () => {
    const { onSave } = renderForm({ mode: 'create', content: ENGLISH });
    expect(statusLocale()).toBe('EN-US');
    expect(panelLocale()).toBe('en-US');
    expect(await saveAndGetLocale(onSave, 'create')).toBe('en-US');
  });

  it('新建空策略：沿用界面语言对应的 CNL 语言', () => {
    renderForm({ mode: 'create', content: '' });
    expect(statusLocale()).toBe('DE-DE');
  });
});
