// PolicyForm 的策略内嵌词汇接线（ADR 0060 §6.5–6.7、§7.5，计划 T11）：
// 保存三态（未改 = 省略、改动 = 对象、清空 = null）、编辑器编译 / LSP 拿到内嵌词汇、无能力只读、保存后提示被遮蔽词条、
// 本地校验拦截与服务端错误码文案。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

function format(key: string, values?: Record<string, unknown>): string {
  if (!values) return key;
  return `${key}{${Object.entries(values).map(([k, v]) => `${k}=${String(v)}`).join(',')}}`;
}

const h = vi.hoisted(() => ({
  dynamicCount: 0,
  // next/dynamic 的声明顺序：0 = MonacoPolicyEditor，1 = CanonicalPreviewPane
  props: [] as Array<Record<string, unknown> | undefined>,
  sidePanel: undefined as Record<string, unknown> | undefined,
  rail: undefined as Record<string, unknown> | undefined,
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}));

vi.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => {
    const index = h.dynamicCount++;
    return function DynamicStub(props: Record<string, unknown>) {
      h.props[index] = props;
      return <div data-testid={`dynamic-${index}`} />;
    };
  },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/zh/policies/p1/edit',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) =>
    Object.assign((key: string, values?: Record<string, unknown>) => format(ns ? `${ns}.${key}` : key, values), {
      rich: (k: string) => k,
      raw: (k: string) => k,
      has: () => true,
    }),
  useLocale: () => 'zh',
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), h.toast) }));
vi.mock('@/components/policy/policy-form/side-panel', () => ({
  SidePanel: (props: Record<string, unknown>) => {
    h.sidePanel = props;
    return <div data-testid="side-panel">{props.initialTab as string}</div>;
  },
}));
vi.mock('@/components/policy/policy-form/editor-palette', () => ({ EditorPalette: () => null }));
vi.mock('@/components/policy/policy-form/editor-rail', () => ({
  EditorRail: (props: Record<string, unknown>) => {
    h.rail = props;
    return null;
  },
}));
vi.mock('@/components/policy/cnl-syntax-converter-dialog', () => ({ CNLSyntaxConverterDialog: () => null }));
vi.mock('@/components/policy/policy-form/use-is-mobile', () => ({ useIsMobile: () => false }));

import { PolicyForm, type PolicySaveContext } from '@/components/policy/policy-form';
import type { StructuredAuthoringProps } from '@/lib/capabilities/types';
import type { EmbeddedVocabulary } from '@/lib/policy-embedded-vocabulary';

const ALLOWED: StructuredAuthoringProps = { allowed: true, sources: [{ kind: 'admin' }] };
const DENIED: StructuredAuthoringProps = { allowed: false, denial: 'not_granted', sources: [] };
const SOURCE = '模块 明月光。\n规则 地上霜，产出 望明月：\n  返回 思故乡。';
const POEM: EmbeddedVocabulary = {
  v: 1,
  terms: [
    { kind: 'literal', localized: '思故乡', canonical: '静夜思' },
    { kind: 'struct', localized: '望明月', canonical: 'Text' },
  ],
};

type SaveFn = (fields: unknown, ctx: PolicySaveContext) => Promise<unknown>;

function renderForm(opts: {
  structuredAuthoring?: StructuredAuthoringProps;
  onSave?: SaveFn;
  embedded?: EmbeddedVocabulary | null;
} = {}) {
  const onSave = vi.fn(opts.onSave ?? (async () => ({ id: 'p1' })));
  render(
    <PolicyForm
      mode="edit"
      uiLocale="zh"
      policyCnlLocale="zh-CN"
      policyId="p1"
      initial={{
        name: 'n',
        description: '',
        content: SOURCE,
        isPublic: false,
        groupId: null,
        aliasSet: null,
        embeddedVocabulary: opts.embedded === undefined ? POEM : opts.embedded,
      }}
      title="Edit"
      subtitle="s"
      onSave={onSave as never}
      cancelHref="/zh/policies/p1"
      detailHrefFor={(id) => `/zh/policies/${id}`}
      breadcrumbs={[]}
      structuredAuthoring={opts.structuredAuthoring ?? ALLOWED}
    />,
  );
  act(() => (h.rail!.onSelect as (tab: string) => void)('ai'));
  return onSave;
}

const ctxOf = (onSave: ReturnType<typeof vi.fn>) => onSave.mock.calls.at(-1)![1] as PolicySaveContext;
const clickSave = () => fireEvent.click(screen.getByRole('button', { name: 'policies.form.save' }));
const changeEmbedded = (next: EmbeddedVocabulary) =>
  act(() => (h.sidePanel!.onEmbeddedVocabularyChange as (v: EmbeddedVocabulary) => void)(next));

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
  h.dynamicCount = 0;
  h.props = [];
  h.sidePanel = undefined;
  h.rail = undefined;
  for (const fn of Object.values(h.toast)) fn.mockReset();
});

