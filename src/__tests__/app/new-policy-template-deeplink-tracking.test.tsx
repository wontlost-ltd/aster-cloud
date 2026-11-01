import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const h = vi.hoisted(() => ({ track: vi.fn(), params: new URLSearchParams() }));

vi.mock('@/lib/product-events/client', () => ({ trackProductEvent: h.track }));
vi.mock('next/navigation', () => ({ useSearchParams: () => h.params }));
vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));
vi.mock('@/components/policy/policy-form', () => ({ PolicyForm: () => null }));

import { NewPolicyContent } from '@/app/[locale]/(dashboard)/policies/new/new-policy-content';

describe('/policies/new 文档深链模板埋点', () => {
  beforeEach(() => vi.clearAllMocks());

  it('登记过的模板 id → 记一次 deeplink', () => {
    h.params = new URLSearchParams('from=docs&template=policy-batch');
    const { rerender } = render(<NewPolicyContent locale="en" allowStructuralAliases={false} />);
    rerender(<NewPolicyContent locale="en" allowStructuralAliases={false} />);
    expect(h.track).toHaveBeenCalledTimes(1);
    expect(h.track).toHaveBeenCalledWith('template_selected', { templateId: 'policy-batch', source: 'deeplink' });
  });

  it('未知模板 id 或无模板参数 → 不记', () => {
    h.params = new URLSearchParams('template=../../etc');
    render(<NewPolicyContent locale="en" allowStructuralAliases={false} />);
    h.params = new URLSearchParams();
    render(<NewPolicyContent locale="en" allowStructuralAliases={false} />);
    expect(h.track).not.toHaveBeenCalled();
  });
});
