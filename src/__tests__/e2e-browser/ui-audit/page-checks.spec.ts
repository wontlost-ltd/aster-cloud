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

  test('a fixed floating button over the page does not cancel a hit area; touching segmented buttons do not overlap', async ({ page }) => {
    const body = `<button style="position:fixed;left:30px;top:30px;width:48px;height:48px">FAB</button>
      <div style="padding:40px;display:flex"><button class="tap-target" style="font:12px/24px sans-serif;width:60px">Week</button><button class="tap-target" style="font:12px/24px sans-serif;width:60px">Month</button></div>`;
    expect(await small(page, body)).toEqual([]);
  });

  test('a hidden pseudo-element or one clipped by an ancestor does not count', async ({ page }) => {
    const hidden = '<style>.h::after{visibility:hidden}</style><div style="padding:40px"><button class="tap-target h" style="font:12px/16px sans-serif">Copy</button></div>';
    expect(await small(page, hidden)).toEqual(['Copy']);
    const clipped = '<div style="padding:40px"><div style="overflow:hidden;height:20px"><button class="tap-target" style="font:12px/16px sans-serif">Copy</button></div></div>';
    expect(await small(page, clipped)).toEqual(['Copy']);
  });

  test('an off-centre pseudo-element that does not cover the element does not count', async ({ page }) => {
    const off = '<style>.o{position:relative}.o::after{content:"";position:absolute;left:60px;top:0;width:44px;height:44px}</style><div style="padding:40px"><button class="o" style="font:12px/16px sans-serif">Copy</button></div>';
    expect(await small(page, off)).toEqual(['Copy']);
  });

  test('hit testing works below the fold on pages with smooth scrolling', async ({ page }) => {
    const body = '<style>html{scroll-behavior:smooth}</style><div style="height:2000px"></div><div style="padding:40px"><button class="tap-target" style="font:12px/16px sans-serif">Copy</button></div>';
    expect(await small(page, body)).toEqual([]);
  });

  test('a fixed floating layer covering the target at every scroll position does not let it pass', async ({ page }) => {
    const body = '<style>body{margin:0}</style><div style="padding:40px"><button class="tap-target" style="font:12px/16px sans-serif">Copy</button></div><div style="position:fixed;inset:0;background:transparent"></div>';
    expect(await small(page, body)).toEqual(['Copy']);
  });

  test('a small fixed layer covering part of the hit area between corner samples is caught', async ({ page }) => {
    const body = '<style>body{margin:0}</style><div style="padding:40px"><button class="tap-target" style="font:12px/16px sans-serif;width:44px">Copy</button></div><div style="position:fixed;inset:0;pointer-events:none"></div><div id="cover" style="position:absolute;width:8px;height:8px"></div><script>const b=document.querySelector("button").getBoundingClientRect();const c=document.getElementById("cover");c.style.left=(b.left+b.width/2-11)+"px";c.style.top=(b.top+b.height/2+6)+"px";</script>';
    expect(await small(page, body)).toEqual(['Copy']);
  });

  test('targets further down an inner scroll list are hit-tested after scrolling the list, which is then restored', async ({ page }) => {
    const rows = Array.from({ length: 8 }, (_, i) => `<li style="height:66px;display:flex;align-items:center"><button class="tap-target" style="font:12px/16px sans-serif;width:60px">Grant ${i}</button></li>`).join('');
    await page.setContent(`${HIT_AREA}<body style="margin:0"><div id="box" style="height:200px;overflow-y:auto;margin:40px"><ul style="margin:0;padding:0;list-style:none">${rows}</ul></div></body>`);
    const res = await page.evaluate(collectLayout, { mobile: true, minTarget: MOBILE_MIN_TARGET });
    expect(res.smallTargets.map((t) => t.text)).toEqual([]);
    expect(await page.evaluate(() => (document.getElementById('box') as HTMLElement).scrollTop)).toBe(0);
  });

  test('disabled controls are not tap targets', async ({ page }) => {
    expect(await small(page, '<div style="padding:40px"><button disabled style="font:12px/16px sans-serif">Add</button></div>')).toEqual([]);
  });

  test('enlarged hit areas that overlap each other (boxes not touching) do not count for either target', async ({ page }) => {
    const list = '<div style="padding:40px">' + ['One', 'Two'].map((t) => `<a href="/${t}" class="tap-target" style="display:block;font:14px/20px sans-serif;width:200px;margin-bottom:12px">${t}</a>`).join('') + '</div>';
    expect(await small(page, list)).toEqual(['One', 'Two']);
  });

  test('links inside a sentence are exempt; inline links in a navigation row are not', async ({ page }) => {
    expect(await small(page, '<p style="font:14px/20px sans-serif">Read the <a href="/d">docs</a> before you start.</p>')).toEqual([]);
    expect(await small(page, '<div style="font:14px/20px sans-serif">Home · <a href="/d">Docs</a> · Blog</div>')).toEqual(['Docs']);
  });

  test('a disabled neighbour does not cancel a hit area', async ({ page }) => {
    const body = '<div style="padding:40px"><button class="tap-target" style="font:12px/16px sans-serif;width:60px">Copy</button><div style="height:4px"></div><button disabled style="font:12px/16px sans-serif;width:60px">Off</button></div>';
    expect(await small(page, body)).toEqual([]);
  });
});

