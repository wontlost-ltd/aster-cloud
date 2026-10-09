/**
 * Docs page-level action registry.
 *
 * Every docs leaf page declares a `PageActionSet` here. The
 * `<DocsPageActions>` component reads the set for the current route
 * and renders a small action bar between the breadcrumb and the
 * article H1, giving readers a one-click path back into the product.
 *
 * Capability gating:
 *   Actions with a `capability` field are only rendered when the
 *   client probe (`useDocsSession()`) reports the matching boolean.
 *   Anonymous users see the subset of actions with `capability: 'public'`.
 *
 * Why a flat registry instead of frontmatter:
 *   - Compile-time TypeScript exhaustiveness — `RouteSlug` is the
 *     union of every sidebar entry, and `PAGE_ACTIONS` is forced to
 *     cover every slug. A new sidebar page that doesn't appear here
 *     fails the build.
 *   - i18n keys live in `messages/{en,zh,de}.json` alongside other UI
 *     copy and benefit from the existing parity tests.
 *   - Centralized inventory: review CTA changes alongside copy and
 *     audit-log fan-out impact in one file.
 */

import { docsSidebar } from '@/lib/docs/sidebar';

/**
 * Union of every docs slug declared in `sidebar.ts`. TypeScript will
 * infer this at module load; the type is then used to constrain the
 * `PAGE_ACTIONS` keys so any sidebar reorganization that drops or
 * renames a slug surfaces as a compile error here.
 */
export type RouteSlug = (typeof docsSidebar)[number]['items'][number]['href'];

/**
 * Capability gates map to the `capabilities` shape returned by
 * `/api/docs/session-state`. `public` means "render for anyone,
 * including anonymous"; the remaining keys mirror the probe shape.
 */
export type ActionCapability =
  | 'public'
  | 'canUsePlayground'
  | 'canEditPolicies'
  | 'canViewAudit'
  | 'hasActiveTeam';

/**
 * A single action. The optional `external` flag opts in to writing
 * an audit-log row (via `POST /api/docs/jump`) when an authenticated
 * user clicks the action — used for cross-domain jumps from docs
 * into the app surface so security/compliance can trace "users who
 * read X then opened Y".
 */
export type PageAction = {
  /** Stable id for telemetry and audit. snake_case. */
  id: string;
  /** i18n message key. Must exist in en/zh/de. */
  labelKey: string;
  /** Path under the app (without locale prefix). */
  href: string;
  /** Capability required to render. `public` if anonymous-safe. */
  capability: ActionCapability;
  /** Render emphasis. Primary draws the eye; secondary is muted. */
  variant: 'primary' | 'secondary';
  /** When true, click emits an audit log via the jump endpoint. */
  audit?: boolean;
};

export type PageActionSet = {
  /** The headline action for the page. */
  primary: PageAction;
  /** Optional secondary actions, typically auth-gated. */
  secondary?: PageAction[];
};

/**
 * Helper to build the playground deeplink for a given template id.
 * The template is loaded server-side from a whitelist in Phase 3 —
 * the URL only carries an identifier, never raw source.
 *
 * The href targets `/policies/new` (the actual editor route). There
 * is no separate `/playground` route; the editor doubles as the
 * Playground and reads `?template=<id>` from the snippet registry.
 */
function playground(templateId: string, audit = true): PageAction {
  return {
    id: `playground_${templateId.replace(/-/g, '_')}`,
    labelKey: 'docs.actions.tryInPlayground',
    href: `/policies/new?from=docs&template=${encodeURIComponent(templateId)}`,
    capability: 'canUsePlayground',
    variant: 'primary',
    audit,
  };
}

function openInEditor(slug: string): PageAction {
  return {
    id: `editor_${slug.replace(/[^a-z0-9]+/gi, '_')}`,
    labelKey: 'docs.actions.openInEditor',
    href: `/policies/new?from=docs&template=${encodeURIComponent(slug)}`,
    capability: 'canEditPolicies',
    variant: 'secondary',
    audit: true,
  };
}

function viewMyAuditLogs(): PageAction {
  return {
    id: 'view_my_audit_logs',
    labelKey: 'docs.actions.viewMyAuditLogs',
    href: '/security?from=docs',
    capability: 'canViewAudit',
    variant: 'secondary',
    audit: true,
  };
}

function viewMyTraces(): PageAction {
  return {
    id: 'view_my_traces',
    labelKey: 'docs.actions.viewMyTraces',
    href: '/policies?from=docs&filter=recent',
    capability: 'canEditPolicies',
    variant: 'secondary',
    audit: true,
  };
}

function goToApiKeys(): PageAction {
  return {
    id: 'go_to_api_keys',
    labelKey: 'docs.actions.goToApiKeys',
    href: '/settings/api-keys?from=docs',
    capability: 'public', // anyone signed in sees their own settings
    variant: 'primary',
    audit: true,
  };
}

function openDashboard(): PageAction {
  return {
    id: 'open_dashboard',
    labelKey: 'docs.actions.openDashboard',
    href: '/dashboard?from=docs',
    capability: 'public',
    variant: 'primary',
    audit: true,
  };
}

/**
 * THE registry. Exhaustively maps every `RouteSlug` to an action set.
 * Build will fail if a new sidebar page is added without an entry
 * (TypeScript missing-property error on this object literal).
 */
