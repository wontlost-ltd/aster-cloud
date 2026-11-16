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
// UI 审计（#774）公共设置：浅色起步（用例内再切深色）、减少动画；UI_AUDIT_CHROMIUM 可指定本机 Chromium
const UI_AUDIT_USE = {
  colorScheme: 'light' as const,
  reducedMotion: 'reduce' as const,
  // 复制按钮要能真正写剪贴板，否则会被误判为死按钮
  permissions: ['clipboard-read', 'clipboard-write'],
  ...(process.env.UI_AUDIT_CHROMIUM ? { launchOptions: { executablePath: process.env.UI_AUDIT_CHROMIUM } } : {}),
};

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
      // UI 审计（#774）只在下面专用项目里跑，避免被默认项目当成生产冒烟用例
      testIgnore: /ui-audit\//,
      use: { ...devices['Desktop Chrome'] },
    },
    // UI 审计（#774）：同一套页面用例按桌面 / 移动视口各跑一遍；链接校验在页面用例之后单独运行（见 scripts/ui-audit/run.mjs）
    {
      name: 'ui-audit-desktop',
      testMatch: /ui-audit\/ui-audit\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, ...UI_AUDIT_USE },
    },
    {
      name: 'ui-audit-mobile',
      testMatch: /ui-audit\/ui-audit\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        userAgent: devices['iPhone 13'].userAgent,
        ...UI_AUDIT_USE,
      },
    },
    {
      name: 'ui-audit-links',
      testMatch: /ui-audit\/links\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], ...UI_AUDIT_USE },
    },
  ],
});
