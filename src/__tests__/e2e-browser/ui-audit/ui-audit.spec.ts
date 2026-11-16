/**
 * UI 审计（#774）：每个路由 × 视口（由 Playwright 项目决定：ui-audit-desktop 1440×900 / ui-audit-mobile 390×844）
 * × 语言（en、zh）× 主题（浅 / 深）检查链接、按钮、无障碍、布局并截全页图。
 *
 * 只针对本地栈（BASE_CLOUD 必须是回环地址）；运行方式见同目录 README.md。发现项写入 UI_AUDIT_OUT，
 * 用例本身对 critical / serious 级发现做 soft 断言失败，其余只记录。
 */
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { NOT_LOCAL, NOT_LOCAL_REASON } from '../local-stack/helpers';
import { MOBILE_MIN_TARGET, collectLayout, collectLinks } from './page-checks';
import { BLOCKED_HEADER, probeButtons, probePopups, walkFocus } from './interactions';
import { type AuditContext, type Finding, recordCoverage, recordFinding, recordLinks, screenshotPath } from './recorder';
import { type AuditRoute, buildRoleSweep, buildRoutes, localePath, stateFile } from './routes';

const LOCALES = (process.env.UI_AUDIT_LOCALES || 'en,zh').split(',').map((s) => s.trim()).filter(Boolean);
const ONLY = process.env.UI_AUDIT_ONLY ? new RegExp(process.env.UI_AUDIT_ONLY) : null;
const PROBE_BUTTONS = process.env.UI_AUDIT_BUTTONS !== '0';
const SCREENSHOTS = process.env.UI_AUDIT_SCREENSHOTS !== '0';
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
// 外壳（页眉 / 侧栏 / 页脚）的按钮在每页都一样，只在这两个页面探测
const SHELL_PROBE = new Set(['anon:', 'ui-pro:dashboard']);
// 错误边界与 404 页的标题（@aster-cloud/ui-messages common.somethingWrong / notFoundTitle）
const ERROR_HEADING = /^(Something went wrong|Page not found|出错了|页面未找到)$/;

test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
test.describe.configure({ mode: 'parallel' });

const matches = (r: AuditRoute) => !ONLY || ONLY.test(r.path) || ONLY.test(r.pattern);

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  // 等字体与入场动画落定，避免布局量到过渡中的尺寸
  await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
  await page.waitForTimeout(300);
}

async function runAxe(page: Page, theme: 'light' | 'dark', emit: (f: Omit<Finding, keyof AuditContext>) => void): Promise<void> {
  const builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  // 深色主题只复查对比度，其余规则与主题无关
  if (theme === 'dark') builder.withRules(['color-contrast', 'link-in-text-block']);
  const res = await builder.analyze().catch((e: Error) => {
    emit({ severity: 'minor', category: 'axe-error', message: `axe failed: ${e.message.split('\n')[0]}` });
    return null;
  });
  for (const v of res?.violations ?? []) {
    const sev = (v.impact ?? 'minor') as Finding['severity'];
    emit({
      severity: sev,
      category: `axe:${v.id}`,
      message: `${v.help} (${v.nodes.length} node${v.nodes.length > 1 ? 's' : ''})`,
      detail: v.nodes.slice(0, 4).map((n) => `${n.target.join(' ')}${n.failureSummary ? ` — ${n.failureSummary.split('\n').slice(1, 2).join('').trim()}` : ''}`).join('\n'),
    });
  }
}

