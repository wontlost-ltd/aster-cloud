/**
 * Task-oriented IA layer. Each entry maps a reader goal ("build my
 * first policy", "audit a compliance decision") to an ordered sequence
 * of existing docs pages. The `<DocsSidebar>` exposes this as an
 * alternate browse mode beside the reference tree.
 *
 * Why this lives alongside the sidebar:
 *   - The sidebar is the authoritative IA today. Task views layer ON
 *     TOP without duplicating page authorship: every step is a
 *     reference to a `RouteSlug` from `sidebar.ts`, validated at
 *     compile time via the same literal-union machinery as
 *     `page-actions.ts`.
 *   - Editing or reordering a task is a single-file change. No MDX
 *     surgery.
 *   - The reference tree stays the default — only readers who flip
 *     the sidebar tab encounter task mode.
 */

import { docsSidebar } from '@/lib/docs/sidebar';

export type RouteSlug = (typeof docsSidebar)[number]['items'][number]['href'];

export type TaskStep = {
  /** A page slug declared in `docsSidebar`. Compile-time enforced. */
  slug: RouteSlug;
  /**
   * Optional i18n key for an in-task subtitle (e.g. "Step 2 of 4").
   * When omitted the breadcrumb falls back to the page's sidebar
   * label so we don't ship empty strings.
   */
  subtitleKey?: string;
};

export type TaskView = {
  /** Stable id used by URL query (?task=<id>), telemetry, and tests. */
  id: string;
  /** i18n key for the task heading shown in the sidebar + breadcrumb. */
  titleKey: string;
  /** i18n key for the short description shown under the title. */
  descriptionKey: string;
  /**
   * Ordered list of steps. Every slug must exist in `docsSidebar`
   * (TypeScript enforces this via the `RouteSlug` parameter).
   */
  steps: TaskStep[];
};

export const TASK_VIEWS: ReadonlyArray<TaskView> = [
  {
    id: 'build-first-policy',
    titleKey: 'docs.tasks.buildFirstPolicy.title',
    descriptionKey: 'docs.tasks.buildFirstPolicy.description',
    steps: [
      { slug: 'getting-started/overview' },
      { slug: 'getting-started/authentication' },
      { slug: 'getting-started/quickstart' },
      { slug: 'api/policies/evaluate-source' },
    ],
  },
  {
    id: 'evaluate-policy',
    titleKey: 'docs.tasks.evaluatePolicy.title',
    descriptionKey: 'docs.tasks.evaluatePolicy.description',
    steps: [
      { slug: 'api/policies/evaluate' },
      { slug: 'api/policies/evaluate-source' },
      { slug: 'api/policies/evaluate-json' },
      { slug: 'api/policies/batch' },
    ],
  },
  {
    id: 'debug-with-trace',
    titleKey: 'docs.tasks.debugWithTrace.title',
    descriptionKey: 'docs.tasks.debugWithTrace.description',
    steps: [
      { slug: 'getting-started/errors' },
      { slug: 'api/audit/logs' },
      { slug: 'api/audit/verify-chain' },
    ],
  },
  {
    id: 'audit-decision',
    titleKey: 'docs.tasks.auditDecision.title',
    descriptionKey: 'docs.tasks.auditDecision.description',
    steps: [
      { slug: 'api/audit/logs' },
      { slug: 'api/audit/version-usage' },
      { slug: 'api/audit/compare' },
      { slug: 'api/audit/anomalies' },
    ],
  },
  {
    id: 'manage-versions',
    titleKey: 'docs.tasks.manageVersions.title',
    descriptionKey: 'docs.tasks.manageVersions.description',
    steps: [
      { slug: 'api/policies/versions' },
      { slug: 'api/policies/rollback' },
      { slug: 'api/policies/cache' },
    ],
  },
  {
    // 从个人试用走到受治理部署（#796）：组团队、配审批、把 Agent 动作接到策略上。
    id: 'govern-a-deployment',
    titleKey: 'docs.tasks.governDeployment.title',
    descriptionKey: 'docs.tasks.governDeployment.description',
    steps: [
      { slug: 'how-to/teams' },
      { slug: 'how-to/approvals' },
      { slug: 'how-to/guard' },
    ],
  },
  {
    // 结构化编写（ADR 0058，#795）：先由管理员开通，再建模、用词汇写、最后给短策略加显示排版。
    id: 'author-with-your-domain',
    titleKey: 'docs.tasks.authorWithDomain.title',
    descriptionKey: 'docs.tasks.authorWithDomain.description',
    steps: [
      { slug: 'guides/structured-authoring-admin' },
      { slug: 'guides/domain-modelling' },
      { slug: 'guides/domain-vocabulary' },
      { slug: 'guides/display-layouts' },
    ],
  },
  {
    id: 'set-up-production-auth',
    titleKey: 'docs.tasks.setUpProductionAuth.title',
    descriptionKey: 'docs.tasks.setUpProductionAuth.description',
    steps: [
      { slug: 'getting-started/authentication' },
      { slug: 'getting-started/errors' },
      { slug: 'getting-started/overview' },
    ],
  },
];

const TASK_BY_ID = new Map<string, TaskView>(TASK_VIEWS.map((t) => [t.id, t]));

/**
 * Look up a task by id. Returns null for unknown ids so a malformed
 * `?task=<id>` query simply falls through to the default reference
 * view instead of throwing.
 */
export function getTaskView(id: string): TaskView | null {
  return TASK_BY_ID.get(id) ?? null;
}

/**
 * Resolve the sidebar item label for a step's slug. Pure helper —
 * task-view UI uses this when rendering the steps without having to
 * traverse `docsSidebar` itself.
 */
export function sidebarLabelKeyFor(slug: RouteSlug): string | null {
  for (const section of docsSidebar) {
    for (const item of section.items) {
      if (item.href === slug) return item.labelKey;
    }
  }
  return null;
}
