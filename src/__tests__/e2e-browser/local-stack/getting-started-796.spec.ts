/**
 * 上手清单与可操作空状态（#796），桌面与 390px 各跑一遍：
 *   - 新注册的普通用户在仪表盘看到上手清单，条目随其操作（填偏好、建策略、运行、提交审批、组团队）逐项打勾，
 *     必做条目全部完成后卡片消失；
 *   - 收起按用户持久，刷新后不再出现；
 *   - 已完成旧两步向导的用户访问 /onboarding 直接进仪表盘，偏好条目已打勾，不会被再次要求填写；
 *   - 审批、团队、事实签发方的空状态都有操作入口与「了解更多」，后者在文档浮层里打开。
 *
 * 用户与会话都在用例里现建：直接写 cloud 库的 User 行，用与被测进程相同的 NEXTAUTH_SECRET 伪造 Auth.js 会话 cookie。
 * 其余数据（策略、执行、版本提交、团队）一律经应用自身的 HTTP 接口或页面产生。
 *
 * 运行（本地栈，cloud 生产构建在 BASE_CLOUD）：
 *   E2E_PG_CONTAINER=ui796-pg NEXTAUTH_SECRET=… BASE_CLOUD=http://localhost:3796 BASE_API=http://localhost:8796 \
 *     pnpm exec playwright test src/__tests__/e2e-browser/local-stack/getting-started-796.spec.ts --project=chromium-desktop --workers=1
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { SESSION_COOKIE_NAME, sessionCookie } from '../../../../scripts/lib/session-cookie';
import { BASE_CLOUD, NOT_LOCAL, NOT_LOCAL_REASON, psql } from './helpers';

const SECRET = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET;

// 英文 CNL：最小可编译的单规则（与 UI 审计种子同一份），运行即有执行记录
const POLICY_SOURCE = `Module aster.e2e.gs796.

Rule evaluateLoan given tier as Text, produce Text:
  If tier equals to "gold":
    Return "allow".
  Return "review".
`;

const VIEWPORTS = [
  { name: 'desktop', viewport: { width: 1440, height: 900 } },
  { name: '390px', viewport: { width: 390, height: 844 } },
] as const;

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** 新建一个用户行并把会话 cookie 放进浏览器上下文；completedWizard 模拟已完成旧两步向导的老用户。 */
async function signInAsNewUser(context: BrowserContext, opts: { completedWizard?: boolean } = {}): Promise<string> {
  const id = `e2e-gs796-${randomUUID().slice(0, 8)}`;
  const email = `${id}@e2e.test`;
  const completed = opts.completedWizard ? 'now()' : 'null';
  psql(
    'aster_cloud',
    `insert into "User" (id, name, email, "emailNormalized", "emailVerified", plan, "isAdmin", "onboardingCompletedAt",
       "onboardingUseCase", "priceLockedAt", "createdAt", "updatedAt")
     values (${lit(id)}, 'GS 796', ${lit(email)}, ${lit(email)}, now(), 'team', false, ${completed},
       ${opts.completedWizard ? "'finance'" : 'null'}, now(), now(), now())`,
  );
  const value = await sessionCookie({ id, email, plan: 'team' }, SECRET!);
  await context.addCookies([{ name: SESSION_COOKIE_NAME, value, url: BASE_CLOUD, httpOnly: true, sameSite: 'Lax' }]);
  return id;
}

