import { test, expect, type Frame, type Page } from '@playwright/test';

/**
 * AI Guardian 嵌入：/demos/guardian 渲染 aster-lang.dev 的剧情 iframe 并到达第一拍；
 * 桌面与手机宽度下都能在嵌入框内单步看完剧情（含结尾「亲手试试」）而不滚动。
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

  // 嵌入框：md 起 16:10（1280 宽视口下约 896×560），更窄时固定 560 px 高；剧情须在框内看完而不滚动。
  for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 812 }]) {
    test(`story steps to the end inside the embed box without scrolling at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/en/demos/guardian');
      const iframe = page.locator('iframe[src*="/embed/guardian/en"]');
      await iframe.scrollIntoViewIfNeeded();
      const frame = page.frameLocator('iframe[src*="/embed/guardian/en"]');
      const next = frame.getByRole('button', { name: 'Next step', exact: true });
      await expect(next).toBeVisible({ timeout: 20_000 });
      const doc = await embedFrame(page);

      // 剧情共 15 个提示；播完后「下一步」以 aria-disabled 标记。每一步都检查嵌入文档不纵向滚动。
      for (let i = 0; i < 20 && (await next.getAttribute('aria-disabled')) !== 'true'; i++) {
        await next.click();
        expect(await verticalOverflow(doc)).toBeLessThanOrEqual(2);
      }
      await expect(next).toHaveAttribute('aria-disabled', 'true');

      const tryIt = frame.getByRole('link', { name: /try it yourself/i });
      await expect(tryIt).toBeVisible();
      const box = await tryIt.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: window.innerWidth, h: window.innerHeight };
      });
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(box.h);
      expect(box.right).toBeLessThanOrEqual(box.w);
      expect(await verticalOverflow(doc)).toBeLessThanOrEqual(2);
    });
  }

  test('landing shows the poster until scrolled near, then the iframe', async ({ page }) => {
    await page.goto('/en');
    await expect(page.locator('img[src="/images/guardian-poster.webp"]')).toHaveCount(1);
    await page.locator('img[src="/images/guardian-poster.webp"]').scrollIntoViewIfNeeded();
    await expect(page.locator('iframe[src*="/embed/guardian/"]')).toHaveCount(1, { timeout: 10_000 });
  });
});

/** 嵌入 iframe 的文档（跨源也可求值）。 */
async function embedFrame(page: Page): Promise<Frame> {
  const handle = await page.locator('iframe[src*="/embed/guardian/en"]').elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error('guardian embed iframe has no frame');
  return frame;
}

/** 嵌入文档纵向可滚动的像素数：scrollHeight − innerHeight。 */
function verticalOverflow(frame: Frame): Promise<number> {
  return frame.evaluate(() => (document.scrollingElement?.scrollHeight ?? 0) - window.innerHeight);
}
