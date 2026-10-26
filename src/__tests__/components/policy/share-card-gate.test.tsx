import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/**
 * 策略详情页「与团队共享」卡片的平台开关门控（#630）。
 *
 * GET /api/policies/:id/shares 在 policy_sharing.enabled 关闭时有意回 404（不暴露开关状态），
 * 卡片一挂载就会请求它，于是开关关闭的环境里每次打开详情页都会在控制台留下一条 404。
 * 修复后开关由 server component 读出下发：关闭时卡片不挂载、不发请求；开启时照常挂载。
 */

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

/** 卡片换成探针：只要被挂载就会出现在 DOM 中。 */
vi.mock('@/components/policy/share-with-teams-card', () => ({
  ShareWithTeamsCard: ({ policyId }: { policyId: string }) => (
    <div data-testid="share-card" data-policy-id={policyId} />
  ),
}));
vi.mock('@/components/policy/policy-review-panel', () => ({
  PolicyReviewPanel: () => <div />,
}));
vi.mock('@/components/policy/policy-versions-tab', () => ({
  PolicyVersionsTab: () => <div />,
}));
vi.mock('@/components/policy/policy-analytics-section', () => ({
  PolicyAnalyticsSection: () => <div />,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

import { PolicyDetailContent } from
  '@/app/[locale]/(dashboard)/policies/[id]/policy-detail-content';

const policy = {
  id: 'pol-630',
  name: '共享门控',
  description: '',
  content: 'Module m.',
  version: 1,
  createdAt: '2026-10-27T00:00:00Z',
  updatedAt: '2026-10-27T00:00:00Z',
  _count: { executions: 0 },
};

/** 任意深度属性都可取、可当字符串用的文案桩（本用例只关心门控）。 */
function deepStub(): unknown {
  return new Proxy(function stub() {} as unknown as object, {
    get: (_t, k) => {
      if (k === Symbol.toPrimitive || k === 'toString') return () => 'x';
      if (k === 'then') return undefined;
      return deepStub();
    },
    apply: () => 'x',
  });
}
const translations = deepStub() as never;

afterEach(() => cleanup());

describe('策略详情页共享卡片门控（#630）', () => {
  it('开关关闭：不挂载共享卡片（不会请求 GET /shares）', () => {
    render(
      <PolicyDetailContent
        policy={policy as never}
        sharingEnabled={false}
        translations={translations}
        locale="de"
      />,
    );
    expect(screen.queryByTestId('share-card')).toBeNull();
  });

  it('未传开关时按关闭处理（fail-closed）', () => {
    render(
      <PolicyDetailContent policy={policy as never} translations={translations} locale="de" />,
    );
    expect(screen.queryByTestId('share-card')).toBeNull();
  });

  it('开关开启：挂载共享卡片并传入当前策略 id', () => {
    render(
      <PolicyDetailContent
        policy={policy as never}
        sharingEnabled
        translations={translations}
        locale="de"
      />,
    );
    expect(screen.getByTestId('share-card').getAttribute('data-policy-id')).toBe('pol-630');
  });
});
