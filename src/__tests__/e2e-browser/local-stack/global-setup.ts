/**
 * 本地栈冷启动预热（Playwright globalSetup）。
 *
 * 为什么需要：`podman restart aster-cloud` 后 Next dev 服务器按需编译，首个页面常需 20s 以上，
 * 第一个用例会撞上 15s navigationTimeout。这里在任何用例前先把用例与页面调用的 API 路由、
 * 再按用例登录态把会访问的页面各访问一次，并给足超时，让编译成本落在预热阶段。
 *
 * 预热要在整轮用例内有效，依赖 aster-cloud 容器以 `-e E2E_LOCAL_STACK=1` 启动（next.config.ts 据此放宽
 * webpack dev 的 onDemandEntries 缓冲，否则预热入口会被挤掉）。
 *
 * 生产构建（`node .next/standalone/server.js`）不按需编译，但首个请求要等 platform proxy 冷启动，且
 * aster-api 回调 cloud 校验 API key 的路径同样冷：先等就绪、再预热该回调，最后才预热页面。
 *
 * 只在 BASE_CLOUD 含 localhost 时执行；生产冒烟直接返回，不产生任何请求。
 */
import { chromium, request, type Browser } from '@playwright/test';
import { existsSync } from 'node:fs';
import { NOT_LOCAL, stateFor } from './helpers';

type StackUser = Parameters<typeof stateFor>[0];

// 页面按用例实际使用的登录态预热：不同角色渲染的客户端组件（如审批按钮）不同，懒加载 chunk 也不同。
const WARM_PAGES: Array<[string, StackUser]> = [
  ['/en/dashboard', 'm-free'],
  ['/en/approvals', 'm-dpo'],
  ['/en/approvals', 'm-free'],
  ['/en/policies/pol-adr0041-team/logs', 'm-free'],
  ['/en/policies/pol-adr0041-team', 'm-free'],
  ['/en/reports', 'm-free'],
  ['/en/teams/team1/members', 'owner1'],
  ['/en/policies/pol-credit-pilot', 'cp-owner'],
  ['/en/approvals', 'cp-officer'],
  ['/en/reports', 'cp-owner'],
];

// 用例与页面客户端会调用的 API 路由：dev 模式下路由按首次请求编译（实测 3–7s），会吃掉用例
// 里 5–10s 的断言/下载等待。这里只为触发编译，一律 GET（POST/PUT 路由返回 405 也已完成编译），
// 动态段用占位 id，状态码无关紧要。
const WARM_APIS = [
  '/api/internal/tenant/m-free/plan',
  '/api/internal/executions/window',
  '/api/internal/policy-versions',
  '/api/policies/pol-adr0041-team/logs',
  '/api/policies/pol-adr0041-team/funnel',
  '/api/policies/pol-adr0041-team/review',
  '/api/v1/policies/pol-adr0041-team/versions',
  '/api/v1/policies/pol-adr0041-team/versions/1',
  '/api/v1/policies/pol-adr0041-team/whatif-batches',
  '/api/v1/policies/pol-adr0041-team/whatif-batches/warmup',
  '/api/approvals',
  '/api/approvals/team1/warmup/approve',
  '/api/reports',
  '/api/reports/warmup/download',
  '/api/reports/warmup/mapping',
  '/api/teams/team1/members',
  '/api/teams/team1/members/warmup',
  '/api/v1/policies/pol-credit-pilot/versions',
  '/api/v1/policies/pol-credit-pilot/whatif-batches',
  '/api/policies/pol-credit-pilot/logs',
  '/api/policies/warmup/export/cedar',
];

const WARM_TIMEOUT_MS = 180_000;
const NETWORK_IDLE_TIMEOUT_MS = 60_000;
// 生产构建（standalone）启动后首个请求要等 @opennextjs/cloudflare 的 platform proxy 冷启动，宿主机繁忙时实测
// 可达 150s 以上；预热前先等服务真正可应答，并把等待时间与用例的超时预算分开。
const READY_BUDGET_MS = 600_000;
const READY_POLL_MS = 5_000;
// aster-api 根地址：用例经 aster-api 调 guard/execute 时，aster-api 会回调 cloud 的 apikey/verify 路由，
// 该回调路径在 cloud 冷启动后同样慢，须单独预热（与 helpers.ts 的默认值一致）。
const BASE_API = process.env.BASE_API || 'http://localhost:8080';
const API_WARM_ROUNDS = 3;
const API_WARM_FAST_MS = 5_000;

