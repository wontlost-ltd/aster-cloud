'use client';

import { useState, useRef, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { Link } from '@/i18n/navigation';
import { clearDocsSessionCache } from '@/lib/docs/use-docs-session';
import { AboutDialog, type AboutDialogLabels, type AboutVersions } from './about-dialog';

interface NavItem {
  href: string;
  label: string;
}

interface DashboardNavClientProps {
  navItems: NavItem[];
  secondaryItems: NavItem[];
  userMenuLabels: {
    profile: string;
    settings: string;
    signOut: string;
    signingOut: string;
    help: string;
    about: string;
  };
  mobileMenuLabels: {
    openMenu: string;
    closeMenu: string;
  };
  userName?: string;
  userEmail?: string;
}

export function MobileMenuButton({
  isOpen,
  onToggle,
  labels,
}: {
  isOpen: boolean;
  onToggle: () => void;
  labels: { openMenu: string; closeMenu: string };
}) {
  return (
    <button
      type="button"
      className="sm:hidden inline-flex items-center justify-center p-2 rounded-md text-fg-muted hover:text-fg hover:bg-bg-subtle focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary transition-colors"
      aria-expanded={isOpen}
      aria-label={isOpen ? labels.closeMenu : labels.openMenu}
      onClick={onToggle}
    >
      {isOpen ? (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      ) : (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      )}
    </button>
  );
}

export function UserDropdown({
  userMenuLabels,
  aboutLabels,
  versions,
  userName,
  userEmail,
}: {
  userMenuLabels: {
    profile: string;
    settings: string;
    signOut: string;
    signingOut: string;
    help: string;
    about: string;
  };
  aboutLabels: AboutDialogLabels;
  versions: AboutVersions;
  userName?: string;
  userEmail?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSignOut = async () => {
    setIsSigningOut(true);
    // Invalidate the docs session cache so any open docs tab flips to
    // anonymous chrome immediately via the cross-tab storage event.
    clearDocsSessionCache();
    await signOut({ callbackUrl: '/' });
  };

  const userInitial = userName?.charAt(0)?.toUpperCase() || userEmail?.charAt(0)?.toUpperCase() || 'U';

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        className="w-8 h-8 rounded-full bg-primary-subtle flex items-center justify-center hover:bg-primary-subtle focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary"
        aria-expanded={isOpen}
        aria-haspopup="true"
        aria-label={userMenuLabels.profile}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className="text-primary text-sm font-medium">{userInitial}</span>
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-48 rounded-md shadow-lg py-1 bg-bg border border-border ring-1 ring-black/5 dark:ring-white/10 z-50">
          {userEmail && (
            <div className="px-4 py-2 border-b border-border">
              <p className="text-sm font-medium text-fg truncate">{userName || userEmail}</p>
              {userName && <p className="text-xs text-fg-muted truncate">{userEmail}</p>}
            </div>
          )}
          <Link
            href="/settings"
            className="block px-4 py-2 text-sm text-fg hover:bg-bg-subtle"
            onClick={() => setIsOpen(false)}
          >
            {userMenuLabels.settings}
          </Link>
          {/* 「帮助」进文档站；版本信息单独放在「关于」项，两者各司其职 */}
          <Link
            href="/docs"
            className="block px-4 py-2 text-sm text-fg hover:bg-bg-subtle"
            onClick={() => setIsOpen(false)}
          >
            {userMenuLabels.help}
          </Link>
          <button
            type="button"
            className="block w-full text-left px-4 py-2 text-sm text-fg hover:bg-bg-subtle"
            onClick={() => {
              setIsOpen(false);
              setIsAboutOpen(true);
            }}
          >
            {userMenuLabels.about}
          </button>
          <button
            type="button"
            className="block w-full text-left px-4 py-2 text-sm text-fg hover:bg-bg-subtle"
            onClick={handleSignOut}
            disabled={isSigningOut}
          >
            {isSigningOut ? userMenuLabels.signingOut : userMenuLabels.signOut}
          </button>
        </div>
      )}

      {isAboutOpen && (
        <AboutDialog
          labels={aboutLabels}
          versions={versions}
          onClose={() => setIsAboutOpen(false)}
        />
      )}
    </div>
  );
}

export function DesktopNav({ navItems }: { navItems: NavItem[] }) {
  const pathname = usePathname();

  const isActive = (href: string) => {
    const pathWithoutLocale = pathname.replace(/^\/[a-z]{2}(?=\/|$)/, '');
    if (href === '/dashboard') {
      return pathWithoutLocale === '/dashboard' || pathWithoutLocale === '';
    }
    return pathWithoutLocale.startsWith(href);
  };

  return (
    <div className="hidden sm:ml-8 sm:flex sm:space-x-8">
      {navItems.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={`inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium transition-colors ${
            isActive(item.href)
              ? 'border-primary text-fg'
              : 'border-transparent text-fg-muted hover:border-border-strong hover:text-fg'
          }`}
          aria-current={isActive(item.href) ? 'page' : undefined}
        >
          {item.label}
        </Link>
      ))}
    </div>
  );
}

export function MobileNav({
  isOpen,
  navItems,
  secondaryItems,
}: {
  isOpen: boolean;
  navItems: NavItem[];
  secondaryItems: NavItem[];
}) {
  const pathname = usePathname();

  const isActive = (href: string) => {
    const pathWithoutLocale = pathname.replace(/^\/[a-z]{2}(?=\/|$)/, '');
    if (href === '/dashboard') {
      return pathWithoutLocale === '/dashboard' || pathWithoutLocale === '';
    }
    return pathWithoutLocale.startsWith(href);
  };

  if (!isOpen) return null;

  return (
    <div className="sm:hidden absolute top-16 inset-x-0 bg-bg border-b border-border shadow-lg z-50">
      <div className="pt-2 pb-3 space-y-1">
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`block pl-3 pr-4 py-2 border-l-4 text-base font-medium transition-colors ${
              isActive(item.href)
                ? 'bg-primary-subtle border-primary text-fg'
                : 'border-transparent text-fg-muted hover:bg-bg-subtle hover:border-border-strong hover:text-fg'
            }`}
            aria-current={isActive(item.href) ? 'page' : undefined}
          >
            {item.label}
          </Link>
        ))}
      </div>
      <div className="pt-2 pb-3 border-t border-border">
        {secondaryItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`block pl-3 pr-4 py-2 border-l-4 text-base font-medium transition-colors ${
              isActive(item.href)
                ? 'bg-primary-subtle border-primary text-fg'
                : 'border-transparent text-fg-muted hover:bg-bg-subtle hover:border-border-strong hover:text-fg'
            }`}
            aria-current={isActive(item.href) ? 'page' : undefined}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

export function DashboardNavClient({
  navItems,
  secondaryItems,
  mobileMenuLabels,
}: DashboardNavClientProps) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const pathname = usePathname();

  // Close mobile menu on route change
  useEffect(() => {
    // 路由(pathname)变化时关闭移动端菜单——按外部状态(路由)变化重置本地 UI 状态，属合法的状态重置。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsMobileMenuOpen(false);
  }, [pathname]);

  return (
    <>
      <MobileMenuButton
        isOpen={isMobileMenuOpen}
        onToggle={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
        labels={mobileMenuLabels}
      />
      <DesktopNav navItems={navItems} />
      <MobileNav
        isOpen={isMobileMenuOpen}
        navItems={navItems}
        secondaryItems={secondaryItems}
      />
    </>
  );
}