test.describe('page title structure', () => {
  test('flags two h1s, a heading that repeats the h1 and a link-less breadcrumb', async ({ page }) => {
    await page.setContent(`<nav aria-label="Breadcrumb navigation"><ol><li>Approvals</li></ol></nav><h1>Approvals</h1><h2>Approvals</h2><h1>Other</h1>`);
    const r = await page.evaluate(collectStructure);
    expect(r.h1).toEqual(['approvals', 'other']);
    expect(r.duplicateHeadings).toEqual(['h2 "Approvals"']);
    expect(r.redundantBreadcrumbs).toEqual(['"Approvals"']);
  });

  test('ignores headings and actions inside a transparent ancestor; compares rendered heading text', async ({ page }) => {
    await page.setContent(`<h1>Reports</h1><div style="opacity:0"><h2>Reports</h2></div><h2>Reports<span style="display:none"> (beta)</span></h2>`);
    const r = await page.evaluate(collectStructure);
    expect(r.duplicateHeadings).toEqual(['h2 "Reports (beta)"']);
  });

  test('ignores headings inside a closed <details> or an aria-hidden ancestor', async ({ page }) => {
    await page.setContent(`<h1>Reports</h1><details><summary>More</summary><h2>Reports</h2></details><div aria-hidden="true"><h2>Reports</h2></div>`);
    expect((await page.evaluate(collectStructure)).duplicateHeadings).toEqual([]);
  });

  test('counts screen-reader-only h1s but not display:none or transparent ones', async ({ page }) => {
    await page.setContent(`<h1>Main</h1><h1 style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Extra</h1><h1 style="display:none">Gone</h1><div style="opacity:0"><h1>Faded</h1></div>`);
    expect((await page.evaluate(collectStructure)).h1).toEqual(['main', 'extra']);
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

  test('an action only partly showing in a horizontal scroller is reported; a switch role counts too', async ({ page }) => {
    await page.setContent(`<div style="overflow-x:auto;width:300px"><div style="display:flex;width:700px">
      <div style="width:280px;flex:none">…</div><button style="width:120px;flex:none">Approve</button><span role="switch" aria-checked="false" tabindex="0" style="display:inline-block;flex:none;width:44px;height:24px;margin-left:200px">x</span></div></div>`);
    const r = await page.evaluate(collectStructure);
    expect(r.clippedActions.map((c) => c.text)).toEqual(['Approve', 'x']);
  });

  test('an action cut off by overflow:hidden is reported as unreachable', async ({ page }) => {
    await page.setContent(`<div style="overflow:hidden;height:40px"><p style="height:40px;margin:0">Card</p><button>Accept</button></div>`);
    const r = await page.evaluate(collectStructure);
    expect(r.clippedActions.map((c) => [c.text, c.kind])).toEqual([['Accept', 'hidden']]);
  });

  test('clipping is judged per axis: overflow-y hidden with horizontal scrolling only reports vertical cut-offs', async ({ page }) => {
    await page.setContent(`<div style="overflow-x:auto;overflow-y:hidden;width:300px;height:60px;white-space:nowrap"><span style="display:inline-block;width:200px"></span><button style="width:80px">Wide</button></div>`);
    expect((await page.evaluate(collectStructure)).clippedActions.filter((c) => c.kind === 'hidden')).toEqual([]);
  });

  test('vertical scroll lists are a normal pattern and not reported', async ({ page }) => {
    await page.setContent(`<nav style="overflow-y:auto;height:60px">${Array.from({ length: 6 }, (_, i) => `<a href="/${i}" style="display:block;height:30px">Item ${i}</a>`).join('')}</nav>`);
    const r = await page.evaluate(collectStructure);
    expect(r.clippedActions).toEqual([]);
  });
});
