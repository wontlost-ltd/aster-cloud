'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  FileText,
  BarChart3,
  Users,
  Shield,
  KeyRound,
  Sparkles,
  BookOpen,
  Settings,
  CreditCard,
  ShieldCheck,
  Zap,
  AlertTriangle,
  Package,
  Lock,
  Receipt,
  Ban,
  BookText,
  ClipboardCheck,
  ChevronsLeft,
  ChevronsRight,
  Menu,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { cn } from '@/components/ui';
import { useDocsOverlay } from '@/components/docs/docs-overlay-context';

/*
 * Dashboard sidebar — primary navigation for the post-login shell.
 *
 * Replaces the previous top-bar that mixed workspace + admin items
 * into one horizontal array. Two groups now:
 *   - Workspace: pages every signed-in user needs (Dashboard, Policies,
 *     Reports, Teams, Security, API keys, AI keys).
 *   - Admin:    SaaS/on-prem operator surfaces, only rendered when
 *     props.isAdmin is true. (Overview / AI Circuit / Risk Tier /
 *     License / SSO.) Billing + Settings sit below the groups as
 *     account-scoped items.
 *
 * Collapsible: desktop users can toggle 240px ↔ 64px rail via the
 * arrow button in the footer. Choice persists across reloads via
 * localStorage. Mobile breaks to a drawer triggered by the topbar
 * hamburger.
 *
 * a11y:
 *   - <nav aria-label> + group <h3> with semantic spacing
 *   - active route uses aria-current="page"
 *   - icons aria-hidden so screen readers read the label, not glyph
 *   - collapsed labels still announced via aria-label on the link
 *   - drawer has focus-trap-style escape on backdrop click + ESC
 */

export interface SidebarItem {
  href: string;
  /** Visible label. Doubles as aria-label when collapsed. */
  label: string;
  icon: LucideIcon;
  /** Match strategy for active state. Defaults to 'prefix'. */
  match?: 'exact' | 'prefix';
  /**
   * When set, the item renders as a <button> that calls onSelect instead of
   * navigating — used by the Docs entry to open the in-dashboard docs overlay
   * (no route change, so the user keeps their current page underneath).
   */
  onSelect?: () => void;
}

export interface SidebarGroup {
  heading: string;
  items: SidebarItem[];
}

interface SidebarContentProps {
  groups: SidebarGroup[];
  /**
   * Footer items live below the groups, visually separated. Used for
   * Billing + Settings — they're not "workspace" or "admin" so they
   * deserve their own row.
   */
  footerItems: SidebarItem[];
  /**
   * When true, the sidebar shows only icons (64px rail). When false,
   * full labels next to icons (240px). Desktop only; mobile drawer
   * always shows full labels regardless.
   */
  collapsed: boolean;
  /** Locale-prefix-stripped pathname for active matching. */
  pathname: string;
  /** Click handler for the desktop collapse/expand button. */
  onToggleCollapsed?: () => void;
  /** Optional: hide the collapse toggle entirely (mobile drawer). */
  hideCollapseToggle?: boolean;
  /** Label for collapse / expand button. */
  collapseLabel: string;
  expandLabel: string;
  /** Brand label rendered at the top. */
  brand: string;
}

function isActive(
  pathname: string,
  href: string,
  match: 'exact' | 'prefix' = 'prefix',
): boolean {
  if (match === 'exact') return pathname === href;
  return pathname === href || pathname.startsWith(href + '/');
}

