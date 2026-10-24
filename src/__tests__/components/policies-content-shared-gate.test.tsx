import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';

/**
 * PoliciesContent → SharedWithMeSection 的共享开关接线。
 *
 * ★开关关着时整段不得挂载：该区块一挂载就请求 /api/policies/shared-with-me，而路由对
 *   关闭态有意回 404，会在浏览器控制台留下 404 噪音。这里把区块换成记录挂载次数的探针，
 *   只断言「sharingEnabled 决定是否挂载」这一条接线。
 */

const sectionMounts: Array<Record<string, unknown>> = [];
vi.mock('@/components/policy/shared-with-me-section', () => ({
  SharedWithMeSection: (props: Record<string, unknown>) => { sectionMounts.push(props); return null; },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/zh/policies',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-intl', () => ({
  useTranslations: () => Object.assign((k: string) => k, { rich: (k: string) => k, raw: (k: string) => k, has: () => true }),
  useLocale: () => 'zh',
}));
// 全局 setup 只桩了少量图标；本组件用到的更多，直接用真实图标。
vi.mock('lucide-react', async () => ({ ...(await vi.importActual<Record<string, unknown>>('lucide-react')) }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
// 与本断言无关的重组件桩掉
vi.mock('@/components/policy/policy-group-tree', () => ({ PolicyGroupTree: () => null }));
vi.mock('@/components/policy/policy-group-dialog', () => ({ PolicyGroupDialog: () => null }));

import { PoliciesContent } from '@/app/[locale]/(dashboard)/policies/policies-content';

// 文案对象按任意路径取值都返回 key 字符串（含 raw 模板），避免手写整棵 Translations 树。
function anyStrings(): never {
  const handler: ProxyHandler<object> = {
    get: (_t, key) => (typeof key === 'symbol' ? undefined : anyStrings()),
  };
  return new Proxy(Object.assign(() => '', { toString: () => 'x' }), handler) as never;
}

function renderContent(sharingEnabled: boolean) {
  return render(
    <PoliciesContent
      initialPolicies={[]}
      initialGroups={[]}
      freezeInfo={{ limit: 10, total: 0, frozenCount: 0 }}
      translations={anyStrings()}
      locale="zh"
      sharingEnabled={sharingEnabled}
      pagination={{ page: 1, pageSize: 25, total: 0, selectedGroupId: null, query: '' }}
    />,
  );
}

beforeEach(() => { sectionMounts.length = 0; cleanup(); });

describe('PoliciesContent 共享区块开关接线', () => {
  it('sharingEnabled=false：共享区块不挂载', () => {
    renderContent(false);
    expect(sectionMounts.length).toBe(0);
  });

  it('sharingEnabled=true：共享区块挂载并拿到 locale', () => {
    renderContent(true);
    expect(sectionMounts.length).toBeGreaterThan(0);
    expect(sectionMounts[0].locale).toBe('zh');
  });
});
