import { test, expect } from '@playwright/test';

/**
 * AI Guardian 嵌入：/demos/guardian 渲染 aster-lang.dev 的剧情 iframe 并到达第一拍。
 * 本地验证：BASE_CLOUD=http://localhost:3110，且构建与启动时
 * NEXT_PUBLIC_GUARDIAN_EMBED_URL 指向本地 aster-dev（http://localhost:3210/embed/guardian）。
 */
test.describe('AI Guardian embed', () => {
  test('demo page embeds the story and reaches the first beat', async ({ page }) => {
    await page.goto('/en/demos/guardian');
    const frame = page.frameLocator('iframe[src*="/embed/guardian/en"]');
    await expect(frame.getByText('My €40 order arrived broken.')).toBeVisible({ timeout: 20_000 });
    await expect(frame.getByRole('button', { name: /^(pause|play)$/i })).toBeVisible();
  });

  test('landing shows the poster until scrolled near, then the iframe', async ({ page }) => {
    await page.goto('/en');
    await expect(page.locator('img[src="/images/guardian-poster.webp"]')).toHaveCount(1);
    await page.locator('img[src="/images/guardian-poster.webp"]').scrollIntoViewIfNeeded();
    await expect(page.locator('iframe[src*="/embed/guardian/"]')).toHaveCount(1, { timeout: 10_000 });
  });
});