function SidebarLink({
  item,
  pathname,
  collapsed,
}: {
  item: SidebarItem;
  pathname: string;
  collapsed: boolean;
}) {
  const active = isActive(pathname, item.href, item.match);
  const Icon = item.icon;
  const className = cn(
    'group flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
    'focus-visible:outline-none focus-visible:shadow-ring',
    collapsed && 'justify-center px-2',
    active
      ? 'bg-primary-subtle text-primary'
      : 'text-fg-muted hover:bg-bg-subtle hover:text-fg',
  );
  const inner = (
    <>
      <Icon className="size-4 shrink-0" aria-hidden />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </>
  );
  return (
    <li>
      {item.onSelect ? (
        <button
          type="button"
          // 包一层箭头函数：直接 onClick={item.onSelect} 会把 MouseEvent 当
          // openDocs(next) 的参数传进去 → slug 变成事件对象 → /docs/[object Object] 404。
          onClick={() => item.onSelect?.()}
          aria-label={collapsed ? item.label : undefined}
          title={collapsed ? item.label : undefined}
          className={className}
        >
          {inner}
        </button>
      ) : (
        <Link
          href={item.href}
          aria-current={active ? 'page' : undefined}
          aria-label={collapsed ? item.label : undefined}
          title={collapsed ? item.label : undefined}
          className={className}
        >
          {inner}
        </Link>
      )}
    </li>
  );
}

