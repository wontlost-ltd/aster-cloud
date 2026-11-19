/**
 * UI 审计（#774）本地栈播种：按角色建用户、团队与成员，伪造 Auth.js 会话 cookie 写出 Playwright storageState，
 * 再以这些会话经应用自身的 HTTP 接口建策略、执行一次、建 API key，让列表 / 详情 / 日志页都有真实数据可审计。
 * 每个角色另有若干未读通知，让顶栏铃铛带未读徽章接受审计（#814）。
 *
 * 只允许指向本地栈：DATABASE_URL 与 BASE_CLOUD 的主机都必须是回环地址。
 *
 * 环境变量：
 *   DATABASE_URL     必填，cloud 库（例：postgresql://postgres:postgres@localhost:55774/aster_cloud）
 *   NEXTAUTH_SECRET  必填，与被测 cloud 进程相同（AUTH_SECRET 亦可）
 *   BASE_CLOUD       必填，例 http://localhost:3774
 *   UI_AUDIT_STATE_DIR  可选，storageState 输出目录，默认 .superpowers/ui-audit
 *
 * 用法：pnpm exec tsx scripts/ui-audit/seed.ts
 * 幂等：用户 / 团队 / 成员按主键 upsert；策略与 API key 按名称查重，已存在则复用。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS, sessionCookie } from '../lib/session-cookie';
import { AUDIT_ROLES, AUDIT_TEAM_ID, type AuditRole } from './roles';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function requireLocal(name: string, url: string | undefined): string {
  if (!url) throw new Error(`缺少 ${name}`);
  const host = new URL(url).hostname;
  if (!LOOPBACK.has(host)) throw new Error(`${name} 必须指向本地栈（当前主机 ${host}）`);
  return url;
}

const DATABASE_URL = requireLocal('DATABASE_URL', process.env.DATABASE_URL);
const BASE_CLOUD = requireLocal('BASE_CLOUD', process.env.BASE_CLOUD).replace(/\/$/, '');
const SECRET = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
const STATE_DIR = process.env.UI_AUDIT_STATE_DIR || '.superpowers/ui-audit';

// 英文 CNL：最小可编译的单规则，详情 / 执行 / 日志页都能渲染真实内容
const POLICY_SOURCE = `Module aster.audit.loan.

Rule evaluateLoan given tier as Text, produce Text:
  If tier equals to "gold":
    Return "allow".
  Return "review".
`;

async function upsertIdentity(sql: postgres.Sql): Promise<void> {
  const now = new Date();
  for (const r of AUDIT_ROLES) {
    await sql`
      insert into "User" (id, name, email, "emailNormalized", "emailVerified", plan, "isAdmin",
                          "onboardingCompletedAt", "priceLockedAt", "createdAt", "updatedAt")
      values (${r.id}, ${r.name}, ${r.email}, ${r.email}, ${now}, ${r.plan}, ${r.isAdmin},
              ${now}, ${now}, ${now}, ${now})
      on conflict (id) do update set plan = excluded.plan, "isAdmin" = excluded."isAdmin",
        "onboardingCompletedAt" = excluded."onboardingCompletedAt", "deletedAt" = null, "updatedAt" = ${now}`;
  }
  const owner = AUDIT_ROLES.find((r) => r.teamRole === 'owner');
  if (!owner) throw new Error('角色表缺少团队 owner');
  await sql`
    insert into "Team" (id, name, slug, "ownerId", "createdAt", "updatedAt")
    values (${AUDIT_TEAM_ID}, 'UI Audit Team', ${AUDIT_TEAM_ID}, ${owner.id}, ${now}, ${now})
    on conflict (id) do update set "ownerId" = excluded."ownerId"`;
  for (const r of AUDIT_ROLES) {
    if (!r.teamRole) continue;
    await sql`
      insert into "TeamMember" (id, "teamId", "userId", role, "createdAt")
      values (${`tm-${r.id}`}, ${AUDIT_TEAM_ID}, ${r.id}, ${r.teamRole}, ${now})
      on conflict ("teamId", "userId") do update set role = excluded.role`;
  }
}

/** 每个审计角色的未读通知条数：顶栏铃铛因此显示未读徽章，axe 才能检查徽章与可访问名是否一致（#814）。 */
const UNREAD_NOTIFICATIONS = 3;