async function auditPage(page: Page, ctx: AuditContext, route: AuditRoute, deep: boolean): Promise<Finding[]> {
  const findings: Finding[] = [];
  const mobile = ctx.viewport === 'mobile';
  let theme: 'light' | 'dark' = 'light';
  const emit = (f: Omit<Finding, keyof AuditContext>) => {
    const row = { ...ctx, theme, ...f };
    findings.push(row);
    recordFinding(row);
  };
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message.split('\n')[0]));
  const serverErrors: string[] = [];
  page.on('response', (r) => {
    if (r.status() < 500 || r.headers()[BLOCKED_HEADER]) return;
    if (r.url().startsWith(new URL(page.url() || 'http://x').origin)) serverErrors.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });

  const started = Date.now();
  const target = localePath(ctx.locale, route.path);
  const resp = await page.goto(target, { waitUntil: 'load' });
  await settle(page);
  const status = resp?.status() ?? 0;
  const finalUrl = new URL(page.url());
  const checks: string[] = ['load'];

  if (status >= 500) emit({ severity: 'critical', category: 'page-5xx', message: `Page returned HTTP ${status}` });
  else if (status >= 400 && !route.expectErrorState) emit({ severity: 'serious', category: 'page-4xx', message: `Page returned HTTP ${status}` });
  if (route.role !== 'anon' && /\/login(\b|$)/.test(finalUrl.pathname)) {
    emit({ severity: 'critical', category: 'session-rejected', message: `Signed-in ${route.role} was redirected to ${finalUrl.pathname}` });
  }
  const heading = (await page.locator('h1, h2').first().textContent({ timeout: 2_000 }).catch(() => ''))?.trim() ?? '';
  if (ERROR_HEADING.test(heading) && !route.expectErrorState) {
    emit({ severity: 'serious', category: 'page-error-state', message: `Page rendered "${heading}" instead of content (final URL ${finalUrl.pathname})` });
  }

  // —— 浅色主题：布局 / 链接 / 无障碍 / 焦点 / 截图 ——
  const layout = await page.evaluate(collectLayout, { mobile, minTarget: MOBILE_MIN_TARGET });
  checks.push('layout');
  if (layout.scrollWidth > layout.clientWidth + 1) {
    emit({
      severity: mobile ? 'serious' : 'moderate',
      category: 'horizontal-overflow',
      message: `Page scrolls horizontally: scrollWidth ${layout.scrollWidth}px > viewport ${layout.clientWidth}px`,
      detail: layout.overflowOffenders.map((o) => `${o.selector} "${o.text}" x=${o.box.x} w=${o.box.w}`).join('\n'),
    });
  }
  // 移动端点击目标下限 44×44 CSS px（项目规范，WCAG 2.5.5 AAA / Apple HIG）；句中行内链接按 WCAG 例外豁免
  if (layout.smallTargets.length) {
    emit({
      severity: 'serious',
      category: 'tap-target-lt-44',
      message: `${layout.smallTargets.length} tap target(s) under 44×44 CSS px on mobile`,
      detail: layout.smallTargets.slice(0, 8).map((t) => `${t.min}px ${t.selector} "${t.text}"`).join('\n'),
    });
  }
  for (const c of layout.cardIssues) {
    const sev = c.kind === 'overlap' || c.kind === 'overflow' ? 'moderate' : 'minor';
    emit({ severity: sev, category: `card-${c.kind}`, message: `Card grid ${c.kind} inconsistency`, detail: `${c.grid}: ${c.detail}` });
  }

  const links = await page.evaluate(collectLinks);
  checks.push('links');
  const host = finalUrl.origin;
  for (const l of links) {
    if (l.inShell && !SHELL_PROBE.has(`${route.role}:${route.path}`)) continue;
    const label = `"${l.text || '(no text)'}"`;
    if (l.href === null) emit({ severity: 'moderate', category: 'link-no-href', message: `<a> without href ${label} (not keyboard reachable; use a button)` });
    else if (l.href.trim() === '' || l.href === '#') emit({ severity: 'moderate', category: 'link-dead-hash', message: `Link ${label} has a dead "${l.href}" href` });
    else if (/^javascript:/i.test(l.href)) emit({ severity: 'moderate', category: 'link-javascript', message: `Link ${label} uses a javascript: href` });
    else if (l.hashTargetMissing) emit({ severity: 'minor', category: 'link-hash-missing-target', message: `In-page anchor ${l.href} ${label} has no matching id` });
    if (l.target === '_blank' && !/noopener|noreferrer/.test(l.rel ?? '')) {
      emit({ severity: 'minor', category: 'link-blank-no-rel', message: `target=_blank link ${label} lacks rel="noopener noreferrer"`, detail: l.resolved });
    }
  }
  recordLinks({
    ...ctx,
    links: links
      .filter((l) => l.href && !l.href.startsWith('#') && /^https?:/.test(l.resolved))
      .map((l) => ({ url: l.resolved.split('#')[0], text: l.text }))
      .filter((l, i, arr) => arr.findIndex((x) => x.url === l.url) === i)
      .map((l) => ({ ...l, url: l.url.startsWith(host) ? l.url.slice(host.length) || '/' : l.url })),
  });

  await runAxe(page, 'light', emit);
  checks.push('axe-light');

  if (deep) {
    const focus = await walkFocus(page);
    checks.push('focus');
    if (focus.invisible.length) {
      emit({ severity: 'moderate', category: 'focus-not-visible', message: `${focus.invisible.length} focusable element(s) without a visible focus indicator`, detail: focus.invisible.slice(0, 8).join('\n') });
    }
  }
  if (SCREENSHOTS) {
    const file = screenshotPath(ctx, 'light');
    mkdirSync(dirname(file), { recursive: true });
    await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
    checks.push('screenshot-light');
  }

  // —— 深色主题：对比度 + 溢出 + 截图 ——
  theme = 'dark';
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark', null, { timeout: 3_000 }).catch(() => undefined);
  await page.waitForTimeout(200);
  const darkLayout = await page.evaluate(collectLayout, { mobile: false, minTarget: MOBILE_MIN_TARGET });
  if (darkLayout.dataTheme !== 'dark') {
    emit({ severity: 'moderate', category: 'theme-not-applied', message: `prefers-color-scheme: dark did not switch data-theme (got ${darkLayout.dataTheme})` });
  }
  await runAxe(page, 'dark', emit);
  checks.push('axe-dark');
  if (SCREENSHOTS) {
    const file = screenshotPath(ctx, 'dark');
    mkdirSync(dirname(file), { recursive: true });
    await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
    checks.push('screenshot-dark');
  }

  // —— 交互探测放在最后：外壳上的主题 / 语言切换会改写持久化偏好，不能污染上面的主题检查 ——
  if (deep && PROBE_BUTTONS && ctx.locale === 'en') {
    theme = 'light';
    await page.emulateMedia({ colorScheme: 'light' });
    const shell = SHELL_PROBE.has(`${route.role}:${route.path}`);
    const popups = await probePopups(page, shell, emit);
    const buttons = await probeButtons(page.context(), page, shell, emit);
    checks.push(`popups:${popups}`, `buttons:${buttons}`);
  }

  for (const e of Array.from(new Set(pageErrors)).slice(0, 5)) emit({ severity: 'moderate', category: 'js-error', message: `Uncaught error: ${e}` });
  if (serverErrors.length) emit({ severity: 'serious', category: 'api-5xx', message: `${serverErrors.length} same-origin request(s) returned 5xx`, detail: Array.from(new Set(serverErrors)).slice(0, 6).join('\n') });

  recordCoverage({ ...ctx, status, finalUrl: finalUrl.pathname, ms: Date.now() - started, checks });
  return findings;
}

function defineAudit(route: AuditRoute, locale: string, deep: boolean): void {
  const label = `${locale} ${route.role} /${route.path}${deep ? '' : ' [role-sweep]'}`;
  test.describe(label, () => {
    test.use({ storageState: stateFile(route.role) ?? { cookies: [], origins: [] } });
    test('audit', async ({ page }, info) => {
      test.setTimeout(deep ? 300_000 : 120_000);
      const viewport = info.project.name.endsWith('mobile') ? 'mobile' : 'desktop';
      const ctx: AuditContext = { route: route.pattern, path: route.path, role: route.role, locale, viewport };
      const findings = await auditPage(page, ctx, route, deep);
      const blocking = findings.filter((f) => f.severity === 'critical' || f.severity === 'serious');
      expect.soft(blocking.map((f) => `[${f.severity}] ${f.category}: ${f.message}`), `${label} (${viewport})`).toEqual([]);
    });
  });
}

for (const route of buildRoutes().filter(matches)) {
  for (const locale of LOCALES) defineAudit(route, locale, true);
}
for (const route of buildRoleSweep().filter(matches)) defineAudit(route, 'en', false);
