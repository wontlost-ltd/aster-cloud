import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/**
 * 复核面板在策略详情页上的**接线**。
 *
 * <h2>为什么单独测这个</h2>
 *
 * <p>面板自己有 60+ 条测试，但它们都证明不了"它被正确挂上去了"——
 * 全仓没有任何测试渲染过 `policy-detail-content.tsx`。对抗性变异实测：
 * 把 `policyId={policy.id}` 写死成常量、或把整块换成 `{null}`，全绿。
 *
 * <ul>
 *   <li>写死 policyId ⇒ 每个用户看到的是**另一条策略**的队列，并对其签字</li>
 *   <li>整块移除 ⇒ 功能消失而 CI 全绿</li>
 * </ul>
 *
 * <h2>★为什么是真渲染，不是正则扫源码</h2>
 *
 * <p>上一版对源码做正则匹配。对抗性验证证明那个方向是错的：
 *
 * <ul>
 *   <li>`{false ? <PolicyReviewPanel .../> : null}`、恒假开关、
 *       整行注释掉 —— **源码文本原封不动**，正则全部放行，而功能已失效</li>
 *   <li>反过来，正常加一个 `className` prop 却会因为
 *       "policyId 不再紧邻 `/>`" 而报红 —— 拦的是**正确**改动</li>
 * </ul>
 *
 * <p>判别力与噪声方向正好反了。真渲染没有这个问题：它看的是
 * "面板到底有没有被渲染、拿到的 policyId 是什么"，与写法无关。
 */

/** 把复核面板换成探针，只回报它收到的 policyId。 */
vi.mock('@/components/policy/policy-review-panel', () => ({
  PolicyReviewPanel: ({ policyId }: { policyId: string }) => (
    <div data-testid="review-panel" data-policy-id={policyId} />
  ),
}));

// 其余子组件与详情页无关，一律替换成空壳，避免把整棵依赖树拖进来。
vi.mock('@/components/policy/policy-versions-tab', () => ({
  PolicyVersionsTab: () => <div />,
}));
vi.mock('@/components/policy/share-with-teams-card', () => ({
  ShareWithTeamsCard: () => <div />,
}));
vi.mock('@/components/policy/policy-analytics-section', () => ({
  PolicyAnalyticsSection: () => <div />,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

import { PolicyDetailContent } from
  '@/app/[locale]/(dashboard)/policies/[id]/policy-detail-content';

/** 详情页需要的最小 policy。 */
function policyOf(id: string) {
  return {
    id,
    name: '测试策略',
    description: '',
    content: 'Module m.',
    version: 1,
    status: 'DRAFT',
    createdAt: '2026-09-14T00:00:00Z',
    updatedAt: '2026-09-14T00:00:00Z',
    userId: 'u1',
    teamId: null,
    // 详情页会读 `policy._count.executions` 渲染统计卡片。
    _count: { executions: 0 },
  };
}

/**
 * 文案：任意深度的属性都返回一个"既能当字符串又能继续取下级"的代理。
 *
 * <p>详情页会读 `t.executions.xxx` 这类嵌套分组，单层 key 直返会在
 * 取下级时炸 `undefined`。本用例只关心接线，不关心文案内容。
 */
function deepStub(): unknown {
  return new Proxy(function stub() {} as unknown as object, {
    get: (_t, k) => {
      if (k === Symbol.toPrimitive || k === 'toString') return () => 'x';
      if (k === 'then') return undefined;          // 别让它被当成 thenable
      return deepStub();
    },
    apply: () => 'x',
  });
}
const translations = deepStub() as never;

afterEach(() => cleanup());

describe('复核面板接线（策略详情页）', () => {
  it('★面板必须被真正渲染出来（恒假开关/注释掉都要能发现）', () => {
    render(
      <PolicyDetailContent
        policy={policyOf('pol-42') as never}
        translations={translations}
        locale="zh"
      />,
    );

    expect(screen.getByTestId('review-panel'), '复核面板未被渲染').toBeDefined();
  });

  it('★policyId 必须是**当前这条**策略的 id', () => {
    // 写死常量 ⇒ 所有人对同一条（错误的）策略签字。
    render(
      <PolicyDetailContent
        policy={policyOf('pol-42') as never}
        translations={translations}
        locale="zh"
      />,
    );

    expect(screen.getByTestId('review-panel').getAttribute('data-policy-id'))
      .toBe('pol-42');
  });

  it('★换一条策略，传下去的 id 必须跟着变（防写死字面量）', () => {
    render(
      <PolicyDetailContent
        policy={policyOf('another-policy') as never}
        translations={translations}
        locale="zh"
      />,
    );

    expect(screen.getByTestId('review-panel').getAttribute('data-policy-id'))
      .toBe('another-policy');
  });
});
