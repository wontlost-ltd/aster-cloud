import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * Vitest config — dual-project (saas + on-prem) deployment-mode coverage.
 *
 * 设计依据：.claude/plan/deployment-mode-flag-v2.md PR-10 + codex M3
 * （Vitest projects 单 vitest 进程 + 共享 vite cache，避免 fork 开销）。
 *
 * 成本模型：单命令 / 共享 cache，但断言数翻倍（每个测试文件在两种
 * deployment-mode 下分别 import + 执行）。实测 ~17s（vs 单模式 ~9s）—
 * 翻倍主要是测试 *次数* 翻倍，不是 fork 开销。
 *
 * 行为：
 *   - 默认 `pnpm test` / `pnpm test:run` 跑两个 project。同一测试文件
 *     在两种 DEPLOYMENT_MODE 下分别执行。
 *   - 模式特定测试用 `it.skipIf` 或文件级 process.env 判断屏蔽不适用
 *     的 project；剩下的测试在两种 mode 都跑（增加覆盖面）。
 *   - 模式专属路由 gate 行为（如 /admin/risk-tier 在 on-prem 返回 404）
 *     有独立测试文件（如 admin-risk-tier-on-prem.test.ts），不与业务
 *     逻辑测试混在一起。
 *   - 业务逻辑测试可以用 `vi.mock('@/lib/deployment-mode', ...)` 显式
 *     固定 mode（mock 优先级最高，让同一业务断言在两种 project 都跑）。
 *     新加 capability 时应显式列出，不要 spread —— 测试范围必须明确。
 *   - coverage 仅在 saas project 收集（pnpm test:coverage 已 pin 到
 *     --project saas）。on-prem 因为大量代码被 deployment-mode 折叠掉，
 *     合并覆盖率会让 branch coverage 解读混乱。
 *
 * 单 project 跑法（开发期 / CI 失败定位）：
 *   pnpm test:saas   # 仅 saas
 *   pnpm test:onprem # 仅 on-prem
 */

const sharedTestOptions = {
  environment: 'jsdom' as const,
  globals: true,
  setupFiles: ['./src/__tests__/setup.ts'],
  include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
  // 排除集成测试、E2E、Playwright 浏览器 E2E（各自独立 config 跑）
  exclude: [
    'src/__tests__/integration/**',
    'src/__tests__/e2e/**',
    'src/__tests__/e2e-agent-guard/**',
    'src/__tests__/e2e-browser/**',
    'node_modules/**',
  ],
  testTimeout: 30000,
};

const sharedResolve = {
  alias: {
    '@': path.resolve(__dirname, './src'),
  },
};

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        plugins: [react()],
        resolve: sharedResolve,
        test: {
          ...sharedTestOptions,
          name: 'saas',
          env: {
            DEPLOYMENT_MODE: 'saas',
            NEXT_PUBLIC_DEPLOYMENT_MODE: 'saas',
            // Unit tests that drive cron route handlers don't stub the
            // CronJobLease table; the lease-acquire layer is exercised
            // separately by the cron-lease integration test against
            // real Postgres.
            BYPASS_CRON_LEASE: '1',
          },
        },
      },
      {
        plugins: [react()],
        resolve: sharedResolve,
        test: {
          ...sharedTestOptions,
          name: 'on-prem',
          env: {
            DEPLOYMENT_MODE: 'on-prem',
            NEXT_PUBLIC_DEPLOYMENT_MODE: 'on-prem',
            BYPASS_CRON_LEASE: '1',
          },
        },
      },
    ],

    // Coverage 仅在 saas project 收集（pnpm test:coverage 默认跑 saas；
    // on-prem 因为大量代码被 deployment-mode 折叠掉，跑 coverage 会让
    // 数字不可比 / 失真）。
    coverage: {
      // 需要 @vitest/coverage-v8（未安装时 pnpm test:coverage 会引导安装）
      provider: 'v8',
      reporter: ['text', 'json', 'lcov', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'node_modules/',
        'src/__tests__/**',
        'src/scripts/**',
        // 客户端 UI 组件大量靠手工测试，暂不纳入门槛
        'src/components/policy/monaco-policy-editor.tsx',
        'src/app/[locale]/(marketing)/**',
        'src/instrumentation.ts',
        '**/*.d.ts',
        '**/*.config.{ts,js,mjs}',
      ],
      // CI 门槛：核心业务逻辑覆盖率
      // 仅对 lib/ 目录强约束（plan-quota / plans / mixpanel / env-validation 等纯逻辑）
      thresholds: {
        'src/lib/plan-quota.ts': {
          statements: 90,
          branches: 80,
          functions: 100,
          lines: 90,
        },
        'src/lib/env-validation.ts': {
          statements: 90,
          branches: 80,
          functions: 80,
          lines: 90,
        },
      },
    },
  },
  resolve: sharedResolve,
});
