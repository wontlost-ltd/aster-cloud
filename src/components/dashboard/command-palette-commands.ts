/**
 * Server-safe half of the ⌘K command palette.
 *
 * Why split: command-palette.tsx is a 'use client' module because the
 * React component needs hooks + window listeners. But the layout (a
 * Server Component) needs to build the command list with localized
 * labels from next-intl, then pass it as a prop. Calling a function
 * exported from a 'use client' module on the server throws at runtime
 * ("Attempted to call buildCommands() from the server but buildCommands
 * is on the client"). Splitting keeps the catalog + types in a plain
 * module that both server and client can import freely.
 *
 * Why icons are strings (not components): Server Components serialize
 * props as JSON over the RSC wire. Lucide icons are forwardRef objects
 * — they can't cross the boundary without "Functions cannot be passed
 * directly to Client Components" errors. We ship an icon *id* and let
 * the client map it back to the component.
 */

/** Icon identifiers — mapped to Lucide components inside the palette. */
export type CommandIcon =
  | 'home'
  | 'file-text'
  | 'users'
  | 'shield-check'
  | 'sparkles'
  | 'wallet'
  | 'settings'
  | 'key-round'
  | 'book-text'
  | 'clipboard-check'
  | 'bot';

export interface Command {
  /** Stable id for keying React lists and analytics events. */
  id: string;
  /** Visible label — i18n-translated upstream and passed in via props. */
  label: string;
  /** Short helper text shown under the label. */
  hint?: string;
  /** Icon id — the client component looks up the Lucide component. */
  icon: CommandIcon;
  /** Route (locale prefix added by router.push call site). */
  href: string;
  /** Section header in the rendered list. */
  group: 'navigate' | 'policies' | 'create' | 'settings' | 'docs' | 'admin';
  /** Optional list of extra search keywords (e.g. translations of the label
   *  in other languages so a 中文 user can still search "policy"). */
  keywords?: string[];
  /** 为 true 时 href 不带 locale 前缀，且需整页导航（如会 302 跨域的交接路由）。 */
  external?: boolean;
}

/**
 * Build the default command list. The layout passes localized labels
 * (already translated via next-intl on the server) so this stays
 * i18n-clean. The keyword list is intentionally tri-lingual on the
 * highest-traffic items so 中文 / Deutsch users can still type
 * "policy" / "settings" and find the right command.
 */
/**
 * A docs surface command sourced from the build-time search index.
 * Carries the docs slug so the palette can route to the locale-aware
 * URL via the same logic the docs Cmd+K palette uses (`/docs/<slug>`
 * with the optional locale prefix prepended by the call site).
 */
export type DocsCommandSeed = {
  /** Stable id — `docs-<slug-with-dashes>`. */
  id: string;
  /** Title from the docs search index. */
  label: string;
  /** Locale-prefixed `/docs/<slug>` URL. */
  href: string;
};

export function buildPolicyCommands(
  policies: ReadonlyArray<{ id: string; name: string }>,
  query: string,
  routePrefix: string,
): Command[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return policies
    .filter((policy) => policy.name.toLowerCase().includes(needle))
    .slice(0, 8)
    .map<Command>((policy) => ({
      id: `policy-${policy.id}`,
      label: policy.name,
      href: `${routePrefix}/policies/${policy.id}`,
      icon: 'file-text',
      group: 'policies',
    }));
}

export interface BuildCommandsArgs {
  /** Locale prefix already applied to hrefs ('' for default, '/zh' etc). */
  routePrefix: string;
  /** Labels piped through from server-side getTranslations. */
  labels: {
    dashboard: string;
    policies: string;
    newPolicy: string;
    reports: string;
    approvals: string;
    teams: string;
    security: string;
    billing: string;
    settings: string;
    apiKeys: string;
    aiKeys: string;
    aiAssistant: string;
    domainVocabularies: string;
  };
  /** Optional viewer-only flag to hide create commands when role is viewer. */
  canCreate?: boolean;
  /** Whether to expose billing entry (admins only). */
  showBilling?: boolean;
  /**
   * Top docs commands from the locale's search index — passed in by
   * the dashboard layout so the palette can surface "Open docs:
   * Evaluate Policy" alongside app navigation. The build-time index
   * already runs through the docs PII scan, so feeding it into the
   * dashboard palette doesn't change the privacy story.
   */
  docsSeeds?: ReadonlyArray<DocsCommandSeed>;
  /** AI 工作台入口；仅当服务端判定已开启时传入（href 已含 locale，不再加前缀）。 */
  aiWorkspace?: { label: string; href: string };
  adminCommands?: ReadonlyArray<{ id: string; label: string; href: string }>;
}

