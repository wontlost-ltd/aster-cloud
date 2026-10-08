import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db, users } from '@/lib/prisma';
import { ensureSchemaApplied } from '@/lib/db-bootstrap';
import { getTranslations } from 'next-intl/server';
import { LanguageSwitcher } from '@/components/language-switcher';
import { UserDropdown } from '@/components/dashboard-nav';
import { fetchBackendVersion } from '@/lib/backend-version';
import { CommandPalette } from '@/components/dashboard/command-palette';
import { buildCommands } from '@/components/dashboard/command-palette-commands';
import { buildDocsSeeds } from '@/lib/docs/dashboard-docs-seeds';
import { ThemeToggle } from '@/components/theme-toggle';
import { DashboardSidebar } from '@/components/dashboard-sidebar';
import { DocsSessionSignal } from '@/components/docs/DocsSessionSignal';
import { DocsOverlayProvider } from '@/components/docs/docs-overlay-context';
import { DocsOverlay } from '@/components/docs/docs-overlay';
import { NotificationsBell } from '@/components/notifications/notifications-bell';
import { SkipToContent } from '@/components/skip-to-content';
import { getSession } from '@/lib/auth';
import { isAdminFromSession } from '@/lib/admin-auth';
import {
  CAN_BILLING,
  CAN_RISKTIER,
  CAN_LICENSE,
  CAN_SSO,
  IS_SAAS,
} from '@/lib/deployment-mode';
import { getEffectiveRole, canAccess } from '@/lib/effective-role';
import { resolveUserAllowedLocales } from '@/lib/team-locales';
import { defaultLocale } from '@/i18n/config';

/*
 * Dashboard shell — sidebar + slim topbar.
 *
 * IA decision from the SaaS-admin audit (P1-1):
 *   - Left sidebar carries the primary nav. Two groups: Workspace +
 *     Admin (the latter only for isAdmin sessions). Billing + Settings
 *     sit as account-scoped footer items below the groups.
 *   - Topbar carries only: brand (mobile only — sidebar shows it on
 *     desktop), Cmd-K search, theme + lang toggles, user dropdown.
 *   - The previous data-array-driven horizontal nav is gone. The
 *     (dashboard)/admin/* sub-shell no longer renders its red badge
 *     or AdminSidebar — admin links now live in the main sidebar's
 *     ADMIN group.
 *   - Sidebar collapses to a 64px icon rail on desktop (localStorage
 *     persisted). Mobile breaks to a hamburger-triggered drawer.
 */