export const PAGE_ACTIONS: Record<RouteSlug, PageActionSet> = {
  // Getting started — each step links forward to the matching app
  // surface so a reader following the quickstart actually has the
  // CTAs to act on what they just read.
  'getting-started/overview': {
    primary: openDashboard(),
    secondary: [playground('evaluate-source')],
  },
  'getting-started/authentication': {
    primary: goToApiKeys(),
    secondary: [],
  },
  'getting-started/quickstart': {
    primary: playground('evaluate-source'),
    secondary: [goToApiKeys()],
  },
  'getting-started/errors': {
    primary: playground('evaluate-source'),
    secondary: [viewMyTraces()],
  },

  // Policies — primary is "try this exact endpoint in Playground" so
  // the cognitive jump from reference to experiment is one click.
  'api/policies/evaluate': {
    primary: playground('evaluate'),
    secondary: [openInEditor('api/policies/evaluate')],
  },
  'api/policies/evaluate-source': {
    primary: playground('evaluate-source'),
    secondary: [openInEditor('api/policies/evaluate-source')],
  },
  'api/policies/evaluate-json': {
    primary: playground('evaluate-json'),
    secondary: [openInEditor('api/policies/evaluate-json')],
  },
  'api/policies/batch': {
    primary: playground('batch'),
    secondary: [openInEditor('api/policies/batch')],
  },
  'api/policies/schema': {
    primary: playground('schema'),
    secondary: [],
  },
  'api/policies/validate': {
    primary: playground('validate'),
    secondary: [openInEditor('api/policies/validate')],
  },
  'api/policies/versions': {
    primary: playground('versions'),
    secondary: [viewMyTraces()],
  },
  'api/policies/rollback': {
    primary: viewMyTraces(),
    secondary: [playground('rollback')],
  },
  'api/policies/cache': {
    primary: playground('cache'),
    secondary: [],
  },

  // Workflows — events/state/metrics are observational; readers
  // most likely want to look at their own recent traces.
  'api/workflows/events': {
    primary: viewMyTraces(),
    secondary: [playground('workflow-events')],
  },
  'api/workflows/state': {
    primary: viewMyTraces(),
    secondary: [playground('workflow-state')],
  },
  'api/workflows/metrics': {
    primary: viewMyTraces(),
    secondary: [playground('workflow-metrics')],
  },

  // Audit — primary lands users at /security to inspect their own
  // recent audit rows; secondary lets them try the endpoint live.
  'api/audit/logs': {
    primary: viewMyAuditLogs(),
    secondary: [playground('audit-logs')],
  },
  'api/audit/verify-chain': {
    primary: viewMyAuditLogs(),
    secondary: [playground('audit-verify-chain')],
  },
  'api/audit/version-usage': {
    primary: viewMyAuditLogs(),
    secondary: [playground('audit-version-usage')],
  },
  'api/audit/anomalies': {
    primary: viewMyAuditLogs(),
    secondary: [playground('audit-anomalies')],
  },
  'api/audit/compare': {
    primary: viewMyAuditLogs(),
    secondary: [playground('audit-compare')],
  },

  // GraphQL / WebSocket — playground is the obvious next step.
  'api/graphql/overview': {
    primary: playground('graphql-overview'),
    secondary: [],
  },
  'api/graphql/queries': {
    primary: playground('graphql-queries'),
    secondary: [],
  },
  'api/graphql/mutations': {
    primary: playground('graphql-mutations'),
    secondary: [openInEditor('api/graphql/mutations')],
  },
  'api/websocket/preview': {
    primary: playground('websocket-preview'),
    secondary: [],
  },

  // 指南：试点流程从控制台起步，跑完后去看自己的执行轨迹。
  'guides/credit-pilot': {
    primary: openDashboard(),
    secondary: [viewMyTraces()],
  },
};

/**
 * Look up the action set for a given slug. Returns null when the
 * caller can't resolve a slug (e.g. on a redirect or 404 path) so
 * the component can render nothing rather than throw.
 */
export function getPageActions(slug: string): PageActionSet | null {
  if (Object.prototype.hasOwnProperty.call(PAGE_ACTIONS, slug)) {
    return PAGE_ACTIONS[slug as RouteSlug];
  }
  return null;
}

/**
 * Canonicalize an action `href` to its pathname (no query string).
 * The jump endpoint compares the request's `target` field against
 * this canonical form so callers can't mint arbitrary audit-row
 * `target` values.
 */
export function canonicalTarget(action: PageAction): string {
  const q = action.href.indexOf('?');
  return q >= 0 ? action.href.slice(0, q) : action.href;
}

/**
 * Server-side validation for `/api/docs/jump` payloads. Returns the
 * matched action when the payload references a real (slug, cta_id)
 * pair whose canonical target matches the supplied target. Anything
 * else returns null. The endpoint refuses any null result so an
 * attacker cannot poison audit metadata with arbitrary strings.
 */
export function resolveAuditedAction(payload: {
  slug: string;
  cta_id: string;
  target: string;
}): PageAction | null {
  const set = getPageActions(payload.slug);
  if (!set) return null;
  const all: PageAction[] = [set.primary, ...(set.secondary ?? [])];
  const match = all.find((a) => a.id === payload.cta_id);
  if (!match || !match.audit) return null;
  if (canonicalTarget(match) !== payload.target) return null;
  return match;
}