/**
 * 给每个审计角色写入固定 id 的未读通知（幂等）：先把审计用户的其他未读通知标为已读，重复播种时把 readAt 清回 null，
 * 上一轮审计或手动点开铃铛标为已读后仍能恢复未读状态。
 */
async function upsertUnreadNotifications(sql: postgres.Sql): Promise<void> {
  const now = new Date();
  // 其他来源的未读通知（如上一轮播种建策略、团队邀请产生的）一律标为已读，徽章数字稳定为 UNREAD_NOTIFICATIONS
  const ids = AUDIT_ROLES.map((r) => r.id);
  await sql`
    update "Notification" set "readAt" = ${now}
    where "userId" in ${sql(ids)} and "readAt" is null and id not like 'ui-audit-notif-%'`;
  for (const r of AUDIT_ROLES) {
    for (let i = 1; i <= UNREAD_NOTIFICATIONS; i += 1) {
      const data = { teamId: AUDIT_TEAM_ID, teamName: 'UI Audit Team', memberName: `Audit teammate ${i}` };
      await sql`
        insert into "Notification" (id, "userId", kind, data, "readAt", "createdAt")
        values (${`ui-audit-notif-${r.id}-${i}`}, ${r.id}, 'team.invitation_accepted', ${sql.json(data)}, null, ${now})
        on conflict (id) do update set "readAt" = null, "createdAt" = excluded."createdAt"`;
    }
  }
}

function writeStates(cookies: Map<string, string>): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const expires = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS;
  for (const [id, value] of cookies) {
    const state = {
      // cookie 域与 BASE_CLOUD 主机一致（localhost / 127.0.0.1 / [::1]），否则浏览器不会带上会话
      cookies: [{ name: SESSION_COOKIE_NAME, value, domain: new URL(BASE_CLOUD).hostname, path: '/', httpOnly: true, secure: false, sameSite: 'Lax', expires }],
      origins: [],
    };
    writeFileSync(join(STATE_DIR, `state-${id}.json`), JSON.stringify(state, null, 2));
  }
}

