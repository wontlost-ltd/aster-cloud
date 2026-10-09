import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E config for the aster-lang.dev + aster-lang.cloud
 * pair. Default targets production hosts so the suite double-checks
 * the deployed sites; override BASE_CLOUD / BASE_DEV to a local
 * `pnpm dev` for pre-push validation.
 *
 * E2E is intentionally NOT run by default — `pnpm test` (vitest) covers
 * unit + integration. Run E2E separately via `pnpm test:e2e:browser`.
 */
export default defineConfig({
  testDir: './src/__tests__/e2e-browser',
  // 本地栈冷启动预热；BASE_CLOUD 不含 localhost 时内部直接返回。
  globalSetup: './src/__tests__/e2e-browser/local-stack/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    trace: 'on-first-retry',
    // Defaults — individual specs override via test.use() when they
    // need to hit aster-lang.dev specifically.
    baseURL: process.env.BASE_CLOUD || 'https://aster-lang.cloud',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
