import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { ASTER_POLICY_TEMPLATES } from '@/config/aster-policy-templates';
import { getSnippetTemplate } from '@/lib/playground/snippet-templates';

/**
 * /policies/new 的初始内容：没有文档深链时按界面语言预填入门模板并标记为 starter；
 * 带 `?template=` 深链时只认深链（登记过的载入片段，未知 id 保持空白），不叠加入门模板。
 */

const h = vi.hoisted(() => ({
  params: new URLSearchParams(),
  props: null as null | { initial: { content: string; name: string }; starter?: boolean; teamId?: string | null },
}));

vi.mock('@/lib/product-events/client', () => ({ trackProductEvent: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => h.params }));
vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));
vi.mock('@/components/policy/policy-form', () => ({
  PolicyForm: (props: typeof h.props) => {
    h.props = props;
    return null;
  },
}));

import { NewPolicyContent } from '@/app/[locale]/(dashboard)/policies/new/new-policy-content';

function renderAt(locale: string, query = '') {
  h.params = new URLSearchParams(query);
  render(<NewPolicyContent locale={locale} allowStructuralAliases={false} />);
  return h.props!;
}

describe('/policies/new 入门模板预填', () => {
  beforeEach(() => {
    h.props = null;
  });

  it.each([
    ['en', 'en-US'],
    ['zh', 'zh-CN'],
    ['de', 'de-DE'],
    ['hi', 'en-US'],
  ] as const)('界面 %s：预填 %s 入门模板并标记 starter，名称留空', (locale, key) => {
    const props = renderAt(locale);
    expect(props.initial.content).toBe(ASTER_POLICY_TEMPLATES[key]);
    expect(props.initial.name).toBe('');
    expect(props.starter).toBe(true);
  });

  it('团队新建（?teamId=）同样预填入门模板', () => {
    const props = renderAt('zh', 'teamId=t1');
    expect(props.initial.content).toBe(ASTER_POLICY_TEMPLATES['zh-CN']);
    expect(props.starter).toBe(true);
    expect(props.teamId).toBe('t1');
  });

  it('文档深链 ?template=<登记 id>：载入深链片段，不是入门模板', () => {
    const props = renderAt('zh', 'from=docs&template=policy-batch');
    expect(props.initial.content).toBe(getSnippetTemplate('policy-batch')!.source);
    expect(props.starter).toBe(false);
  });

  it('文档深链 id 未登记：保持空白编辑器，不用入门模板冒充深链内容', () => {
    const props = renderAt('en', 'template=../../etc');
    expect(props.initial.content).toBe('');
    expect(props.starter).toBe(false);
  });
});