export function buildCommands({
  routePrefix, labels, canCreate = true, showBilling = true, docsSeeds = [], aiWorkspace, adminCommands = [],
}: BuildCommandsArgs): Command[] {
  const p = routePrefix;
  const cmds: Command[] = [
    { id: 'dashboard',  group: 'navigate', icon: 'home',         label: labels.dashboard, href: `${p}/dashboard`,         keywords: ['仪表盘', 'übersicht'] },
    { id: 'policies',   group: 'policies', icon: 'file-text',    label: labels.policies,  href: `${p}/policies`,          keywords: ['policy', '策略', 'richtlinien'] },
    { id: 'domain-vocabularies', group: 'navigate', icon: 'book-text', label: labels.domainVocabularies, href: `${p}/domain-vocabularies`, keywords: ['vocabulary', 'terms', '词汇', 'Fachbegriffe'] },
    { id: 'reports',    group: 'navigate', icon: 'file-text',    label: labels.reports,   href: `${p}/reports`,           keywords: ['report', '报告', 'berichte'] },
    { id: 'approvals',  group: 'navigate', icon: 'clipboard-check', label: labels.approvals, href: `${p}/approvals`,       keywords: ['approval', 'approve', '审批', 'genehmigung', 'अनुमोदन'] },
    { id: 'teams',      group: 'navigate', icon: 'users',        label: labels.teams,     href: `${p}/teams`,             keywords: ['team', '团队'] },
    { id: 'security',   group: 'navigate', icon: 'shield-check', label: labels.security,  href: `${p}/security`,          keywords: ['security', '安全'] },
    ...(aiWorkspace
      ? ([{ id: 'ai-workspace', group: 'navigate', icon: 'bot', label: aiWorkspace.label, href: aiWorkspace.href, external: true, keywords: ['ai', 'agent', '工作台', 'ki', 'एआई'] }] as Command[])
      : []),

    ...(canCreate
      ? ([{ id: 'new-policy', group: 'create', icon: 'sparkles', label: labels.newPolicy, href: `${p}/policies/new`, keywords: ['create', '新建', 'neu'] }] as Command[])
      : []),

    ...(showBilling
      ? ([{ id: 'billing', group: 'settings', icon: 'wallet', label: labels.billing, href: `${p}/billing`, keywords: ['plan', '账单'] }] as Command[])
      : []),
    { id: 'settings',  group: 'settings', icon: 'settings',  label: labels.settings, href: `${p}/settings`,          keywords: ['settings', '设置'] },
    { id: 'api-keys',  group: 'settings', icon: 'key-round', label: labels.apiKeys,  href: `${p}/settings/api-keys`, keywords: ['api', 'token', '密钥'] },
    { id: 'ai-keys',   group: 'settings', icon: 'sparkles',  label: labels.aiKeys,   href: `${p}/settings/ai-keys`,  keywords: ['byok', 'openai', 'ai 密钥'] },

    ...adminCommands.map<Command>((command) => ({ ...command, group: 'admin', icon: 'shield-check', href: `${p}${command.href}` })),
    // Docs surface — bound entries from the build-time search index.
    // The dashboard layout slices the most relevant N pages from the
    // active locale's index and passes them in so the user can type
    // a docs title in Cmd+K and jump straight there. Slugs travel
    // through `docs.<slug>` keywords so a partial slug match (e.g.
    // "evaluate") still hits.
    ...docsSeeds.map<Command>((seed) => ({
      id: seed.id,
      group: 'docs',
      icon: 'book-text',
      label: seed.label,
      href: seed.href,
      keywords: [seed.id.replace(/^docs-/, '')],
    })),
  ];
  return cmds;
}
