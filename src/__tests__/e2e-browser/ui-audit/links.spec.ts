/**
 * UI 审计（#774）链接校验：读取页面用例收集的 links.jsonl，站内链接以对应角色的会话 GET（跟随重定向），
 * 站外链接 HEAD（不支持时退回 GET）。必须在 ui-audit-desktop / ui-audit-mobile 之后运行。
 *
 * 判定：站内 4xx/5xx 或渲染了 404 兜底（Next 流式渲染时 notFound() 仍回 200，靠 RSC 里的
 * NEXT_HTTP_ERROR_FALLBACK;404 标记识别）为 serious；站外不可达为 minor（受网络影响，只提示）。
 */
import { expect, request, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOT_LOCAL, NOT_LOCAL_REASON } from '../local-stack/helpers';
import { OUT_DIR, recordFinding, type AuditContext } from './recorder';
import { stateFile, type AuditRoleId } from './routes';

// 不做外链探测的主机（反爬 / 需登录 / 本地不可达），以逗号追加：UI_AUDIT_EXTERNAL_SKIP=a.com,b.com
const EXTERNAL_SKIP = new Set([
  'www.linkedin.com', 'linkedin.com', 'twitter.com', 'x.com', 'www.x.com',
  ...(process.env.UI_AUDIT_EXTERNAL_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean),
]);
const CHECK_EXTERNAL = process.env.UI_AUDIT_EXTERNAL !== '0';
// 下载 / 登出等不应以 GET 触发副作用的站内路径
const INTERNAL_SKIP = [/^\/api\/auth\/signout/, /\/logout$/];

interface LinkRow extends AuditContext { links: Array<{ url: string; text: string }> }

test.skip(NOT_LOCAL, NOT_LOCAL_REASON);

test('all collected links resolve', async () => {
  test.setTimeout(30 * 60_000);
  const file = join(OUT_DIR, 'links.jsonl');
  test.skip(!existsSync(file), '先运行 ui-audit-desktop / ui-audit-mobile 收集链接');
  const rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as LinkRow);

  // 站内：按 (角色, URL) 去重，记录首个来源页
  const internal = new Map<string, { role: string; url: string; from: LinkRow; text: string }>();
  const external = new Map<string, { url: string; from: LinkRow; text: string }>();
  for (const row of rows) {
    for (const l of row.links) {
      if (l.url.startsWith('/')) {
        if (INTERNAL_SKIP.some((re) => re.test(l.url))) continue;
        const key = `${row.role} ${l.url}`;
        if (!internal.has(key)) internal.set(key, { role: row.role, url: l.url, from: row, text: l.text });
      } else if (!external.has(l.url)) {
        external.set(l.url, { url: l.url, from: row, text: l.text });
      }
    }
  }

  const broken: string[] = [];
  const contexts = new Map<string, Awaited<ReturnType<typeof request.newContext>>>();
  const ctxFor = async (role: string) => {
    if (!contexts.has(role)) {
      contexts.set(role, await request.newContext({
        baseURL: process.env.BASE_CLOUD,
        storageState: stateFile(role as AuditRoleId),
        timeout: 30_000,
      }));
    }
    return contexts.get(role)!;
  };

  for (const item of internal.values()) {
    const ctx = await ctxFor(item.role);
    const res = await ctx.get(item.url, { maxRedirects: 5 }).catch((e: Error) => e);
    let problem: string | null = null;
    if (res instanceof Error) problem = `request failed: ${res.message.split('\n')[0]}`;
    else if (res.status() >= 400) problem = `HTTP ${res.status()}`;
    else if ((res.headers()['content-type'] || '').includes('text/html')) {
      const body = await res.text();
      if (body.includes('NEXT_HTTP_ERROR_FALLBACK;404')) problem = 'renders the 404 page (soft 404)';
    }
    if (problem) {
      broken.push(`${item.url} (${item.role}): ${problem}`);
      recordFinding({
        ...item.from,
        severity: 'serious',
        category: 'link-broken',
        message: `Link "${item.text || item.url}" → ${item.url} ${problem}`,
        detail: `found on /${item.from.locale}/${item.from.path} (${item.from.viewport}) as ${item.role}`,
      });
    }
  }
  for (const c of contexts.values()) await c.dispose();

  if (CHECK_EXTERNAL) {
    const ext = await request.newContext({ timeout: 10_000, ignoreHTTPSErrors: false });
    for (const item of external.values()) {
      const host = new URL(item.url).hostname;
      if (EXTERNAL_SKIP.has(host) || /^(localhost|127\.0\.0\.1)$/.test(host)) continue;
      let res = await ext.head(item.url, { maxRedirects: 5 }).catch(() => null);
      if (!res || res.status() === 405 || res.status() === 403) res = await ext.get(item.url, { maxRedirects: 5 }).catch(() => null);
      if (!res || res.status() >= 400) {
        recordFinding({
          ...item.from,
          severity: 'minor',
          category: 'link-external-unreachable',
          message: `External link "${item.text || item.url}" → ${item.url} ${res ? `HTTP ${res.status()}` : 'unreachable'}`,
          detail: `found on /${item.from.locale}/${item.from.path}`,
        });
      }
    }
    await ext.dispose();
  }

  console.log(`[ui-audit] checked ${internal.size} internal (role,url) pairs, ${external.size} external URLs`);
  expect(broken, 'broken internal links').toEqual([]);
});
