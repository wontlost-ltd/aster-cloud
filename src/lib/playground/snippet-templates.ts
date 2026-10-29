/**
 * Playground snippet template registry.
 *
 * Source-of-truth for what content the policy editor pre-fills when a
 * user lands on `/policies/new?template=<id>` from a docs code block
 * or a docs "Try in Playground" action.
 *
 * Why a server-side allow-list:
 *   - The docs URL only carries a *template id* — never raw source.
 *     That keeps URLs short, prevents arbitrary-payload injection via
 *     bookmarks/links, and stops the audit-log resource id from
 *     carrying unbounded user content.
 *   - Unknown ids resolve to `null`, and `policies/new` then renders
 *     the empty editor as a fallback — never an error page.
 *   - Editing a template happens here, alongside the docs MDX fences
 *     it accompanies, so the docs → editor flow stays in sync.
 *
 * Syntax:
 *   All templates use canonical Aster CNL — `Module X.` declares the
 *   module, `Rule name given params as Type, produce ResultType:`
 *   declares an evaluable function. Older Rego-style snippets
 *   (`package`, `default allow := false`, `allow if {}`) were retired
 *   when the unified Module/Rule grammar landed; keeping any of them
 *   here would break the evaluator and mislead readers about the
 *   surface syntax.
 *
 * Naming convention:
 *   Identifiers are kebab-case. There are two id families:
 *     - `policy-<flavor>`        — historical ids referenced by MDX
 *                                  fences and the personalized home.
 *     - `<endpoint-slug>`        — short ids matching the docs sidebar
 *                                  slug tail (e.g. `evaluate-source`,
 *                                  `workflow-events`), used by the
 *                                  page-actions `playground(...)`
 *                                  helper so every docs page CTA has
 *                                  a deterministic landing template.
 *   Ids are stable across releases — changing one breaks every bookmark
 *   and CTA pointing at it.
 */

export type SnippetTemplate = {
  /** Stable id matched in URL `?template=<id>`. */
  id: string;
  /** Source text loaded into the editor. */
  source: string;
  /** Optional one-line description (i18n key); future use by the
   *  editor's "loaded from docs" notice. */
  descriptionKey?: string;
};

// ---------------------------------------------------------------------
// Canonical sources. Kept as module-level constants so multiple ids can
// share a template body (e.g. `evaluate` and `evaluate-source` both
// land on the basic Module/Rule example) without duplicating strings.
// ---------------------------------------------------------------------

const SOURCE_BASIC_GREETING = [
  'Module demo.',
  '',
  'Rule greet given name as Text, produce Text:',
  '  Return "Hello, " + name + "!".',
  '',
].join('\n');

const SOURCE_AMOUNT_THRESHOLD = [
  '# A minimal authorization policy — returns true when the request',
  '# carries an `amount` below the configured ceiling.',
  'Module examples.basic.',
  '',
  'Rule allow given amount as Float, produce Bool:',
  '  Return amount < 100.',
  '',
].join('\n');

const SOURCE_TIERED_ACCESS = [
  '# Batch-friendly rule set. The Playground will run the same',
  '# policy against every input the user provides.',
  'Module examples.batch.',
  '',
  'Rule allow given tenant as Text, tier as Text, produce Bool:',
  '  Return tenant equals to "preview" and (tier equals to "free" or tier equals to "pro").',
  '',
].join('\n');

const SOURCE_SCHEMA_SHAPE = [
  '# Source for schema extraction. Parameters declared on the rule',
  '# signature are surfaced by the schema endpoint as the input shape.',
  'Module examples.schema.',
  '',
  'Rule allow given userId as Text, resourceKind as Text, action as Text, produce Bool:',
  '  Return resourceKind equals to "policy" and (action equals to "read" or action equals to "list").',
  '',
].join('\n');

const SOURCE_VERSIONED_POLICY = [
  '# Versioned policy — change a value, save, and inspect the',
  '# revision history via the versions endpoint.',
  'Module examples.versioning.',
  '',
  'Rule allow given role as Text, produce Bool:',
  '  Return role equals to "owner".',
  '',
].join('\n');

const SOURCE_VALIDATE_ONLY = [
  '# A policy used to exercise the validate endpoint. Compilation',
  '# succeeds even though no runtime evaluation is performed.',
  'Module examples.validate.',
  '',
  'Rule allow given action as Text, produce Bool:',
  '  Return action equals to "read" or action equals to "list".',
  '',
].join('\n');

// Workflow templates. The workflow surface is observational — the
// endpoint family records events and rolls them up into state +
// metrics. Templates are minimal CNL modules that emit the kind of
// decisions a workflow would observe; the docs page CTA lands the
// reader on a real policy + a recently-touched trace so the workflow
// docs are useful even before they wire up their first stream.
const SOURCE_WORKFLOW_DECISION = [
  '# Minimal policy whose decisions feed the workflow surface.',
  '# Pair this with `?trace=true` to see the decision trace that the',
  '# workflow events endpoint records and rolls up into state/metrics.',
  'Module workflows.demo.',
  '',
  'Rule decide given event as Text, payload as Text, produce Bool:',
  '  Return event equals to "approved" or payload equals to "auto-approve".',
  '',
].join('\n');

// GraphQL / WebSocket — surfaces that mostly mirror policy evaluation
// at the transport layer. The template body is the same basic
// Module/Rule pair so a reader can paste it into the GraphQL mutation
// or the WS preview frame without rewriting it.
const SOURCE_GRAPHQL_DEMO = [
  '# Use this module as the policy body in your GraphQL evaluate',
  '# mutation. The mutation shape mirrors the REST evaluate-source',
  '# request, with `source`, `context`, and `functionName` arguments.',
  'Module examples.graphql.',
  '',
  'Rule evaluate given subject as Text, action as Text, produce Bool:',
  '  Return action equals to "read" or subject equals to "admin".',
  '',
].join('\n');

