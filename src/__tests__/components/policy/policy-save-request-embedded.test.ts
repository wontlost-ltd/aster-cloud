// 保存请求体与草稿里的策略内嵌词汇（ADR 0060 §6.5，计划 T11）：
// - 请求体只按保存上下文的三态带 embeddedVocabulary，表单字段里的值从不原样展开；
// - vocabularyShadowed 解析丢弃形状不符的元素；
// - 草稿 schema 3 记录内嵌词汇，v2 草稿恢复时沿用服务端基线（不把「没记录」当清空），坏数据退回基线。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { policySaveBody, vocabularyShadowedOf } from '@/components/policy/policy-form/save-request';
import { usePolicyDraft, type PolicyDraftFields } from '@/components/policy/policy-form/use-policy-draft';
import type { EmbeddedVocabulary } from '@/lib/policy-embedded-vocabulary';

const POEM: EmbeddedVocabulary = { v: 1, terms: [{ kind: 'literal', localized: '思故乡', canonical: '静夜思' }] };
const FIELDS: PolicyDraftFields = {
  name: 'n',
  description: '',
  content: 'src',
  isPublic: false,
  groupId: null,
  aliasSet: null,
  embeddedVocabulary: POEM,
};

describe('policySaveBody', () => {
  it('上下文省略 → 请求体没有 embeddedVocabulary（即使表单字段里有值）', () => {
    const body = policySaveBody(FIELDS, { locale: 'zh-CN' }, { teamId: 't1' });
    expect('embeddedVocabulary' in body).toBe(false);
    expect(body).toMatchObject({ name: 'n', content: 'src', locale: 'zh-CN', teamId: 't1', aliasSet: null });
    expect('layout' in body).toBe(false);
  });

  it('上下文 null → 请求体 null；对象 → 原样', () => {
    expect(policySaveBody(FIELDS, { locale: 'zh-CN', embeddedVocabulary: null }).embeddedVocabulary).toBeNull();
    expect(policySaveBody(FIELDS, { locale: 'zh-CN', embeddedVocabulary: POEM }).embeddedVocabulary).toEqual(POEM);
  });

  it('layout 三态照旧', () => {
    expect(policySaveBody(FIELDS, { locale: 'en-US', layout: null }).layout).toBeNull();
  });
});

describe('vocabularyShadowedOf', () => {
  it('只保留形状正确的元素；缺省为空', () => {
    expect(vocabularyShadowedOf({})).toEqual([]);
    expect(vocabularyShadowedOf(null)).toEqual([]);
    expect(
      vocabularyShadowedOf({
        vocabularyShadowed: [
          { kind: 'struct', localized: '望明月', canonical: 'Moon', source: 'author' },
          { kind: 'struct', localized: 'x', canonical: 'y', source: 'tenant' },
          'junk',
        ],
      }),
    ).toEqual([{ kind: 'struct', localized: '望明月', canonical: 'Moon', source: 'author' }]);
  });
});

describe('usePolicyDraft 与内嵌词汇', () => {
  const KEY = 'aster:policy-draft:p1';
  const baseline: PolicyDraftFields = { ...FIELDS, content: 'saved' };
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  const store = (draft: Record<string, unknown>) =>
    window.localStorage.setItem(KEY, JSON.stringify({ savedAt: Date.now(), ...draft }));

  it('v2 草稿（无该字段）：恢复时沿用基线的内嵌词汇', async () => {
    store({ v: 2, name: 'n', description: '', content: 'edited', isPublic: false, groupId: null, aliasSet: null });
    const { result } = renderHook(() => usePolicyDraft({ policyId: 'p1', fields: baseline, baseline }));
    await waitFor(() => expect(result.current.pendingDraft).not.toBeNull());
    expect(result.current.pendingDraft!.embeddedVocabulary).toEqual(POEM);
  });

  it('v3 草稿记录的清空（null）原样恢复', async () => {
    store({ v: 3, ...baseline, embeddedVocabulary: null });
    const { result } = renderHook(() => usePolicyDraft({ policyId: 'p1', fields: baseline, baseline }));
    await waitFor(() => expect(result.current.pendingDraft).not.toBeNull());
    expect(result.current.pendingDraft!.embeddedVocabulary).toBeNull();
  });

  it('v3 草稿里只有顺序不同：不算改动，不提示恢复', async () => {
    const two: EmbeddedVocabulary = {
      v: 1,
      terms: [POEM.terms[0]!, { kind: 'struct', localized: '望明月', canonical: 'Text' }],
    };
    const base = { ...baseline, embeddedVocabulary: two };
    store({ v: 3, ...base, embeddedVocabulary: { v: 1, terms: [...two.terms].reverse() } });
    const { result } = renderHook(() => usePolicyDraft({ policyId: 'p1', fields: base, baseline: base }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.pendingDraft).toBeNull();
  });

  it('v3 草稿里被改坏的内嵌词汇退回基线', async () => {
    store({ v: 3, ...baseline, content: 'edited', embeddedVocabulary: { v: 1, terms: [{ kind: 'macro' }] } });
    const { result } = renderHook(() => usePolicyDraft({ policyId: 'p1', fields: baseline, baseline }));
    await waitFor(() => expect(result.current.pendingDraft).not.toBeNull());
    expect(result.current.pendingDraft!.embeddedVocabulary).toEqual(POEM);
  });

  it('写入的草稿 schema 为 3 并含内嵌词汇', async () => {
    const edited = { ...baseline, content: 'typed' };
    renderHook(() => usePolicyDraft({ policyId: 'p1', fields: edited, baseline, throttleMs: 1 }));
    await waitFor(() => expect(window.localStorage.getItem(KEY)).not.toBeNull());
    const stored = JSON.parse(window.localStorage.getItem(KEY)!);
    expect(stored.v).toBe(3);
    expect(stored.embeddedVocabulary).toEqual(POEM);
  });
});
