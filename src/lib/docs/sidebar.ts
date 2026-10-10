/**
 * Sidebar config for the /docs/* subsite.
 *
 * Single source of truth for left-rail navigation. Hrefs are
 * locale-agnostic slugs under /docs/; the sidebar component prepends
 * the active locale at render time via next-intl's Link.
 *
 * To add or move a page:
 *   1. Add/move the MDX file under src/app/[locale]/docs/.../{en,zh,de}.mdx
 *   2. Add the page.tsx wrapper (or rerun generate-page-wrappers.mjs)
 *   3. Add the i18n label under messages/{en,zh,de}.json → docs.sidebar.*
 *   4. Add the entry below
 */

export type DocsSidebarItem = {
  /** i18n message key (resolved via useTranslations()) */
  labelKey: string;
  /** path under /docs/* (no leading locale, no leading slash) */
  href: string;
};

export type DocsSidebarSection = {
  titleKey: string;
  items: readonly DocsSidebarItem[];
};

/**
 * `as const satisfies` keeps every href as a string literal in the
 * inferred type so `RouteSlug` in `page-actions.ts` is a precise
 * union, not `string`. Without `as const`, the
 * `Record<RouteSlug, PageActionSet>` exhaustiveness check would
 * silently degrade — a slug added here without a matching entry in
 * PAGE_ACTIONS would compile cleanly. (Caught by Phase 2 audit.)
 */
export const docsSidebar = [
  {
    titleKey: 'docs.sidebar.gettingStarted.title',
    items: [
      { labelKey: 'docs.sidebar.gettingStarted.overview', href: 'getting-started/overview' },
      { labelKey: 'docs.sidebar.gettingStarted.authentication', href: 'getting-started/authentication' },
      { labelKey: 'docs.sidebar.gettingStarted.quickstart', href: 'getting-started/quickstart' },
      { labelKey: 'docs.sidebar.gettingStarted.errors', href: 'getting-started/errors' },
    ],
  },
  {
    titleKey: 'docs.sidebar.apiPolicies.title',
    items: [
      { labelKey: 'docs.sidebar.apiPolicies.evaluate', href: 'api/policies/evaluate' },
      { labelKey: 'docs.sidebar.apiPolicies.evaluateSource', href: 'api/policies/evaluate-source' },
      { labelKey: 'docs.sidebar.apiPolicies.evaluateJson', href: 'api/policies/evaluate-json' },
      { labelKey: 'docs.sidebar.apiPolicies.batch', href: 'api/policies/batch' },
      { labelKey: 'docs.sidebar.apiPolicies.schema', href: 'api/policies/schema' },
      { labelKey: 'docs.sidebar.apiPolicies.validate', href: 'api/policies/validate' },
      { labelKey: 'docs.sidebar.apiPolicies.versions', href: 'api/policies/versions' },
      { labelKey: 'docs.sidebar.apiPolicies.rollback', href: 'api/policies/rollback' },
      { labelKey: 'docs.sidebar.apiPolicies.cache', href: 'api/policies/cache' },
    ],
  },
  {
    titleKey: 'docs.sidebar.apiWorkflows.title',
    items: [
      { labelKey: 'docs.sidebar.apiWorkflows.events', href: 'api/workflows/events' },
      { labelKey: 'docs.sidebar.apiWorkflows.state', href: 'api/workflows/state' },
      { labelKey: 'docs.sidebar.apiWorkflows.metrics', href: 'api/workflows/metrics' },
    ],
  },
  {
    titleKey: 'docs.sidebar.apiAudit.title',
    items: [
      { labelKey: 'docs.sidebar.apiAudit.logs', href: 'api/audit/logs' },
      { labelKey: 'docs.sidebar.apiAudit.verifyChain', href: 'api/audit/verify-chain' },
      { labelKey: 'docs.sidebar.apiAudit.versionUsage', href: 'api/audit/version-usage' },
      { labelKey: 'docs.sidebar.apiAudit.anomalies', href: 'api/audit/anomalies' },
      { labelKey: 'docs.sidebar.apiAudit.compare', href: 'api/audit/compare' },
    ],
  },
  {
    titleKey: 'docs.sidebar.apiGraphql.title',
    items: [
      { labelKey: 'docs.sidebar.apiGraphql.overview', href: 'api/graphql/overview' },
      { labelKey: 'docs.sidebar.apiGraphql.queries', href: 'api/graphql/queries' },
      { labelKey: 'docs.sidebar.apiGraphql.mutations', href: 'api/graphql/mutations' },
    ],
  },
  {
    titleKey: 'docs.sidebar.apiWebsocket.title',
    items: [
      { labelKey: 'docs.sidebar.apiWebsocket.preview', href: 'api/websocket/preview' },
    ],
  },
  {
    titleKey: 'docs.sidebar.guides.title',
    items: [
      { labelKey: 'docs.sidebar.guides.creditPilot', href: 'guides/credit-pilot' },
    ],
  },
] as const satisfies readonly DocsSidebarSection[];