async function call(cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE_CLOUD}${path}`, {
    method,
    headers: {
      Cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
      Origin: BASE_CLOUD,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/** 按名称查重后建策略；返回策略 id。 */
async function ensurePolicy(sql: postgres.Sql, cookie: string, owner: AuditRole, name: string, teamId?: string): Promise<string> {
  const [existing] = await sql<{ id: string }[]>`
    select id from "Policy" where "userId" = ${owner.id} and name = ${name} and "deletedAt" is null limit 1`;
  if (existing) return existing.id;
  const res = await call(cookie, 'POST', '/api/policies', {
    name,
    description: 'UI audit fixture (#774)',
    content: POLICY_SOURCE,
    locale: 'en',
    ...(teamId ? { teamId } : {}),
  });
  const id = (res.json.id ?? (res.json.policy as { id?: string } | undefined)?.id) as string | undefined;
  if (res.status >= 300 || !id) throw new Error(`建策略失败 ${name}: HTTP ${res.status} ${JSON.stringify(res.json).slice(0, 300)}`);
  return id;
}

async function ensureApiKey(sql: postgres.Sql, cookie: string, owner: AuditRole): Promise<void> {
  const [existing] = await sql`select id from "ApiKey" where "userId" = ${owner.id} and name = 'ui-audit' and "revokedAt" is null limit 1`;
  if (existing) return;
  const res = await call(cookie, 'POST', '/api/api-keys', { name: 'ui-audit' });
  if (res.status >= 300) console.warn(`[seed] 建 API key 失败（不阻断）：HTTP ${res.status} ${JSON.stringify(res.json).slice(0, 200)}`);
}

// 无断点的长内容（#774）：平台管理页会把邮箱 / 用户 ID / 主机名 / 工具链标识原样渲染，种子里只有短值时窄屏溢出看不出来
const LONG_TOKEN_USER = {
  id: 'ui-long-token-cmh7x2k9q0000qwertyuiopasdfghjkl',
  email: 'alexandra.konstantinopoulou-whitfield@compliance-operations.example-enterprise.com',
};
const LONG_BYOK_HOST = 'llm-gateway.eu-central-1.compliance-operations.example-enterprise.com';

async function upsertLongTokenUser(sql: postgres.Sql): Promise<void> {
  const now = new Date();
  const { id, email } = LONG_TOKEN_USER;
  await sql`
    insert into "User" (id, name, email, "emailNormalized", "emailVerified", plan, "isAdmin",
                        "onboardingCompletedAt", "priceLockedAt", "createdAt", "updatedAt")
    values (${id}, null, ${email}, ${email}, ${now}, 'pro', false, ${now}, ${now}, ${now}, ${now})
    on conflict do nothing`;
}

/**
 * 平台管理页的长内容夹具（需要 aster-api；失败只告警）：BYOK 白名单加一个长主机名；发起一次 report 模式
 * （只报告、不拦截）的全量复核，返回 runId，审计访问 /admin/revalidation 前写入 localStorage 以展示工具链标识。
 */
async function seedPlatformFixtures(cookie: string): Promise<string | undefined> {
  const byok = await call(cookie, 'POST', '/api/admin/byok-allowlist', { action: 'add', host: LONG_BYOK_HOST });
  if (byok.status >= 300) console.warn(`[seed] BYOK 长主机名失败（不阻断）：HTTP ${byok.status} ${JSON.stringify(byok.json).slice(0, 200)}`);
  // 已有运行中的复核（409 active_run_exists，如刚跑过一次播种）时等它结束再发起，最多约 1 分钟
  let run = await call(cookie, 'POST', '/api/admin/revalidation/runs', { scope: 'all', mode: 'report' });
  for (let i = 0; run.status === 409 && i < 12; i += 1) {
    await new Promise((r) => setTimeout(r, 5_000));
    run = await call(cookie, 'POST', '/api/admin/revalidation/runs', { scope: 'all', mode: 'report' });
  }
  const runId = run.json.runId ?? run.json.id;
  if (run.status >= 300 || runId === undefined) {
    console.warn(`[seed] 发起复核失败（不阻断）：HTTP ${run.status} ${JSON.stringify(run.json).slice(0, 200)}`);
    return undefined;
  }
  return String(runId);
}

async function main(): Promise<void> {
  if (!SECRET) throw new Error('缺少 AUTH_SECRET / NEXTAUTH_SECRET');
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    await upsertIdentity(sql);
    await upsertLongTokenUser(sql);
    await upsertUnreadNotifications(sql);
    const cookies = new Map<string, string>();
    for (const r of AUDIT_ROLES) cookies.set(r.id, await sessionCookie({ id: r.id, email: r.email, plan: r.plan }, SECRET));
    writeStates(cookies);
    console.log(`[seed] 已写出 ${cookies.size} 个 storageState 到 ${STATE_DIR}`);

    const pro = AUDIT_ROLES.find((r) => r.id === 'ui-pro');
    const owner = AUDIT_ROLES.find((r) => r.teamRole === 'owner');
    if (!pro || !owner) throw new Error('角色表缺少 ui-pro 或团队 owner');
    const personal = await ensurePolicy(sql, cookies.get(pro.id)!, pro, 'UI Audit Loan');
    const team = await ensurePolicy(sql, cookies.get(owner.id)!, owner, 'UI Audit Team Loan', AUDIT_TEAM_ID);
    const exec = await call(cookies.get(pro.id)!, 'POST', `/api/policies/${personal}/execute`, {
      input: { tier: 'gold' },
    });
    if (exec.status >= 300) console.warn(`[seed] 执行策略失败（不阻断）：HTTP ${exec.status} ${JSON.stringify(exec.json).slice(0, 200)}`);
    await ensureApiKey(sql, cookies.get(pro.id)!, pro);
    const platform = AUDIT_ROLES.find((r) => r.isAdmin);
    const revalidationRunId = platform ? await seedPlatformFixtures(cookies.get(platform.id)!) : undefined;
    writeFileSync(join(STATE_DIR, 'fixtures.json'), JSON.stringify({ personalPolicyId: personal, teamPolicyId: team, teamId: AUDIT_TEAM_ID, revalidationRunId }, null, 2));
    console.log(`[seed] 策略 personal=${personal} team=${team}`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
