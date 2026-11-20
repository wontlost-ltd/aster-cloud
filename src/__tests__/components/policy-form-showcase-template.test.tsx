import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * 「静夜思」特色模板（#791、ADR 0060 §8）：应用 = 源码 + 关键词别名 + 本策略内嵌词汇 + 显示排版 + 策略语言 zh-CN，
 * 经正常保存路径一起提交；编辑器有内容时照常确认，文案说明别名、本策略词汇与排版也会被替换；普通模板仍只换源码。
 * 应用模板不写个人 / 团队词汇：除保存回调外不发任何请求。
 */

const h = vi.hoisted(() => ({ template: null as unknown }));

vi.mock('next/dynamic', () => ({ __esModule: true, default: () => () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/en/policies/new',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-intl', () => ({
  useTranslations: () => Object.assign((k: string) => k, { rich: (k: string) => k, raw: (k: string) => k, has: () => true }),
  useLocale: () => 'en',
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }) }));
vi.mock('@/lib/product-events/client', () => ({ trackProductEvent: vi.fn() }));
vi.mock('@/components/policy/policy-form/side-panel', () => ({
  SidePanel: ({ onApplyTemplate }: { onApplyTemplate: (t: unknown) => void }) => (
    <button type="button" onClick={() => onApplyTemplate(h.template)}>apply-template</button>
  ),
}));
vi.mock('@/components/policy/policy-form/editor-palette', () => ({ EditorPalette: () => null }));
vi.mock('@/components/policy/policy-form/editor-rail', () => ({ EditorRail: () => null }));
vi.mock('@/components/policy/cnl-syntax-converter-dialog', () => ({ CNLSyntaxConverterDialog: () => null }));
vi.mock('@/components/policy/policy-form/use-is-mobile', () => ({ useIsMobile: () => false }));

import { PolicyForm } from '@/components/policy/policy-form';
import { jingyesiShowcaseExample as showcase } from '@/data/policy-example-showcase';
import { POLICY_EXAMPLES, getExampleSource } from '@/data/policy-examples';

const ALLOWED = { allowed: true, sources: [] };
const POEM_ALIASES = { FUNC_PRODUCE: ['举头'], FUNC_TO: ['疑是'], MODULE_DECL: ['床前'], RETURN: ['低头'] };
const POEM_TERMS = {
  v: 1,
  terms: [
    { kind: 'literal', localized: '思故乡', canonical: '静夜思' },
    { kind: 'struct', localized: '望明月', canonical: 'Text' },
  ],
};
const DENIED = { allowed: false, sources: [] };
const loan = POLICY_EXAMPLES.find((e) => e.id === 'loan-evaluation')!;

function renderForm(opts: {
  content?: string;
  aliasSet?: Record<string, string[]> | null;
  allowed?: boolean;
  embeddedVocabulary?: typeof POEM_TERMS | null;
}) {
  const onSave = vi.fn().mockResolvedValue({ id: 'new' });
  render(
    <PolicyForm
      mode="create"
      uiLocale="en"
      policyId={null}
      initial={{
        name: '',
        description: '',
        content: opts.content ?? '',
        isPublic: false,
        groupId: null,
        aliasSet: opts.aliasSet ?? null,
        embeddedVocabulary: (opts.embeddedVocabulary ?? null) as never,
      }}
      title="t"
      subtitle="s"
      onSave={onSave}
      cancelHref="/en/policies"
      detailHrefFor={(id) => `/en/policies/${id}`}
      breadcrumbs={[]}
      structuredAuthoring={(opts.allowed ?? true) ? ALLOWED : DENIED}
      allowStructuralAliases
    />,
  );
  return onSave;
}

async function save(onSave: ReturnType<typeof vi.fn>) {
  fireEvent.click(screen.getByRole('button', { name: 'create' }));
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  return onSave.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
}