describe('PolicyForm 内嵌词汇', () => {
  it('编辑器（浏览器编译、LSP、规范预览）拿到活跃版本的内嵌词汇；侧栏拿到同一份', () => {
    renderForm();
    expect(h.props[0]!.embeddedVocabulary).toEqual(POEM);
    expect(h.sidePanel!.embeddedVocabulary).toEqual(POEM);
  });

  it('未改动：保存上下文没有 embeddedVocabulary 键（PUT 沿用活跃版本）', async () => {
    const onSave = renderForm();
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect('embeddedVocabulary' in ctxOf(onSave)).toBe(false);
  });

  it('改动：提交整份对象；只改顺序不算改动', async () => {
    const onSave = renderForm();
    changeEmbedded({ v: 1, terms: [...POEM.terms].reverse() });
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect('embeddedVocabulary' in ctxOf(onSave)).toBe(false);

    const changed: EmbeddedVocabulary = { v: 1, terms: [POEM.terms[0]!, { kind: 'struct', localized: '望明月', canonical: 'Moon' }] };
    changeEmbedded(changed);
    expect(h.props[0]!.embeddedVocabulary).toEqual(changed);
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(ctxOf(onSave).embeddedVocabulary).toEqual(changed);
  });

  it('清空：提交 null；保存成功后以新值为基线，再保存省略', async () => {
    const onSave = renderForm();
    changeEmbedded({ v: 1, terms: [] });
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(ctxOf(onSave).embeddedVocabulary).toBeNull();
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect('embeddedVocabulary' in ctxOf(onSave)).toBe(false);
  });

  it('新策略没有内嵌词条时不带字段；加了词条才提交对象', async () => {
    const onSave = renderForm({ embedded: null });
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect('embeddedVocabulary' in ctxOf(onSave)).toBe(false);
    changeEmbedded(POEM);
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(ctxOf(onSave).embeddedVocabulary).toEqual(POEM);
  });

  it('无能力：编辑器仍拿到内嵌词汇（编译输入），保存省略字段', async () => {
    const onSave = renderForm({ structuredAuthoring: DENIED });
    expect(h.props[0]!.embeddedVocabulary).toEqual(POEM);
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect('embeddedVocabulary' in ctxOf(onSave)).toBe(false);
  });

  it('保存响应带 vocabularyShadowed 时提示被覆盖的词条及来源', async () => {
    const onSave = renderForm({
      onSave: async () => ({
        id: 'p1',
        vocabularyShadowed: [
          { kind: 'struct', localized: '望明月', canonical: 'Moon', source: 'author' },
          { kind: 'literal', localized: '思故乡', canonical: '乡愁', source: 'team' },
        ],
      }),
    });
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    await waitFor(() => expect(h.toast.info).toHaveBeenCalled());
    expect(h.toast.info.mock.calls[0]![0]).toBe(
      'policyEditor.embeddedTerms.shadowedAfterSave{count=2,terms=望明月 (policyEditor.embeddedTerms.sourceAuthor), 思故乡 (policyEditor.embeddedTerms.sourceTeam)}',
    );
  });

  it('内嵌写法等于关键词：本地拦下，不调用保存，打开词汇标签', async () => {
    const onSave = renderForm();
    changeEmbedded({ v: 1, terms: [{ kind: 'literal', localized: '返回', canonical: 'x' }] });
    clickSave();
    await waitFor(() => expect(h.toast.error).toHaveBeenCalled());
    expect(onSave).not.toHaveBeenCalled();
    expect(h.toast.error.mock.calls[0]![1]).toEqual({
      description: 'policyEditor.embeddedTerms.errors.embedded_vocabulary_shadows_keyword',
    });
    expect(h.sidePanel!.initialTab).toBe('vocabulary');
  });

  it('服务端返回 embedded_vocabulary_* 时按码给本地化文案', async () => {
    const onSave = renderForm({
      onSave: async () => ({ message: 'Invalid embedded vocabulary', code: 'embedded_vocabulary_duplicate' }),
    });
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    await waitFor(() => expect(h.toast.error).toHaveBeenCalled());
    expect(h.toast.error.mock.calls[0]![1]).toEqual({
      description: 'policyEditor.embeddedTerms.errors.embedded_vocabulary_duplicate',
    });
    expect(h.sidePanel!.initialTab).toBe('vocabulary');
  });
});
