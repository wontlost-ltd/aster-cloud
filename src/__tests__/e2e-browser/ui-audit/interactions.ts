/**
 * UI 审计（#774）的交互探测：逐个点击按钮看是否有可观察效果、键盘打开菜单 / 对话框并检查焦点陷阱与 Esc、
 * Tab 遍历检查焦点可见性。
 *
 * 安全约束：探测期间所有写请求、所有 API 读请求与已知有副作用的页面都被拦截并回 503（见 request-guard.ts），
 * 种子数据不会被改动。破坏性按钮若在没有确认
 * 步骤的情况下直接发出写请求，就是一条 serious 发现。
 */
import type { BrowserContext, Page } from '@playwright/test';
import { focusIndicator } from './page-checks';
import { classifyRequest } from './request-guard';
import { judgeClick } from './click-verdict';
import type { AuditContext, Finding } from './recorder';

type Emit = (f: Omit<Finding, keyof AuditContext>) => void;

interface Candidate {
  idx: number;
  name: string;
  disabled: boolean;
  hasReason: boolean;
  inForm: boolean;
  active: boolean;
}

const DESTRUCTIVE = /\b(delete|remove|revoke|destroy|purge|disable|deactivate|leave|cancel subscription)\b|删除|移除|撤销|吊销|停用|退出团队|清空/i;
const OPEN_POPUP = '[role=dialog]:visible, [role=alertdialog]:visible, [aria-modal="true"]:visible, [role=menu]:visible, [role=listbox]:visible';
const MAX_BUTTONS = 30;
/** 审计拦截写请求时伪造响应带的标记头 */
export const BLOCKED_HEADER = 'x-ui-audit-blocked';
const MAX_POPUPS = 10;
const SETTLE_MS = 700;

/** 在页面里给候选按钮打 data-ui-audit-btn 编号，返回名称与状态。includeShell=false 时跳过外壳（页眉 / 侧栏 / 页脚）。 */
async function tagButtons(page: Page, includeShell: boolean): Promise<Candidate[]> {
  return page.evaluate((shell) => {
    const q = 'button, [role=button], summary, [role=tab], [role=switch], input[type=submit], input[type=button]';
    const out: Array<{ idx: number; name: string; disabled: boolean; hasReason: boolean; inForm: boolean; active: boolean }> = [];
    let i = 0;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(q))) {
      el.removeAttribute('data-ui-audit-btn');
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || el.closest('[aria-hidden="true"], [inert]')) continue;
      if (!shell && el.closest('header, aside, nav, footer, [data-sonner-toaster]')) continue;
      const labelled = el.getAttribute('aria-labelledby');
      const name = (
        el.getAttribute('aria-label')
        || (labelled ? labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ') : '')
        || el.innerText
        || el.getAttribute('title')
        || (el as HTMLInputElement).value
        || ''
      ).trim().replace(/\s+/g, ' ').slice(0, 60);
      const disabled = (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
      const hasReason = !!(el.getAttribute('title') || el.getAttribute('aria-describedby') || el.closest('[title]'));
      el.setAttribute('data-ui-audit-btn', String(i));
      // 已处于选中态的切换按钮（分段控件、标签页）再点一次本就不该有变化
      const active = ['aria-pressed', 'aria-selected', 'aria-checked'].some((a) => el.getAttribute(a) === 'true')
        || ['active', 'on', 'checked'].includes(el.getAttribute('data-state') || '');
      out.push({ idx: i, name, disabled, hasReason, inForm: !!el.closest('form'), active });
      i += 1;
    }
    return out;
  }, includeShell);
}

async function startMutationCounter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __uiAuditMut: number; __uiAuditObs?: MutationObserver };
    w.__uiAuditObs?.disconnect();
    w.__uiAuditMut = 0;
    w.__uiAuditObs = new MutationObserver((m) => {
      // 忽略自身打的编号属性
      w.__uiAuditMut += m.filter((x) => x.attributeName !== 'data-ui-audit-btn').length;
    });
    w.__uiAuditObs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
}

const mutationCount = (page: Page) =>
  page.evaluate(() => (window as unknown as { __uiAuditMut?: number }).__uiAuditMut ?? 0).catch(() => 0);

