import { setRequestLocale } from 'next-intl/server';
import { DocsTopNav } from '@/components/docs/DocsTopNav';
import { DocsSidebar } from '@/components/docs/DocsSidebar';
import { DocsTOC } from '@/components/docs/DocsTOC';
import { DocsBreadcrumb } from '@/components/docs/DocsBreadcrumb';
import { DocsPageActions } from '@/components/docs/DocsPageActions';
import { DocsVisitRecorder } from '@/components/docs/DocsVisitRecorder';
import { DocsSessionProvider } from '@/lib/docs/use-docs-session';

/**
 * Docs render dynamically.
 *
 * Phase-1 v1 forced these routes to SSG to skip Worker CPU. Audit
 * round-2 caught a real conflict: the parent locale layout reads a
 * per-request CSP nonce via `headers()` to stamp inline scripts
 * (theme bootstrap, `__name` polyfill, framework flight chunks).
 * Under SSG that nonce is build-time-fixed and stops matching the
 * fresh nonce middleware regenerates on every request, which makes
 * production CSP block hydration scripts.
 *
 * Dynamic rendering keeps the nonce live. MDX compile happens at
 * build time anyway — only RSC payload assembly + theme/intl
 * provider wrap runs on the worker, which is fast.
 */
export const dynamic = 'force-dynamic';

/**
 * Docs subsite layout — Session 2 chrome.
 *
 * Structure (top→bottom, left→right):
 *   fixed top:  <DocsTopNav>           — brand · language · open console
 *   left:       <DocsSidebar>          — section/page tree (lg+ only)
 *   center:     <main><article>{mdx}</article></main> — prose content
 *   right:      <DocsTOC>              — auto h2/h3 outline (xl+ only)
 *
 * Layout choices:
 *   - Fixed top nav (h-16) — content gets pt-16 to clear it.
 *   - Sidebar collapses below lg (1024px) — small screens get pure content.
 *   - TOC collapses below xl (1280px) — laptops drop it to give the
 *     article more horizontal room.
 *   - `.docs-article` class is the IntersectionObserver root in
 *     <DocsTOC>; do not rename without updating both.
 */
type Props = {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
};

export default async function DocsLayout({ children, params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <DocsSessionProvider>
      <div className="min-h-screen bg-bg">
        <DocsTopNav />
        {/* Cmd+K / Ctrl+K palette is mounted at the root locale
            layout (Phase 7) so every surface shares the same
            shortcut + dialog, not just docs. */}
        {/* Records the current page's visit into localStorage so the
            personalized home (Phase 6) can show Resume Reading and
            Recent docs panels. Renders nothing. */}
        <DocsVisitRecorder />
        {/* Mobile: stack drawer-above-content via flex-col so the
            collapsible <details> in DocsSidebar lays out above the
            article. Switch to flex-row at lg+ where the persistent
            sidebar takes its column. */}
        <div className="mx-auto flex flex-col lg:flex-row max-w-[1400px] pt-16">
          <DocsSidebar />
          {/* 移动端底部多留 6rem：右下角固定的助手按钮不再盖住页面末尾的链接（如页脚「Suggest an edit」，#774） */}
          <main className="min-w-0 flex-1 px-4 sm:px-6 lg:px-8 pt-10 pb-24 sm:pb-10">
            <DocsBreadcrumb />
            <DocsPageActions />
            <article
              className="docs-article prose prose-zinc dark:prose-invert max-w-3xl"
            >
              {children}
            </article>
          </main>
          <DocsTOC />
        </div>
      </div>
    </DocsSessionProvider>
  );
}
