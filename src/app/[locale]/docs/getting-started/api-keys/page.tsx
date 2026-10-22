import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import EnContent, { frontmatter as enFrontmatter } from './en.mdx';
import ZhContent, { frontmatter as zhFrontmatter } from './zh.mdx';
import DeContent, { frontmatter as deFrontmatter } from './de.mdx';
import { DocsTrustFooter } from '@/components/docs/DocsTrustFooter';

/**
 * 文档路由包装（结构与 scripts/docs-migration/generate-page-wrappers.mjs 生成的一致）。
 *
 * 渲染时按 locale 选用对应的 MDX；某语种尚无译文时，该语种的 MDX 是英文副本
 * （见 migrate.mjs §applyFallback）。
 *
 * 路径：src/app/[locale]/docs/getting-started/api-keys
 */
const SITE_URL = 'https://aster-lang.cloud';
const ROUTE_SLUG = '/docs/getting-started/api-keys';

type Props = {
  params: Promise<{ locale: string }>;
};

type Frontmatter = {
  title?: string;
  description?: string;
  /** 为 true 表示该语种的 MDX 是等待翻译的英文副本。 */
  fallback?: boolean;
};

const FRONTMATTER: Record<string, Frontmatter> = {
  en: enFrontmatter ?? {},
  zh: zhFrontmatter ?? {},
  de: deFrontmatter ?? {},
};

function localizedDocsUrl(locale: string): string {
  const prefix = locale === 'en' ? '' : `/${locale}`;
  return `${SITE_URL}${prefix}${ROUTE_SLUG}`;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const fm = FRONTMATTER[locale] ?? FRONTMATTER.en;

  // 英文副本（fallback）页面的 SEO：canonical 指向英文原页并设 noindex，
  // 避免搜索引擎在本地化 URL 下收录重复的英文内容。`fallback: true` 由
  // scripts/docs-migration/mark-fallbacks.mjs 维护。
  const isFallback = fm.fallback === true;
  const canonical = isFallback
    ? localizedDocsUrl('en')
    : localizedDocsUrl(locale);

  return {
    title: fm.title ? `${fm.title} · Aster Cloud Docs` : 'Aster Cloud Docs',
    description: fm.description,
    ...(isFallback && { robots: { index: false, follow: true } }),
    alternates: {
      canonical,
      languages: {
        en: localizedDocsUrl('en'),
        zh: localizedDocsUrl('zh'),
        de: localizedDocsUrl('de'),
        'x-default': localizedDocsUrl('en'),
      },
    },
  };
}

export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const fm = FRONTMATTER[locale] ?? FRONTMATTER.en;
  // 每个文档页都渲染可信页脚（最近更新 / API 版本 / 变更日志链接 / 建议修改）。
  // 页脚读取 MDX frontmatter，新增字段只需改 .mdx 本身，无需改构建配置。
  const footer = (
    <DocsTrustFooter frontmatter={fm} routeSlug={ROUTE_SLUG} locale={locale} />
  );
  if (locale === 'zh') return <><ZhContent />{footer}</>;
  if (locale === 'de') return <><DeContent />{footer}</>;
  if (locale === 'en') return <><EnContent />{footer}</>;
  notFound();
}