async function restore(page: Page, url: string, force: boolean): Promise<void> {
  if (force || page.url() !== url) {
    await page.goto(url, { waitUntil: 'load' }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    return;
  }
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(200);
  if (await page.locator(OPEN_POPUP).count().catch(() => 0)) {
    await page.reload({ waitUntil: 'load' }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  }
}

/**
 * 逐个点击按钮。可观察效果 = URL 变化 / 网络请求 / DOM 变化 / 原生对话框 / 新窗口 / 下载 / 表单校验提示。
 */
export async function probeButtons(context: BrowserContext, page: Page, includeShell: boolean, emit: Emit): Promise<number> {
  const mutating: Array<{ method: string; url: string }> = [];
  // 每次点击重置：放行的请求数、被拦的 API 请求、第一个被拦请求时的 DOM 变化数
  let allowedRequests = 0;
  let blocked: string[] = [];
  let mutAtFirstBlock: number | null = null;
  const COUNTED = ['fetch', 'xhr', 'document', 'eventsource', 'websocket'];
  // 后台请求（轮询、预取等）：在两次点击之间出现过的 方法+路径。点击窗口里再出现的同类请求与按钮无关，不计入判定
  let clicking = false;
  const background = new Set<string>();
  await page.route('**/*', async (route) => {
    const req = route.request();
    const decision = classifyRequest(req.method(), req.url());
    const key = `${req.method()} ${new URL(req.url()).pathname}`;
    const counted = COUNTED.includes(req.resourceType());
    if (counted && !clicking) background.add(key);
    const fromClick = counted && clicking && !background.has(key);
    if (decision === 'allow') {
      if (fromClick) allowedRequests += 1;
      return route.continue();
    }
    // 写请求一律参与「破坏性操作无确认」判定；被拦的请求（读与写）都不算按钮有效果
    if (decision === 'block-write') mutating.push({ method: req.method(), url: req.url() });
    if (fromClick || decision === 'block-write') {
      if (mutAtFirstBlock === null) mutAtFirstBlock = await mutationCount(page);
      blocked.push(key);
    }
    // 带标记头，页面级 5xx 统计据此排除审计自己伪造的响应
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      headers: { [BLOCKED_HEADER]: '1' },
      body: '{"error":"ui-audit: mutation blocked"}',
    });
  });
  let nativeDialog = false;
  const onDialog = (d: { dismiss(): Promise<void> }) => {
    nativeDialog = true;
    void d.dismiss().catch(() => undefined);
  };
  page.on('dialog', onDialog);

  // window.print() 在无头浏览器里没有可见效果：替换成计数器，打印按钮才不会被误判为死按钮
  await page.evaluate(() => {
    const w = window as unknown as { __uiAuditPrints: number };
    w.__uiAuditPrints = 0;
    window.print = () => { w.__uiAuditPrints += 1; };
  });
  const prints = () => page.evaluate(() => (window as unknown as { __uiAuditPrints?: number }).__uiAuditPrints ?? 0).catch(() => 0);
  const origin = page.url();
  const seen = new Set<string>();
  let probed = 0;
  try {
    let candidates = await tagButtons(page, includeShell);
    const total = candidates.length;
    for (let k = 0; k < total && probed < MAX_BUTTONS; k += 1) {
      const c = candidates.find((x) => x.idx === k);
      if (!c) continue;
      const key = c.name || `#${k}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (c.disabled) {
        if (!c.hasReason) {
          emit({ severity: 'minor', category: 'button-disabled-no-reason', message: `Disabled button "${c.name}" gives no reason (title / aria-describedby)` });
        }
        continue;
      }
      probed += 1;
      await startMutationCounter(page);
      allowedRequests = 0;
      blocked = [];
      mutAtFirstBlock = null;
      nativeDialog = false;
      const mutBefore = mutating.length;
      const printsBefore = await prints();
      const pagesBefore = context.pages().length;
      let downloaded = false;
      const onDownload = () => { downloaded = true; };
      page.once('download', onDownload);
      const target = page.locator(`[data-ui-audit-btn="${k}"]`);
      let clickError: string | null = null;
      clicking = true;
      await target.click({ timeout: 3_000 }).catch((e: Error) => { clickError = e.message.split('\n')[0]; });
      await page.waitForTimeout(SETTLE_MS);
      clicking = false;
      page.off('download', onDownload);
      const urlChanged = page.url() !== origin;
      const printed = (await prints()) > printsBefore;
      const popup = context.pages().length > pagesBefore;
      const mut = await mutationCount(page);
      const invalidForm = c.inForm ? await page.locator(':invalid').count().catch(() => 0) : 0;
      const confirmShown = nativeDialog || (await page.locator('[role=dialog]:visible, [role=alertdialog]:visible').count().catch(() => 0)) > 0;
      const wrote = mutating.slice(mutBefore);

      const verdict = judgeClick({
        active: c.active, urlChanged, popup, downloaded, printed, nativeDialog, invalidForm: invalidForm > 0,
        allowedRequests, blocked,
        mutationsBeforeBlock: mutAtFirstBlock ?? mut, mutationsTotal: mut,
      });
      if (clickError) {
        emit({ severity: 'moderate', category: 'button-not-clickable', message: `Button "${c.name}" could not be clicked`, detail: clickError });
      } else if (verdict === 'dead') {
        emit({ severity: 'moderate', category: 'button-dead', message: `Button "${c.name}" has no observable effect (no navigation, dialog, request or DOM change)` });
      } else if (verdict === 'unverified') {
        emit({
          severity: 'minor',
          category: 'button-effect-unverified',
          message: `Button "${c.name}" only triggers API requests that the audit blocks; its effect could not be verified`,
          detail: Array.from(new Set(blocked)).slice(0, 5).join(', '),
        });
      }
      if (DESTRUCTIVE.test(c.name) && wrote.length > 0 && !confirmShown) {
        emit({
          severity: 'serious',
          category: 'destructive-no-confirm',
          message: `Destructive button "${c.name}" sends a write request without a confirmation step`,
          detail: wrote.map((w) => `${w.method} ${new URL(w.url).pathname}`).join(', '),
        });
      }
      for (const p of context.pages().slice(pagesBefore)) await p.close().catch(() => undefined);
      await restore(page, origin, urlChanged || wrote.length > 0);
      candidates = await tagButtons(page, includeShell);
      // 按钮数量变了，同序号可能已不是同一个按钮：整页重载再编号
      if (candidates.length !== total) {
        await restore(page, origin, true);
        candidates = await tagButtons(page, includeShell);
      }
    }
  } finally {
    page.off('dialog', onDialog);
    await page.unroute('**/*').catch(() => undefined);
  }
  return probed;
}

/**
 * 键盘打开菜单 / 对话框：Enter 打开 → 模态对话框须困住焦点 → Esc 关闭 → 焦点回到触发按钮。
 */
export async function probePopups(page: Page, includeShell: boolean, emit: Emit): Promise<number> {
  const origin = page.url();
  const triggers = await page.evaluate((shell) => {
    const out: Array<{ idx: number; name: string; haspopup: string | null }> = [];
    let i = 0;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[aria-haspopup]:not([aria-haspopup="false"]), button[aria-expanded="false"], [role=button][aria-expanded="false"]'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || el.closest('[aria-hidden="true"], [inert]')) continue;
      if (!shell && el.closest('header, aside, nav, footer')) continue;
      el.setAttribute('data-ui-audit-popup', String(i));
      out.push({ idx: i, name: (el.getAttribute('aria-label') || el.innerText || '').trim().slice(0, 50), haspopup: el.getAttribute('aria-haspopup') });
      i += 1;
    }
    return out;
  }, includeShell);

  let checked = 0;
  for (const t of triggers.slice(0, MAX_POPUPS)) {
    const trigger = page.locator(`[data-ui-audit-popup="${t.idx}"]`);
    if (!(await trigger.count())) continue;
    checked += 1;
    await trigger.focus().catch(() => undefined);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const expanded = await trigger.getAttribute('aria-expanded').catch(() => null);
    const popupCount = await page.locator(OPEN_POPUP).count().catch(() => 0);
    if (page.url() !== origin) {
      await restore(page, origin, true);
      continue;
    }
    if (expanded !== 'true' && popupCount === 0) {
      emit({ severity: 'moderate', category: 'popup-not-keyboard-operable', message: `"${t.name}" (aria-expanded/haspopup) did not open with Enter` });
      await restore(page, origin, false);
      continue;
    }
    // 只有弹出层（对话框 / 菜单 / 列表框）才要求 Esc 关闭；行内折叠面板不要求
    if (popupCount > 0) {
      const modal = page.locator('[role=dialog][aria-modal="true"]:visible, [role=alertdialog]:visible, [aria-modal="true"]:visible').last();
      if (await modal.count()) {
        // 打开模态层后焦点应已在层内（WCAG 2.4.3）
        const focusedInside = await modal.evaluate((m) => m.contains(document.activeElement)).catch(() => true);
        if (!focusedInside) emit({ severity: 'moderate', category: 'dialog-initial-focus', message: `Modal opened by "${t.name}" leaves focus outside the dialog` });
        // Tab 次数 = 层内可聚焦元素数 + 2，确保能走完一整圈
        const stops = await modal.evaluate((m) => m.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])').length).catch(() => 10);
        let escaped = false;
        for (let n = 0; n < Math.min(stops + 2, 60) && !escaped; n += 1) {
          await page.keyboard.press('Tab');
          escaped = !(await modal.evaluate((m) => m.contains(document.activeElement)).catch(() => true));
        }
        if (escaped) emit({ severity: 'serious', category: 'focus-trap-missing', message: `Modal opened by "${t.name}" does not trap focus (Tab leaves the dialog)` });
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const still = await page.locator(OPEN_POPUP).count().catch(() => 0);
      if (still >= popupCount) {
        emit({ severity: 'serious', category: 'esc-does-not-close', message: `Popup opened by "${t.name}" does not close on Escape` });
      } else {
        const restored = await trigger.evaluate((el) => el === document.activeElement || el.contains(document.activeElement)).catch(() => false);
        if (!restored) emit({ severity: 'moderate', category: 'focus-not-restored', message: `Focus does not return to "${t.name}" after closing its popup` });
      }
    }
    await restore(page, origin, false);
  }
  return checked;
}

/** Tab 遍历前 maxStops 个焦点，报告没有可见焦点指示的元素。 */
export async function walkFocus(page: Page, maxStops = 25): Promise<{ stops: number; invisible: string[] }> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  const invisible = new Set<string>();
  let stops = 0;
  for (let i = 0; i < maxStops; i += 1) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(focusIndicator).catch(() => null);
    if (!info) continue;
    stops += 1;
    if (!info.ok) invisible.add(`${info.selector} "${info.text}"`);
  }
  return { stops, invisible: Array.from(invisible) };
}
