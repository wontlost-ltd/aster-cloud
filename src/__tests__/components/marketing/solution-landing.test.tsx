/**
 * 需求验证落地页：四页都能用真实 en 文案渲染（没有缺键回退成 key 路径），
 * 「现已可用」与「开发中 / 试点」分栏，CTA 指向表单，表单默认勾选本页用例。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import enPackage from '@aster-cloud/ui-messages/en-US.json';
import { deepMergeMessages } from '@/i18n/request';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';

const messages = deepMergeMessages(enPackage as Record<string, unknown>, DEMO_SUPPLEMENT.en);

vi.mock('next-intl/server', () => ({
  getTranslations: async (arg?: string | { namespace?: string }) => {
    const namespace = typeof arg === 'string' ? arg : arg?.namespace;
    return createTranslator({ locale: 'en', messages, namespace: namespace as never });
  },
  getRequestConfig: (fn: unknown) => fn,
}));
vi.mock('@/components/language-switcher', () => ({ LanguageSwitcher: () => null }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/lib/product-events/client', () => ({ trackProductEvent: vi.fn() }));

import { SolutionLanding } from '@/components/marketing/solutions/solution-landing';
import { SOLUTION_CONTENT } from '@/components/marketing/solutions/content';
import { SOLUTION_PAGES, SOLUTION_SLUGS } from '@/lib/solutions';

async function renderPage(slug: (typeof SOLUTION_SLUGS)[number]) {
  const ui = await SolutionLanding({ slug, locale: 'en' });
  return render(<NextIntlClientProvider locale="en" messages={messages}>{ui}</NextIntlClientProvider>);
}

describe('SolutionLanding', () => {
  it.each(SOLUTION_SLUGS)('%s：文案齐全、分栏、CTA 与默认用例', async (slug) => {
    const { container } = await renderPage(slug);
    // 缺键时 next-intl 会回退成 "solutionsPage.xxx" 这样的路径
    expect(container.textContent).not.toMatch(/solutionsPage\.|pages\.[a-zA-Z]+\./);

    expect(screen.getByRole('heading', { level: 1 }).textContent?.length).toBeGreaterThan(20);
    const cta = screen.getAllByRole('link', { name: /Apply for a pilot/ })[0];
    expect(cta.getAttribute('href')).toBe('#apply');

    const content = SOLUTION_CONTENT[slug];
    const available = screen.getByRole('heading', { name: 'Available today' }).closest('div')!;
    expect(within(available.parentElement!).getAllByRole('listitem')).toHaveLength(content.available.length);
    expect(screen.getByText('Pilot')).toBeTruthy();
    for (const fact of content.facts) {
      expect(container.querySelector(`a[href="${fact.href}"]`)).not.toBeNull();
    }

    const checked = screen.getAllByRole('checkbox').filter((c) => (c as HTMLInputElement).checked);
    expect(checked).toHaveLength(1);
    expect(checked[0].closest('label')?.textContent).toBe(
      (messages as { solutionsPage: { form: { useCases: Record<string, string> } } }).solutionsPage.form.useCases[SOLUTION_PAGES[slug]],
    );
  });

  it('智能体护栏页：定位为 Cedar 运行时上游，并说明 Cedar 导出只支持部分规则', async () => {
    const { container } = await renderPage('agent-guardrails');
    expect(screen.getByRole('heading', { name: /Upstream of Cedar runtimes/ })).toBeTruthy();
    expect(container.textContent).toMatch(/Cedar export covers only a subset of rules/);
  });

  it('标题与 SEO 文案写成试点目标，不把开发中能力说成已交付结果（四语）', () => {
    const PILOT = { en: /^Pilot:/, zh: /^试点：/, de: /^Pilot:/, hi: /^पायलट:/ } as const;
    for (const loc of ['en', 'zh', 'de', 'hi'] as const) {
      const pages = (DEMO_SUPPLEMENT[loc] as { solutionsPage: { pages: Record<string, Record<string, string>> } })
        .solutionsPage.pages;
      for (const page of Object.values(pages)) {
        expect(page.title).toMatch(PILOT[loc]);
        expect(page.seoTitle).toMatch(PILOT[loc]);
      }
    }
    const en = DEMO_SUPPLEMENT.en as { solutionsPage: { pages: Record<string, Record<string, string>> } };
    for (const page of Object.values(en.solutionsPage.pages)) {
      const headline = [page.title, page.seoTitle, page.seoDescription, page.subtitle].join(' ');
      expect(headline).not.toMatch(/match the filing|find out quickly|traceable|reproduc/i);
    }
  });
});
