import type { MDXComponents } from 'mdx/types';
import { Callout, CodeGroup } from '@/components/docs/mdx-callouts';
import { DocsCodeBlock } from '@/components/docs/DocsCodeBlock';
import { DocsTable } from '@/components/docs/DocsTable';
import { ActionableStep } from '@/components/docs/ActionableStep';
import { TranslationFallbackBanner } from '@/components/docs/TranslationFallbackBanner';

/**
 * Global MDX component overrides.
 *
 * Required by Next.js App Router MDX integration:
 * https://nextjs.org/docs/app/building-your-application/configuring/mdx
 *
 * Globally available inside any `.mdx` file:
 *   - <Callout type="info|tip|warning|danger|note" title="...">…</Callout>
 *   - <CodeGroup>…</CodeGroup>
 *
 * Default HTML elements (h1, p, ul, …) flow through unmodified;
 * styling comes from the `prose` Tailwind plugin applied in the docs
 * layout's <article>.
 */
export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    ...components,
    Callout,
    CodeGroup,
    // Phase 3 — every `<pre>` in MDX renders through DocsCodeBlock so
    // readers get a Copy button plus, when the fence opts in via
    // `{playground=true,id=…}`, an "Open in Playground" link.
    pre: DocsCodeBlock,
    // 宽表格放进可横向滚动的容器，避免移动端整页横向滚动（#774）
    table: DocsTable,
    // Phase 4 — numbered step card with optional in-product CTA.
    // Used in MDX quickstart pages so each step becomes a one-click
    // path into the relevant app surface.
    ActionableStep,
    TranslationFallbackBanner,
  };
}