const SOURCE_WEBSOCKET_PREVIEW = [
  '# Preview frame body for the public WebSocket endpoint. Send this',
  '# as the `source` of an `evaluate-source` frame against the',
  '# preview tenant; no authentication required.',
  'Module preview.demo.',
  '',
  'Rule greet given name as Text, produce Text:',
  '  Return "Hello, " + name + "!".',
  '',
].join('\n');

const SOURCE_AUDIT_LOOKUP = [
  '# Decisions emitted by this policy show up in the audit log under',
  '# the calling tenant. Use the audit endpoints to verify the chain,',
  '# enumerate version usage, or compare two evaluations.',
  'Module examples.audit.',
  '',
  'Rule allow given actor as Text, resource as Text, produce Bool:',
  '  Return actor equals to "service-account" and (resource equals to "policy" or resource equals to "audit-log").',
  '',
].join('\n');

/**
 * The registry. Adding a new entry requires:
 *   1. Picking a stable `id` (kebab-case, no leading slash).
 *   2. Reusing a canonical source above when the body would otherwise
 *      duplicate, or authoring a complete, self-contained `source`
 *      that runs in the public preview tenant without external
 *      resources.
 *   3. Updating the matching MDX code fence or page-actions entry
 *      so the docs Open-in-Playground button targets the id.
 *
 * Order: grouped by feature (policy → workflow → audit → graphql →
 * websocket) so future audits can scan it. Within each group, the
 * `policy-*` historical ids come first, followed by the short
 * endpoint-tail ids referenced by `page-actions.ts`.
 */
const TEMPLATES: ReadonlyArray<SnippetTemplate> = [
  // ----- Policy evaluation -----------------------------------------
  // Historical ids used by MDX + DocsHomeAuthenticated.
  { id: 'policy-evaluate-basic', source: SOURCE_AMOUNT_THRESHOLD },
  { id: 'policy-batch', source: SOURCE_TIERED_ACCESS },
  { id: 'policy-schema', source: SOURCE_SCHEMA_SHAPE },
  { id: 'policy-versions', source: SOURCE_VERSIONED_POLICY },

  // Short ids referenced by page-actions playground() helper.
  // `evaluate-source` and `evaluate` are the two REST entry points
  // for the basic Module/Rule body; both land on the same demo so a
  // reader can switch between docs pages without losing context.
  { id: 'evaluate-source', source: SOURCE_BASIC_GREETING },
  { id: 'evaluate', source: SOURCE_BASIC_GREETING },
  { id: 'evaluate-json', source: SOURCE_AMOUNT_THRESHOLD },
  { id: 'batch', source: SOURCE_TIERED_ACCESS },
  { id: 'schema', source: SOURCE_SCHEMA_SHAPE },
  { id: 'validate', source: SOURCE_VALIDATE_ONLY },
  { id: 'versions', source: SOURCE_VERSIONED_POLICY },
  { id: 'rollback', source: SOURCE_VERSIONED_POLICY },
  { id: 'cache', source: SOURCE_AMOUNT_THRESHOLD },

  // ----- Workflows --------------------------------------------------
  // Shared decision body — all three workflow docs (events, state,
  // metrics) observe the same underlying decisions, so pointing at
  // a single canonical module keeps the reader's mental model
  // anchored as they read across the section.
  { id: 'workflow-events', source: SOURCE_WORKFLOW_DECISION },
  { id: 'workflow-state', source: SOURCE_WORKFLOW_DECISION },
  { id: 'workflow-metrics', source: SOURCE_WORKFLOW_DECISION },

  // ----- Audit -----------------------------------------------------
  { id: 'audit-logs', source: SOURCE_AUDIT_LOOKUP },
  { id: 'audit-verify-chain', source: SOURCE_AUDIT_LOOKUP },
  { id: 'audit-version-usage', source: SOURCE_AUDIT_LOOKUP },
  { id: 'audit-anomalies', source: SOURCE_AUDIT_LOOKUP },
  { id: 'audit-compare', source: SOURCE_AUDIT_LOOKUP },

  // ----- GraphQL / WebSocket ---------------------------------------
  { id: 'graphql-overview', source: SOURCE_GRAPHQL_DEMO },
  { id: 'graphql-queries', source: SOURCE_GRAPHQL_DEMO },
  { id: 'graphql-mutations', source: SOURCE_GRAPHQL_DEMO },
  { id: 'websocket-preview', source: SOURCE_WEBSOCKET_PREVIEW },
] as const;

/**
 * O(1) lookup map built once at module-load.
 */
const TEMPLATE_BY_ID = new Map<string, SnippetTemplate>(
  TEMPLATES.map((t) => [t.id, t]),
);

/**
 * Look up a template by id. Returns null for unknown ids so callers
 * can fall back to the empty editor instead of throwing.
 *
 * The lookup is exact-match. Ids are author-controlled (chosen when
 * authoring the docs fence) so they're already constrained; the
 * registry does no normalization.
 */
export function getSnippetTemplate(id: string): SnippetTemplate | null {
  return TEMPLATE_BY_ID.get(id) ?? null;
}

/**
 * Enumerate the registry — used by tests + the docs registry-coverage
 * audit script to assert every advertised template id actually exists.
 */
export function listSnippetTemplates(): ReadonlyArray<SnippetTemplate> {
  return TEMPLATES;
}