export default async function DashboardLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  // Next.js 15 passes [locale] via params here — match the parent layout
  // pattern (src/app/[locale]/layout.tsx) instead of calling getLocale()
  // from next-intl/server. The latter requires the same request-scoped
  // context the parent layout has already established, but on OpenNext-on-
  // Cloudflare it can throw at deploy time when the platform-proxy preflight
  // tries to resolve the locale without a full request lifecycle.
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const routePrefix = locale === defaultLocale ? '' : `/${locale}`;

  // Run boot-time DB patches + admin seed on first request after a
  // cold start. Idempotent + advisory-locked; subsequent calls in
  // the same Worker instance short-circuit via a Promise cache. Awaited
  // here (rather than fire-and-forget) so the mustChangePassword column
  // exists before the redirect-gate below reads it.
  await ensureSchemaApplied();

  const t = await getTranslations('dashboardNav');
  const tSettings = await getTranslations('settings.account');
  const tNav = await getTranslations('nav');
  const tAdminRisk = await getTranslations('admin.riskTier');
  const tAdminCircuit = await getTranslations('admin.aiCircuitBreaker');
  const tAdminOverview = await getTranslations('admin.overview');
  const tAdminNav = await getTranslations('admin.nav');
  const tCmd = await getTranslations('dashboardNav.commandPalette');
  const tCommon = await getTranslations('common');

  const session = await getSession();
  const userId = session?.user?.id ?? null;

  // Force password rotation on first login for accounts provisioned
  // with a temporary password (admin bootstrap, future invitations).
  // The flag lives on the User row; we check it here so the gate
  // covers every dashboard surface in one place. The change-password
  // page sits OUTSIDE this layout (under (auth)) so the user can
  // reach it while still flagged.
  if (userId) {
    const row = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { mustChangePassword: true },
    });
    if (row?.mustChangePassword) {
      redirect(`/${locale}/onboarding/change-password`);
    }
  }

  const [admin, role, allowedLocales] = await Promise.all([
    isAdminFromSession(),
    userId ? getEffectiveRole(userId) : Promise.resolve('owner' as const),
    // 当前用户各团队语言白名单的并集；null = 不限制（无团队 / 至少一团队全开）。
    userId ? resolveUserAllowedLocales(userId) : Promise.resolve(null),
  ]);

  const userMenuLabels = {
    profile: t('userMenu.profile'),
    settings: t('settings'),
    signOut: tSettings('signOut'),
    signingOut: tSettings('signingOut'),
    help: t('userMenu.help'),
  };

  const aboutLabels = {
    title: t('about.title'),
    version: t('about.version'),
    build: t('about.build'),
    engine: t('about.engine'),
    messages: t('about.messages'),
    apiVersion: t('about.apiVersion'),
    unavailable: t('about.unavailable'),
    close: t('about.close'),
  };

  // 「关于」弹框的版本数据。前三项由 next.config 在 build 期从 package.json inline；
  // 后端版本需带凭证向 aster-api 取，失败返回 null → 弹框显示「不可用」（不阻塞渲染）。
  // ★tenantId 用 session.user.id：与 /api/llm/complete 同一约定
  //   （R25-Major-2：不采信 caller-supplied X-Tenant-Id）。
  const aboutVersions = {
    app: process.env.NEXT_PUBLIC_APP_VERSION ?? 'unknown',
    build: process.env.ASTER_RUNTIME_BUILD ?? 'dev',
    engine: process.env.NEXT_PUBLIC_ENGINE_VERSION ?? 'unknown',
    messages: process.env.NEXT_PUBLIC_MESSAGES_VERSION ?? 'unknown',
    api: userId ? await fetchBackendVersion(userId) : null,
  };

  const showBilling = canAccess(role, 'admin') && CAN_BILLING;

  return (
    <DocsOverlayProvider>
    <div className="min-h-screen bg-bg-subtle text-fg">
      <SkipToContent targetId="dashboard-main" />
      {/* Fire a cross-tab "session-refresh" signal so any open /docs
          tab revalidates its probe. The dashboard is the canonical
          post-OAuth landing route — credential sign-in fires the
          signal from the login-content success branch, and OAuth
          falls through to here. Renders nothing. */}
      <DocsSessionSignal />

      <DashboardSidebar
        localePrefix={routePrefix}
        isAdmin={admin !== null}
        showBilling={showBilling}
        labels={{
          brand: tNav('brand'),
          groupWorkspace: t('groupWorkspace'),
          groupAdmin: t('groupAdmin'),
          dashboard: t('dashboard'),
          policies: t('policies'),
          reports: t('reports'),
          approvals: t('approvals'),
          teams: t('teams'),
          domainVocabularies: t('domainVocabularies'),
          security: t('security'),
          apiKeys: t('apiKeys'),
          aiKeys: t('aiKeys'),
          adminOverview: tAdminOverview('title'),
          aiBreaker: tAdminCircuit('title'),
          riskTier: tAdminRisk('title'),
          license: tAdminNav('license'),
          licenseRevoke: tAdminNav('licenseRevoke'),
          issuedLicenses: tAdminNav('issuedLicenses'),
          sso: tAdminNav('sso'),
          billing: t('billing'),
          docs: t('docs'),
          settings: t('settings'),
          collapseSidebar: t('collapseSidebar'),
          expandSidebar: t('expandSidebar'),
          openMenu: t('mobile.openMenu'),
          closeMenu: t('mobile.closeMenu'),
        }}
        adminCapabilities={{
          riskTier: CAN_RISKTIER,
          license: CAN_LICENSE,
          // SaaS ops surfaces — Aster team revokes customer licenses
          // and inspects the full issued-license ledger.
          licenseRevoke: IS_SAAS,
          issuedLicenses: IS_SAAS,
          sso: CAN_SSO,
        }}
      />

      {/*
        Topbar + content shell — sits to the right of the sidebar on
        desktop. We can't statically know the sidebar width here (the
        client can collapse it), so the sidebar component publishes
        `--aster-sidebar-width` on <html> and we read it via inline
        style on md+. CSS transition keeps the shift smooth.

        Default fallback: 15rem (240px) so SSR has the right gutter
        before client hydration runs.
       */}
      <div
        className="md:transition-[padding-left] md:duration-200 md:ease-out"
        style={{
          paddingLeft: 'var(--aster-shell-pad-left, 0px)',
        }}
        data-shell="dashboard"
      >
        <header className="sticky top-0 z-20 border-b border-border bg-bg/80 backdrop-blur-md">
          <div className="flex h-16 items-center justify-end gap-3 px-4 pl-16 sm:px-6 lg:px-8 md:pl-4">
            {/* Mobile: the hamburger button is a fixed-positioned
                element rendered inside <DashboardSidebar>. We reserve
                the left-16 padding (pl-16) on mobile so the topbar
                content doesn't sit underneath it. md+ removes the
                reservation since the sidebar replaces the hamburger. */}
            <div className="flex items-center gap-3 sm:gap-4">
              <CommandPalette
                commands={buildCommands({
                  routePrefix,
                  labels: {
                    dashboard:   t('dashboard'),
                    policies:    t('policies'),
                    newPolicy:   tCmd('newPolicy'),
                    reports:     t('reports'),
                    approvals:   t('approvals'),
                    teams:       t('teams'),
                    security:    t('security'),
                    billing:     t('billing'),
                    settings:    t('settings'),
                    apiKeys:     tCmd('apiKeys'),
                    aiKeys:      tCmd('aiKeys'),
                    aiAssistant: tCmd('aiAssistant'),
                  },
                  canCreate:  canAccess(role, 'member'),
                  showBilling,
                  // Seed the palette with a curated slice of docs
                  // pages so logged-in users can Cmd+K → "evaluate"
                  // from any dashboard surface and jump into the
                  // matching reference.
                  docsSeeds: buildDocsSeeds(locale),
                })}
                labels={{
                  placeholder:    tCmd('placeholder'),
                  noResults:      tCmd('noResults'),
                  groupNavigate:  tCmd('groupNavigate'),
                  groupCreate:    tCmd('groupCreate'),
                  groupSettings:  tCmd('groupSettings'),
                  groupDocs:      tCmd('groupDocs'),
                  hintOpen:       tCmd('hintOpen'),
                }}
              />
              {/*
                NotificationsBell sits between Cmd-K (search) and the
                Theme/Lang switchers so the user's eye lands on it
                naturally — same column as the user avatar. Polls
                /api/notifications/count every 30s for the badge; the
                drop-down lazy-loads the list on first open.
              */}
              <NotificationsBell />
              <ThemeToggle
                labels={{
                  light: tCommon('themeLight'),
                  dark: tCommon('themeDark'),
                  system: tCommon('themeSystem'),
                }}
              />
              <LanguageSwitcher allowedLocales={allowedLocales} />
              <UserDropdown
                userMenuLabels={userMenuLabels}
                aboutLabels={aboutLabels}
                versions={aboutVersions}
                userName={session?.user?.name || undefined}
                userEmail={session?.user?.email || undefined}
              />
            </div>
          </div>
        </header>

        {/*
          Full-width passthrough — width + horizontal padding + vertical
          rhythm are owned by each page's <Container> (the design-system
          width authority). The previous `mx-auto max-w-7xl px-* py-*` here
          double-constrained pages that already used <Container>, producing
          the inconsistent widths + double padding the dashboard audit found.
          Keep only semantics (id for skip-link, tabIndex for focus) + min-w-0
          so flex/grid children can shrink.
        */}
        <main id="dashboard-main" tabIndex={-1} className="min-w-0 focus:outline-none">
          {children}
        </main>
      </div>
      {/* 登录后「文档」overlay：覆盖在 dashboard 上的三栏阅读面板（不跳转）。
          由 sidebar 的「文档」入口经 DocsOverlayProvider 打开。 */}
      <DocsOverlay />
    </div>
    </DocsOverlayProvider>
  );
}