/** 以当前页面的会话调用应用接口（带 Origin，过 CSRF 检查）。 */
async function api(page: Page, method: 'POST' | 'GET', path: string, data?: unknown) {
  const res = await page.request.fetch(`${BASE_CLOUD}${path}`, {
    method,
    headers: { Origin: BASE_CLOUD, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    data: data === undefined ? undefined : JSON.stringify(data),
  });
  const body = await res.json().catch(() => ({}));
  expect(res.status(), `${method} ${path} → ${JSON.stringify(body).slice(0, 300)}`).toBeLessThan(300);
  return body as Record<string, unknown>;
}

// 只看主内容区：流式 SSR 在交换前会把已就绪的片段先放在隐藏容器里，短暂出现第二份
const main = (page: Page) => page.locator('#dashboard-main');
const card = (page: Page) => main(page).getByTestId('getting-started-card');
const item = (page: Page, id: string) => main(page).getByTestId(`getting-started-${id}`);

async function openDashboard(page: Page) {
  await page.goto('/en/dashboard');
  await expect(card(page)).toBeVisible();
}

test.describe('getting-started card and actionable empty states (#796)', () => {
  test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
  test.skip(!SECRET, '需要与被测 cloud 进程相同的 NEXTAUTH_SECRET');
  test.use({ baseURL: BASE_CLOUD });

  for (const { name, viewport } of VIEWPORTS) {
    test.describe(name, () => {
      test.use({ viewport });

      test('a new regular user sees the card and its items complete as they act', async ({ page, context }) => {
        test.setTimeout(180_000);
        const userId = await signInAsNewUser(context);
        await openDashboard(page);
        await expect(card(page).getByRole('heading', { name: 'Get started with Aster' })).toBeVisible();
        await expect(card(page).getByText('0 of 4 done')).toBeVisible();
        for (const id of ['preferences', 'createPolicy', 'runPolicy', 'joinTeam', 'submitApproval', 'connectGuard']) {
          await expect(item(page, id)).toHaveAttribute('data-done', 'false');
        }
        // 原两步向导并入卡片：就地选择行业与目标并保存
        await item(page, 'preferences').getByRole('button', { name: 'Choose' }).click();
        await page.getByRole('button', { name: 'Insurance' }).click();
        await page.getByRole('button', { name: 'Compliance reporting' }).click();
        await page.getByRole('button', { name: 'Save' }).click();
        await expect(item(page, 'preferences')).toHaveAttribute('data-done', 'true');
        expect(psql('aster_cloud', `select "onboardingUseCase" from "User" where id = ${lit(userId)}`)).toBe('insurance');

        // 建第一条策略
        const created = await api(page, 'POST', '/api/policies', { name: 'GS796 Loan', content: POLICY_SOURCE, locale: 'en' });
        const policyId = (created.id ?? (created.policy as { id?: string } | undefined)?.id) as string;
        await openDashboard(page);
        await expect(item(page, 'createPolicy')).toHaveAttribute('data-done', 'true');
        await expect(card(page).getByText('1 of 4 done')).toBeVisible();
        // 「运行」直接落到这条策略的执行页（en 为默认语言，链接不带前缀）
        await expect(item(page, 'runPolicy').getByRole('link')).toHaveAttribute('href', `/policies/${policyId}/execute`);

        // 运行一次
        await api(page, 'POST', `/api/policies/${policyId}/execute`, { input: { tier: 'gold' } });
        await openDashboard(page);
        await expect(item(page, 'runPolicy')).toHaveAttribute('data-done', 'true');

        // 提交版本审批：在版本页点「提交审批」
        await item(page, 'submitApproval').getByRole('link').click();
        await expect(page).toHaveURL(new RegExp(`/policies/${policyId}/versions`));
        await api(page, 'POST', `/api/v1/policies/${policyId}/versions/1/submit`, {});
        await openDashboard(page);
        await expect(item(page, 'submitApproval')).toHaveAttribute('data-done', 'true');
        await expect(card(page).getByText('3 of 4 done')).toBeVisible();

        // 组建团队并有了同事：必做条目全部完成，卡片消失
        const slug = `gs796-${randomUUID().slice(0, 8)}`;
        const team = await api(page, 'POST', '/api/teams', { name: 'GS796 Team', slug });
        const teamId = (team.id ?? (team.team as { id?: string } | undefined)?.id) as string;
        const mateId = `${userId}-mate`;
        psql(
          'aster_cloud',
          `insert into "User" (id, name, email, "emailNormalized", plan, "createdAt", "updatedAt")
             values (${lit(mateId)}, 'Mate', ${lit(`${mateId}@e2e.test`)}, ${lit(`${mateId}@e2e.test`)}, 'free', now(), now());
           insert into "TeamMember" (id, "teamId", "userId", role) values (${lit(randomUUID())}, ${lit(teamId)}, ${lit(mateId)}, 'member')`,
        );
        await page.goto('/en/dashboard');
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(card(page)).toHaveCount(0);
      });

      test('dismissing the card persists across reloads', async ({ page, context }) => {
        const userId = await signInAsNewUser(context);
        await openDashboard(page);
        await card(page).getByRole('button', { name: 'Hide this checklist' }).click();
        await expect(card(page)).toHaveCount(0);
        await page.reload();
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(card(page)).toHaveCount(0);
        expect(await page.evaluate((k) => window.localStorage.getItem(k), `aster.gettingStarted.dismissed.${userId}`)).toBe('1');
      });

      test('a user who finished the old wizard is not sent through it again', async ({ page, context }) => {
        await signInAsNewUser(context, { completedWizard: true });
        await page.goto('/en/onboarding');
        await expect(page).toHaveURL(/\/en\/dashboard$/);
        await expect(card(page)).toBeVisible();
        await expect(item(page, 'preferences')).toHaveAttribute('data-done', 'true');
        // 不展开偏好表单，也没有旧向导的步骤
        await expect(page.getByTestId('getting-started-preferences-form')).toHaveCount(0);
        await expect(page.getByText('What industry are you in?')).toHaveCount(0);
      });

      test('empty states show their actions and open docs in the overlay', async ({ page, context }) => {
        test.setTimeout(120_000);
        await signInAsNewUser(context);

        await page.goto('/en/approvals');
        await expect(page.getByRole('link', { name: 'Open policies' })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Connect Aster Guard' })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Assign business roles' })).toHaveAttribute('href', '/teams');
        await page.getByRole('link', { name: 'Learn more' }).first().click();
        const overlay = page.getByRole('dialog');
        await expect(overlay.getByRole('heading', { name: 'Approvals from start to finish' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(overlay).toHaveCount(0);

        await page.goto('/en/teams');
        // 页头与空状态各有一个「新建团队」，这里看空状态里的那个
        await expect(page.getByRole('link', { name: 'New Team' }).last()).toBeVisible();
        await expect(page.getByRole('link', { name: 'How teams and roles work' })).toHaveAttribute('href', '/docs/how-to/teams');

        await page.goto('/en/settings/fact-issuers');
        await expect(page.getByRole('link', { name: 'How Guard uses signed facts' })).toBeVisible();
        await page.getByRole('button', { name: 'Add issuer' }).click();
        await expect(page.locator('form input').first()).toBeFocused();

        await page.goto('/en/governance');
        await expect(page.getByRole('heading', { name: 'No policies to map yet' })).toBeVisible();
        await expect(page.getByRole('link', { name: 'See a worked example' })).toBeVisible();
      });
    });
  }
});
