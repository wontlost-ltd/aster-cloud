/**
 * 路由与服务单测用的 @/lib/policy-layout/store 替身：这些测试整体替换了 @/lib/prisma，
 * 真实存储无法查询；默认「没有任何 layout」，与 ADR 0058 之前的行为一致。
 * layout 的真实读写在 policy-layout-store / policy-version-layout 集成测试里覆盖。
 *
 * 用法：vi.mock('@/lib/policy-layout/store', async () =>
 *   (await import('@/__tests__/helpers/policy-layout-store-mock')).policyLayoutStoreModule());
 */
import { vi } from 'vitest';

export function policyLayoutStoreModule() {
  return {
    prepareLayout: vi.fn(() => {
      throw new Error('policy-layout-store-mock: prepareLayout is not expected in this test');
    }),
    insertVersionLayout: vi.fn(async () => undefined),
    loadVersionLayout: vi.fn(async () => ({ status: 'none' })),
    loadCarryCandidate: vi.fn(async () => ({ status: 'none' })),
    activeLayoutSha256: vi.fn(async () => null),
    activeLayoutSha256ForPolicy: vi.fn(async () => null),
  };
}