describe('PolicyForm applying the showcase template', () => {
  // jsdom 未实现 <dialog>.showModal/close（模板替换确认用 ConfirmDialog）：补最小桩，只切换 open 属性。
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  });
  const fetchSpy = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    h.template = showcase;
    vi.stubGlobal('fetch', fetchSpy);
  });

  it('sets content, aliasSet, embedded vocabulary, layout and the zh-CN locale, and saves them through the normal path', async () => {
    const onSave = renderForm({});
    fireEvent.click(screen.getByText('apply-template'));
    const [fields, context] = await save(onSave);
    expect(fields.content).toBe(getExampleSource(showcase, 'en-US'));
    expect(fields.aliasSet).toEqual(POEM_ALIASES);
    expect(fields.embeddedVocabulary).toEqual(POEM_TERMS);
    expect(fields.name).toBe(showcase.id);
    expect(context).toEqual({ locale: 'zh-CN', layout: showcase.layout, embeddedVocabulary: POEM_TERMS });
    // 表单里的内嵌词条是副本，不与模板常量共享引用
    expect(fields.embeddedVocabulary).not.toBe(showcase.embeddedVocabulary);
  });

  it('writes no personal or team vocabulary: the only side effect is the save callback', async () => {
    const onSave = renderForm({});
    fireEvent.click(screen.getByText('apply-template'));
    await save(onSave);
    const calls = fetchSpy.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${String(url)}`);
    expect(calls.filter((c) => !c.startsWith('GET '))).toEqual([]);
    expect(calls.filter((c) => /vocabular|domain-term|lexicon/i.test(c) && !c.startsWith('GET '))).toEqual([]);
  });

  it('asks first when only this policy’s terms would be overwritten (empty editor, no aliases)', async () => {
    const onSave = renderForm({ embeddedVocabulary: { v: 1, terms: [{ kind: 'struct', localized: '月', canonical: 'Moon' }] } });
    fireEvent.click(screen.getByText('apply-template'));
    expect(screen.getByText('templateReplaceDescriptionExtras')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'replace' }));
    const [fields, context] = await save(onSave);
    // 「本策略」分组被模板整体替换
    expect(fields.embeddedVocabulary).toEqual(POEM_TERMS);
    expect(context.embeddedVocabulary).toEqual(POEM_TERMS);
  });

  it('asks first when the editor has content, saying aliases, terms and the layout are replaced too', async () => {
    const onSave = renderForm({ content: 'Module a.', aliasSet: { TIMES: ['multiplied by'] } });
    fireEvent.click(screen.getByText('apply-template'));
    expect(screen.getByText('templateReplaceDescriptionExtras')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'replace' }));
    const [fields, context] = await save(onSave);
    // 原有别名被模板的别名整体替换
    expect(fields.aliasSet).toEqual(POEM_ALIASES);
    expect(context.layout).toEqual(showcase.layout);
    expect(context.embeddedVocabulary).toEqual(POEM_TERMS);
  });

  it('asks first when only aliases would be overwritten (empty editor)', () => {
    renderForm({ aliasSet: { TIMES: ['multiplied by'] } });
    fireEvent.click(screen.getByText('apply-template'));
    expect(screen.getByText('templateReplaceDescriptionExtras')).toBeTruthy();
  });

  it('a content-only template keeps the old confirmation text and leaves aliases alone', async () => {
    h.template = loan;
    const onSave = renderForm({ content: 'Module a.', aliasSet: { TIMES: ['multiplied by'] } });
    fireEvent.click(screen.getByText('apply-template'));
    expect(screen.getByText('templateReplaceDescription')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'replace' }));
    const [fields, context] = await save(onSave);
    expect(fields.aliasSet).toEqual({ TIMES: ['multiplied by'] });
    expect(context).toEqual({ locale: 'en-US' });
  });

  it('a content-only template after the showcase drops the now-stale layout draft', async () => {
    const onSave = renderForm({});
    fireEvent.click(screen.getByText('apply-template'));
    h.template = loan;
    fireEvent.click(screen.getByText('apply-template'));
    fireEvent.click(screen.getByRole('button', { name: 'replace' }));
    const [fields, context] = await save(onSave);
    expect(fields.content).toBe(loan.sources['zh-CN']);
    // 排版对不上新源码：不再提交（省略 = 未动）；普通模板不动别名与本策略词条
    expect(context).toEqual({ locale: 'zh-CN', embeddedVocabulary: POEM_TERMS });
  });

  it('without structured authoring neither the layout nor the terms are set (defensive; the picker locks the template)', async () => {
    const onSave = renderForm({ allowed: false });
    fireEvent.click(screen.getByText('apply-template'));
    const [fields, context] = await save(onSave);
    expect(fields.embeddedVocabulary).toBeNull();
    expect(context).toEqual({ locale: 'zh-CN' });
  });
});