function SidebarContent({
  groups,
  footerItems,
  collapsed,
  pathname,
  onToggleCollapsed,
  hideCollapseToggle,
  collapseLabel,
  expandLabel,
  brand,
}: SidebarContentProps) {
  return (
    <div className="flex h-full flex-col">
      {/* Brand row — same height as the topbar (h-16) so the two
          chrome edges line up visually. */}
      <div
        className={cn(
          'flex h-16 items-center border-b border-border px-4',
          collapsed && 'justify-center px-2',
        )}
      >
        <Link
          href="/dashboard"
          className="flex items-center gap-2 text-base font-semibold text-primary"
        >
          {/* Brand glyph — uses /public/logo.svg so the dashboard brand
              matches docs / marketing surfaces. eslint-disable for
              <img>: the logo is a tiny static asset, next/image would
              add LCP / preconnect overhead without benefit. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.svg"
            alt=""
            aria-hidden
            className="size-5 shrink-0"
          />
          {!collapsed && <span className="truncate">{brand}</span>}
        </Link>
      </div>

      {/* Groups */}
      <nav
        aria-label="Primary navigation"
        className="flex-1 overflow-y-auto px-2 py-4"
      >
        {groups.map((group) => (
          <div key={group.heading} className="mb-6 last:mb-0">
            {!collapsed && (
              <h3 className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                {group.heading}
              </h3>
            )}
            <ul className="flex flex-col gap-1">
              {group.items.map((item) => (
                <SidebarLink
                  key={item.href}
                  item={item}
                  pathname={pathname}
                  collapsed={collapsed}
                />
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {/* Footer items (Billing / Settings) — separator above so they
          read as account-scoped rather than another nav group. */}
      <div className="border-t border-border px-2 py-2">
        <ul className="flex flex-col gap-1">
          {footerItems.map((item) => (
            <SidebarLink
              key={item.href}
              item={item}
              pathname={pathname}
              collapsed={collapsed}
            />
          ))}
        </ul>
      </div>

      {/* Collapse / expand toggle (desktop only). */}
      {!hideCollapseToggle && onToggleCollapsed && (
        <div className="border-t border-border p-2">
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? expandLabel : collapseLabel}
            title={collapsed ? expandLabel : collapseLabel}
            className={cn(
              'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-fg-muted',
              'hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:shadow-ring',
              collapsed && 'justify-center px-2',
            )}
          >
            {collapsed ? (
              <ChevronsRight className="size-4 shrink-0" aria-hidden />
            ) : (
              <>
                <ChevronsLeft className="size-4 shrink-0" aria-hidden />
                <span>{collapseLabel}</span>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

interface DashboardSidebarProps {
  /** Locale prefix (e.g. "" or "/zh"). Used to strip from pathname for
   *  active-state matching since usePathname() returns the localized path. */
  localePrefix: string;
  /** Show the Admin group? */
  isAdmin: boolean;
  /** Show /billing in footer? (SaaS + admin role.) */
  showBilling: boolean;
  labels: {
    brand: string;
    groupWorkspace: string;
    groupAdmin: string;
    dashboard: string;
    policies: string;
    reports: string;
    approvals: string;
    teams: string;
    domainVocabularies: string;
    security: string;
    apiKeys: string;
    aiKeys: string;
    adminOverview: string;
    aiBreaker: string;
    riskTier: string;
    license: string;
    licenseRevoke: string;
    issuedLicenses: string;
    sso: string;
    billing: string;
    docs: string;
    settings: string;
    collapseSidebar: string;
    expandSidebar: string;
    openMenu: string;
    closeMenu: string;
  };
  /** Which admin items to render — driven by deployment-mode capabilities. */
  adminCapabilities: {
    riskTier: boolean;
    license: boolean;
    licenseRevoke: boolean;
    issuedLicenses: boolean;
    sso: boolean;
  };
}

const COLLAPSED_KEY = 'aster.sidebar.collapsed';

export function DashboardSidebar({
  localePrefix,
  isAdmin,
  showBilling,
  labels,
  adminCapabilities,
}: DashboardSidebarProps) {
  // Docs overlay opener — the Docs entry opens an in-dashboard reading
  // panel instead of navigating to /docs (so the user keeps their page).
  const { openDocs } = useDocsOverlay();
  // Desktop collapse state — persisted to localStorage so a user who
  // chose the rail layout keeps it across reloads. SSR returns the
  // expanded state; the client may collapse on hydrate.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  });

  // Publish the sidebar width as a CSS custom property on <html> so
  // the topbar + main content area can pad-left themselves without
  // needing a React context. The shell layout reads
  // `--aster-sidebar-width` via `padding-left: var(--aster-sidebar-width)`
  // on the md+ breakpoint. Updating on every collapse keeps the
  // transition smooth (the value tweens via CSS transition).
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.style.setProperty(
      '--aster-sidebar-width',
      collapsed ? '4rem' : '15rem',
    );
  }, [collapsed]);

  // Mobile drawer state — independent of collapse. The drawer ignores
  // `collapsed` and always renders expanded labels (a collapsed drawer
  // would be a useless density compromise on a phone).
  const [drawerOpen, setDrawerOpen] = useState(false);

  // ESC closes the drawer + body scroll lock while open.
  useEffect(() => {
    if (!drawerOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setDrawerOpen(false);
    }
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [drawerOpen]);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
      return next;
    });
  };

  // Strip locale prefix so /zh/policies and /policies both match the
  // sidebar's locale-free hrefs.
  const rawPath = usePathname() ?? '/';
  const pathname = localePrefix && rawPath.startsWith(localePrefix)
    ? rawPath.slice(localePrefix.length) || '/'
    : rawPath;

  // Build the group lists from labels + capabilities. Workspace
  // absorbs the old "Organization" cluster (Teams / Security / API
  // keys / AI keys) per the IA decision.
  const workspace: SidebarItem[] = [
    { href: '/dashboard', label: labels.dashboard, icon: LayoutDashboard, match: 'exact' },
    { href: '/policies',  label: labels.policies,  icon: FileText },
    { href: '/reports',   label: labels.reports,   icon: BarChart3 },
    { href: '/approvals', label: labels.approvals, icon: ClipboardCheck },
    { href: '/teams',     label: labels.teams,     icon: Users },
    { href: '/domain-vocabularies', label: labels.domainVocabularies, icon: BookOpen },
    { href: '/security',  label: labels.security,  icon: Shield },
    { href: '/settings/api-keys', label: labels.apiKeys, icon: KeyRound },
    { href: '/settings/ai-keys',  label: labels.aiKeys,  icon: Sparkles },
    // Docs entry — opens the in-dashboard docs overlay (onSelect) instead
    // of navigating to /docs, so the user keeps their current page
    // underneath and can close the overlay to return to it. Sits at the
    // bottom of Workspace so the daily-use surfaces stay at the top.
    { href: '/docs',      label: labels.docs,      icon: BookText, onSelect: openDocs },
  ];

  const adminItems: SidebarItem[] = isAdmin
    ? [
        { href: '/admin',                   label: labels.adminOverview, icon: ShieldCheck, match: 'exact' },
        { href: '/admin/ai-circuit-breaker', label: labels.aiBreaker,    icon: Zap },
        ...(adminCapabilities.riskTier
          ? [{ href: '/admin/risk-tier', label: labels.riskTier, icon: AlertTriangle } as SidebarItem]
          : []),
        ...(adminCapabilities.license
          ? [{ href: '/admin/license', label: labels.license, icon: Package } as SidebarItem]
          : []),
        ...(adminCapabilities.licenseRevoke
          ? [{ href: '/admin/license-revoke', label: labels.licenseRevoke, icon: Ban } as SidebarItem]
          : []),
        ...(adminCapabilities.issuedLicenses
          ? [{ href: '/admin/issued-licenses', label: labels.issuedLicenses, icon: Receipt } as SidebarItem]
          : []),
        ...(adminCapabilities.sso
          ? [{ href: '/admin/sso', label: labels.sso, icon: Lock } as SidebarItem]
          : []),
      ]
    : [];

  const groups: SidebarGroup[] = [
    { heading: labels.groupWorkspace, items: workspace },
    ...(isAdmin ? [{ heading: labels.groupAdmin, items: adminItems }] : []),
  ];

  const footerItems: SidebarItem[] = [
    ...(showBilling
      ? [{ href: '/billing', label: labels.billing, icon: CreditCard } as SidebarItem]
      : []),
    { href: '/settings', label: labels.settings, icon: Settings, match: 'exact' },
  ];

  return (
    <>
      {/* Desktop sidebar — collapsible. Hidden under md. */}
      <aside
        className={cn(
          'hidden md:flex md:flex-col md:fixed md:inset-y-0 md:left-0 md:z-30 md:border-r md:border-border md:bg-bg',
          'transition-[width] duration-200 ease-out',
          collapsed ? 'md:w-16' : 'md:w-60',
        )}
        aria-label="Primary"
      >
        <SidebarContent
          groups={groups}
          footerItems={footerItems}
          collapsed={collapsed}
          pathname={pathname}
          onToggleCollapsed={toggleCollapsed}
          collapseLabel={labels.collapseSidebar}
          expandLabel={labels.expandSidebar}
          brand={labels.brand}
        />
      </aside>

      {/*
        Mobile hamburger — positioned absolutely so it appears in the
        topbar's left edge regardless of where this <aside> sits in the
        DOM. The parent layout reserves space for it on mobile (md:hidden)
        by placing a width-9 spacer in the topbar.
       */}
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        aria-label={labels.openMenu}
        aria-expanded={drawerOpen}
        aria-controls="dashboard-sidebar-drawer"
        className="md:hidden fixed left-3 top-3 z-40 inline-flex size-10 items-center justify-center rounded-md border border-border bg-bg text-fg-muted shadow-sm hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:shadow-ring"
      >
        <Menu className="size-5" aria-hidden />
      </button>

      {/* Mobile drawer — full-height left slide-in with backdrop. */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-50 md:hidden"
          id="dashboard-sidebar-drawer"
          role="dialog"
          aria-modal="true"
          aria-label={labels.brand}
        >
          <button
            type="button"
            aria-label={labels.closeMenu}
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-fg/40"
          />
          <div className="relative flex h-full w-72 max-w-[85%] flex-col bg-bg shadow-xl">
            {/* Close button sits inside the drawer (top-right) so a user
                who tapped the hamburger has an obvious way out without
                hunting for the backdrop. */}
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label={labels.closeMenu}
              className="absolute right-2 top-2 inline-flex size-9 items-center justify-center rounded-md text-fg-muted hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:shadow-ring"
            >
              <X className="size-5" aria-hidden />
            </button>
            <SidebarContent
              groups={groups}
              footerItems={footerItems}
              collapsed={false}
              pathname={pathname}
              hideCollapseToggle
              collapseLabel={labels.collapseSidebar}
              expandLabel={labels.expandSidebar}
              brand={labels.brand}
            />
          </div>
        </div>
      )}
    </>
  );
}