/** 缺会话夹具时仍预热（会被重定向到登录页，至少编译中间件与登录页），不阻断运行。 */
function storageFor(user: StackUser): string | undefined {
  const state = stateFor(user);
  return existsSync(state) ? state : undefined;
}

/**
 * 打开页面并等到网络空闲：不仅编译页面本身，还要让页面加载后才触发的懒加载 chunk 与客户端
 * API 调用在预热阶段编译完。否则这些编译会落在用例中途，webpack 重编译期间 chunk 请求被挂起，
 * 用例的 page.goto 等不到 load 事件而超时。
 */
async function warmPage(browser: Browser, baseURL: string, path: string, user: StackUser): Promise<void> {
  const started = Date.now();
  const page = await browser.newPage({ baseURL, storageState: storageFor(user) });
  try {
    await page.goto(path, { waitUntil: 'load', timeout: WARM_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => undefined);
  } catch (e) {
    console.warn(`[warmup] ${path} (${user}) 预热失败：${(e as Error).message}`);
  } finally {
    await page.close();
  }
  console.log(`[warmup] ${path} (${user}) ${Date.now() - started}ms`);
}

/** 轮询首页直到服务可应答（任意非 5xx 状态即可，登录重定向也算），超出预算则报错终止整轮用例。 */
async function waitUntilReady(baseURL: string): Promise<void> {
  const started = Date.now();
  const ctx = await request.newContext({ baseURL, timeout: WARM_TIMEOUT_MS });
  try {
    while (Date.now() - started < READY_BUDGET_MS) {
      const status = await ctx.get('/en').then((r) => r.status()).catch(() => 0);
      if (status > 0 && status < 500) {
        console.log(`[warmup] ready: /en → ${status} after ${Date.now() - started}ms`);
        return;
      }
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
  } finally {
    await ctx.dispose();
  }
  throw new Error(`[warmup] ${baseURL} 在 ${READY_BUDGET_MS}ms 内未就绪`);
}

/**
 * 预热 aster-api → cloud 的 API key 校验回调：带 key 的只读请求会触发 aster-api 调 cloud
 * `/api/internal/apikey/verify`，冷态下这一跳可能超过用例里 10–30s 的等待。连续请求直到一次足够快，
 * 让后续用例的 guard/execute 调用落在热路径上。缺 key 时跳过（对应用例自身会 skip）。
 */
async function warmApiKeyVerify(): Promise<void> {
  const apiKey = process.env.E2E_GUARD_API_KEY;
  if (!apiKey) return;
  const ctx = await request.newContext({ baseURL: BASE_API, timeout: WARM_TIMEOUT_MS });
  try {
    for (let round = 1; round <= API_WARM_ROUNDS; round += 1) {
      const started = Date.now();
      const status = await ctx
        .get('/api/v1/policies', { headers: { Authorization: `Bearer ${apiKey}` } })
        .then((r) => r.status())
        .catch(() => 0);
      const elapsed = Date.now() - started;
      console.log(`[warmup] api key verify round ${round}: ${status} ${elapsed}ms`);
      if (status > 0 && status < 500 && elapsed < API_WARM_FAST_MS) return;
    }
  } finally {
    await ctx.dispose();
  }
}

export default async function globalSetup(): Promise<void> {
  if (NOT_LOCAL) return;
  const baseURL = process.env.BASE_CLOUD as string;

  await waitUntilReady(baseURL);

  // 先编译 API 路由，页面预热阶段的客户端请求就不会再触发新的服务端编译。
  const api = await request.newContext({ baseURL, storageState: storageFor('m-free'), timeout: WARM_TIMEOUT_MS });
  for (const path of WARM_APIS) {
    const started = Date.now();
    await api.get(path).catch((e: Error) => console.warn(`[warmup] ${path} 预热失败：${e.message}`));
    console.log(`[warmup] ${path} ${Date.now() - started}ms`);
  }
  await api.dispose();

  await warmApiKeyVerify();

  const browser = await chromium.launch();
  for (const [path, user] of WARM_PAGES) {
    await warmPage(browser, baseURL, path, user);
  }
  await browser.close();
}
