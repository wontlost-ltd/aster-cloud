/**
 * UI 审计（#774）页面内规则的夹具用例：在真实 Chromium 里 setContent 小页面，确认规则本身判得对。
 * 不访问本地栈，随 `pnpm test:ui-audit` 的 ui-audit-desktop 项目一起跑。
 */
import { test, expect } from '@playwright/test';
import { MOBILE_MIN_TARGET, collectLayout, collectStructure } from './page-checks';

const HIT_AREA = `<style>
  .tap-target { position: relative; }
  .tap-target::after { content: ''; position: absolute; left: 50%; top: 50%; width: max(100%, 44px); height: max(100%, 44px); transform: translate(-50%, -50%); }
</style>`;

test.describe('tap targets (44px on mobile)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  const small = async (page: import('@playwright/test').Page, body: string) => {
    await page.setContent(`${HIT_AREA}<body style="margin:0">${body}</body>`);
    return (await page.evaluate(collectLayout, { mobile: true, minTarget: MOBILE_MIN_TARGET })).smallTargets.map((t) => t.text);
  };

  test('a 20px link is too small; padding to 44px fixes it', async ({ page }) => {
    expect(await small(page, '<div><a href="/a" style="display:inline-block;font:14px/20px sans-serif">Edit</a></div>')).toEqual(['Edit']);
    expect(await small(page, '<div><a href="/a" style="display:inline-block;font:14px/20px sans-serif;padding:12px">Edit</a></div>')).toEqual([]);
  });

  test('an isolated pseudo-element hit area counts', async ({ page }) => {
    expect(await small(page, '<div style="padding:40px"><button class="tap-target" style="font:12px/16px sans-serif">Copy</button></div>')).toEqual([]);
  });

  test('a hit area clipped by the element itself does not count', async ({ page }) => {
    expect(await small(page, '<div style="padding:40px"><button class="tap-target" style="font:12px/16px sans-serif;overflow:hidden">Copy</button></div>')).toEqual(['Copy']);
  });

  test('hit areas that overlap a neighbouring target do not count', async ({ page }) => {
    const list = '<div style="padding:40px">' + ['One', 'Two'].map((t) => `<a href="/${t}" class="tap-target" style="display:block;font:14px/20px sans-serif;width:200px">${t}</a>`).join('') + '</div>';
    expect(await small(page, list)).toEqual(['One', 'Two']);
  });

  test('targets inside a closed <details> neither count nor block a neighbour\'s hit area', async ({ page }) => {
    const body = `<details><summary style="display:block;height:44px">Sections</summary><a href="/x" style="display:block">Hidden</a></details>
      <div style="padding:20px 40px"><a href="/y" class="tap-target" style="display:inline-block;font:14px/20px sans-serif">Docs</a></div>`;
    expect(await small(page, body)).toEqual([]);
  });

  test('links inside a sentence are exempt', async ({ page }) => {
    expect(await small(page, '<p style="font:14px/20px sans-serif">Read the <a href="/d">docs</a> before you start.</p>')).toEqual([]);
  });
});

test.describe('page title structure', () => {
  test('flags two h1s, a heading that repeats the h1 and a link-less breadcrumb', async ({ page }) => {
    await page.setContent(`<nav aria-label="Breadcrumb"><ol><li>Approvals</li></ol></nav><h1>Approvals</h1><h2>Approvals</h2><h1>Other</h1>`);
    const r = await page.evaluate(collectStructure);
    expect(r.h1).toEqual(['approvals', 'other']);
    expect(r.duplicateHeadings).toEqual(['h2 "Approvals"']);
    expect(r.redundantBreadcrumbs).toEqual(['"Approvals"']);
  });

  test('accepts one h1 with a breadcrumb trail that links to its parent', async ({ page }) => {
    await page.setContent(`<nav aria-label="Breadcrumb"><ol><li><a href="/policies">Policies</a></li><li>Loan</li></ol></nav><h1>Loan</h1><h2>Versions</h2>`);
    const r = await page.evaluate(collectStructure);
    expect(r.h1).toEqual(['loan']);
    expect(r.duplicateHeadings).toEqual([]);
    expect(r.redundantBreadcrumbs).toEqual([]);
  });
});

test.describe('actionable items clipped by a container', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('an action pushed out of a horizontal scroller is reported; one in view is not', async ({ page }) => {
    await page.setContent(`<div style="overflow-x:auto;width:300px"><table style="width:600px"><tr>
      <td style="width:100px"><a href="/in">In view</a></td><td style="width:400px">…</td><td><a href="/out">Review</a></td></tr></table></div>`);
    const r = await page.evaluate(collectStructure);
    expect(r.clippedActions.map((c) => [c.text, c.kind])).toEqual([['Review', 'scroll']]);
  });

  test('an action cut off by overflow:hidden is reported as unreachable', async ({ page }) => {
    await page.setContent(`<div style="overflow:hidden;height:40px"><p style="height:40px;margin:0">Card</p><button>Accept</button></div>`);
    const r = await page.evaluate(collectStructure);
    expect(r.clippedActions.map((c) => [c.text, c.kind])).toEqual([['Accept', 'hidden']]);
  });

  test('vertical scroll lists are a normal pattern and not reported', async ({ page }) => {
    await page.setContent(`<nav style="overflow-y:auto;height:60px">${Array.from({ length: 6 }, (_, i) => `<a href="/${i}" style="display:block;height:30px">Item ${i}</a>`).join('')}</nav>`);
    const r = await page.evaluate(collectStructure);
    expect(r.clippedActions).toEqual([]);
  });
});
