/**
 * UI 审计（#774）的路由清单：`src/app/[locale]/**` 下每个 page.tsx 一条，标注以哪个角色访问。
 *
 * - role 为 'anon' 表示不带会话（营销页、文档、登录注册等）。
 * - 动态段用播种脚本写出的 fixtures.json 填充（个人策略、团队策略、团队 id）。
 * - roleSweep：仪表盘外壳与按角色区分内容的页面，再以其余角色各访问一次（仅英文、只做页面级检查），
 *   覆盖 free / pro / team owner / admin / member / platform admin 的差异渲染。
 *
 * 新增页面时在此登记；`route-inventory.test.ts`（vitest）会比对 page.tsx 文件清单，漏登记即失败。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIT_ROLES, AUDIT_TEAM_ID } from '../../../../scripts/ui-audit/roles';

export type AuditRoleId = 'anon' | (typeof AUDIT_ROLES)[number]['id'];

export interface AuditRoute {
  /** app 目录下的路由模式（不含 [locale]），供清单比对 */
  pattern: string;
  /** 实际访问路径（不含 locale 前缀） */
  path: string;
  role: AuditRoleId;
  /** 该页预期不是 2xx 正常页（如无效 token）时置 true：只做布局 / a11y，不把错误态当缺陷 */
  expectErrorState?: boolean;
  /** 访问前写入的 localStorage（页面只在有本地记录时渲染的内容，如复核页的最近一次运行与工具链标识） */
  localStorage?: Record<string, string>;
}

export interface AuditFixtures {
  personalPolicyId: string;
  teamPolicyId: string;
  teamId: string;
  /** 种子发起的 report 模式复核 runId（需要 aster-api，可能缺失） */
  revalidationRunId?: string;
}

export const STATE_DIR = process.env.UI_AUDIT_STATE_DIR || join(process.cwd(), '.superpowers/ui-audit');

export function loadFixtures(): AuditFixtures {
  const file = join(STATE_DIR, 'fixtures.json');
  if (!existsSync(file)) {
    // 未播种时给占位 id：页面会渲染 404，审计报告里会明确体现，而不是让整套用例在收集阶段崩溃
    return { personalPolicyId: 'missing-fixture', teamPolicyId: 'missing-fixture', teamId: AUDIT_TEAM_ID };
  }
  return JSON.parse(readFileSync(file, 'utf8')) as AuditFixtures;
}

export function stateFile(role: AuditRoleId): string | undefined {
  return role === 'anon' ? undefined : join(STATE_DIR, `state-${role}.json`);
}

const PUBLIC = [
  '', 'pricing', 'privacy', 'terms', 'equivalence', 'equivalence/whitepaper',
  'solutions/agent-guardrails', 'solutions/credit-decisions', 'solutions/eligibility-rules', 'solutions/insurance-rating',
  'demos', 'demos/credit', 'demos/guardian', 'demos/guyong', 'demos/kitten', 'demos/poem', 'demos/poker', 'demos/vocab',
];

const DOCS = [
  'docs', 'docs/getting-started', 'docs/getting-started/overview', 'docs/getting-started/quickstart',
  'docs/getting-started/authentication', 'docs/getting-started/api-keys', 'docs/getting-started/errors',
  'docs/how-to', 'docs/how-to/teams', 'docs/how-to/approvals', 'docs/how-to/guard',
  'docs/guides', 'docs/guides/credit-pilot', 'docs/guides/guard-approvals', 'docs/guides/workspace',
  'docs/api', 'docs/api/policies', 'docs/api/policies/evaluate', 'docs/api/policies/evaluate-json',
  'docs/api/policies/evaluate-source', 'docs/api/policies/batch', 'docs/api/policies/cache', 'docs/api/policies/rollback',
  'docs/api/policies/schema', 'docs/api/policies/validate', 'docs/api/policies/versions',
  'docs/api/audit', 'docs/api/audit/anomalies', 'docs/api/audit/compare', 'docs/api/audit/logs',
  'docs/api/audit/verify-chain', 'docs/api/audit/version-usage',
  'docs/api/graphql', 'docs/api/graphql/overview', 'docs/api/graphql/queries', 'docs/api/graphql/mutations',
  'docs/api/websocket', 'docs/api/websocket/preview',
  'docs/api/workflows', 'docs/api/workflows/events', 'docs/api/workflows/metrics', 'docs/api/workflows/state',
];

const AUTH = ['login', 'signup', 'forgot-password', 'reset-password', 'verify-email', 'logout'];

const ADMIN = [
  'admin', 'admin/ai-circuit-breaker', 'admin/ai-workspace-access', 'admin/assistant', 'admin/capabilities/structured-authoring', 'admin/demand',
  'admin/domain-vocabularies', 'admin/issued-licenses', 'admin/license', 'admin/license-revoke',
  'admin/revalidation', 'admin/risk-tier', 'admin/rule-regression', 'admin/sso',
];

const PRO_DASHBOARD = [
  'dashboard', 'approvals', 'billing', 'billing/plans', 'domain-vocabularies', 'domain-vocabularies/snapshots',
  'governance', 'reports', 'security', 'settings', 'settings/ai-keys', 'settings/api-keys', 'settings/data',
  'settings/fact-issuers', 'policies', 'policies/new', 'policies/trash', 'teams', 'teams/new',
];

/** 仅 on-prem 部署开放的管理页（SaaS 栈里 notFound） */
const ON_PREM_ONLY = new Set(['admin/license', 'admin/sso']);

/** 以其余角色再访问一遍的页面（外壳 + 按角色 / 套餐差异渲染的页面） */
export const ROLE_SWEEP_PATHS = ['dashboard', 'teams', 'approvals', 'billing', 'settings', 'policies'];

export function buildRoutes(f: AuditFixtures = loadFixtures()): AuditRoute[] {
  const routes: AuditRoute[] = [];
  for (const p of PUBLIC) routes.push({ pattern: p, path: p, role: 'anon' });
  for (const p of DOCS) routes.push({ pattern: p, path: p, role: 'anon' });
  for (const p of AUTH) routes.push({ pattern: `(auth)/${p}`, path: p, role: 'anon' });
  // 改密页仅对已登录用户开放，否则跳登录页；用 pro 会话访问（无强制改密标记时会跳回仪表盘）
  routes.push({ pattern: '(auth)/onboarding', path: 'onboarding', role: 'ui-free' });
  routes.push({ pattern: '(auth)/onboarding/change-password', path: 'onboarding/change-password', role: 'ui-free' });
  routes.push({ pattern: 'renew/[token]', path: 'renew/ui-audit-invalid-token', role: 'anon', expectErrorState: true });
  for (const p of PRO_DASHBOARD) routes.push({ pattern: `(dashboard)/${p}`, path: p, role: 'ui-pro' });
  for (const p of ADMIN) {
    // license / sso 只在 on-prem 部署开放（CAN_LICENSE / CAN_SSO），SaaS 栈里渲染 404 是预期行为
    routes.push({
      pattern: `(dashboard)/${p}`,
      path: p,
      role: 'ui-platform',
      expectErrorState: ON_PREM_ONLY.has(p),
      // 复核页只在 localStorage 有最近一次 runId 时才展示运行状态与工具链标识（无空格长串，#774）
      ...(p === 'admin/revalidation' && f.revalidationRunId
        ? { localStorage: { 'aster.admin.revalidation.recentRunId': f.revalidationRunId } }
        : {}),
    });
  }
  const pol = f.personalPolicyId;
  for (const sub of ['', '/edit', '/execute', '/logs', '/versions']) {
    routes.push({ pattern: `(dashboard)/policies/[id]${sub}`, path: `policies/${pol}${sub}`, role: 'ui-pro' });
  }
  // 团队页：owner 看全量管理视图，member 看只读视图
  for (const sub of ['', '/members', '/policies', '/settings']) {
    routes.push({ pattern: `(dashboard)/teams/[teamId]${sub}`, path: `teams/${f.teamId}${sub}`, role: 'ui-owner' });
  }
  routes.push({ pattern: '(dashboard)/teams/[teamId]', path: `teams/${f.teamId}`, role: 'ui-member' });
  routes.push({ pattern: '(dashboard)/policies/[id]', path: `policies/${f.teamPolicyId}`, role: 'ui-member' });
  // 无 token 的邀请页：已登录用户应看到缺少 / 无效邀请的提示
  routes.push({ pattern: '(dashboard)/teams/invite', path: 'teams/invite', role: 'ui-free', expectErrorState: true });
  return routes;
}

/** 角色差异巡检：每个非主角色 × ROLE_SWEEP_PATHS */
export function buildRoleSweep(): AuditRoute[] {
  const out: AuditRoute[] = [];
  for (const r of AUDIT_ROLES) {
    if (r.id === 'ui-pro') continue;
    for (const p of ROLE_SWEEP_PATHS) out.push({ pattern: `(dashboard)/${p}`, path: p, role: r.id });
  }
  return out;
}

export function localePath(locale: string, path: string): string {
  return `/${locale}${path ? `/${path}` : ''}`;
}
