/**
 * Demos 索引落地页（公开）。
 *
 * 把各独立 demo（SaaS 另含 guardian）聚合成一个卡片网格导航，作为统一入口。
 * landing footer 的单一「Demos」链接指向这里；各卡片进入对应 demo 子路由。
 */
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Card, CardBody, Container, Stack } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { IS_SAAS } from '@/lib/deployment-mode';

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'demosIndex.seo' });
  return {
    title: t('title'),
    description: t('description'),
    alternates: { canonical: `/${locale}/demos` },
    openGraph: { title: t('title'), description: t('description'), type: 'website' },
  };
}

/** demo 卡片元数据：href 指向子路由，文案走 i18n（demosIndex.cards.<key>）。 */
const DEMO_CARDS: ReadonlyArray<{ key: string; href: string; emoji: string }> = [
  ...(IS_SAAS ? [{ key: 'guardian', href: '/demos/guardian', emoji: '🛡️' }] : []),
  { key: 'credit', href: '/demos/credit', emoji: '📊' },
  { key: 'vocab', href: '/demos/vocab', emoji: '🏷️' },
  { key: 'kitten', href: '/demos/kitten', emoji: '🐱' },
  { key: 'poker', href: '/demos/poker', emoji: '🃏' },
  { key: 'poem', href: '/demos/poem', emoji: '📜' },
];

export default async function DemosIndexPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'demosIndex' });

  return (
    <main className="bg-bg">
      <Container className="py-12 sm:py-16">
        <Stack gap={2} className="mb-10 text-center">
          <p className="text-sm font-semibold uppercase tracking-wide text-primary">{t('eyebrow')}</p>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
            {t('title')}
          </h1>
          <p className="mx-auto max-w-2xl text-lg text-fg-muted">{t('subtitle')}</p>
        </Stack>

        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {DEMO_CARDS.map((card) => (
            <li key={card.key}>
              <Link href={card.href} className="block h-full focus:outline-none">
                <Card className="h-full transition-shadow hover:shadow-brand">
                  <CardBody className="flex h-full flex-col gap-3 pt-6">
                    <span className="text-3xl" aria-hidden>{card.emoji}</span>
                    <h2 className="font-display text-xl font-semibold tracking-tight text-fg">
                      {t(`cards.${card.key}.title`)}
                    </h2>
                    <p className="flex-1 text-sm text-fg-muted">{t(`cards.${card.key}.description`)}</p>
                    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-primary">
                      {t('enter')}
                      <span aria-hidden>→</span>
                    </span>
                  </CardBody>
                </Card>
              </Link>
            </li>
          ))}
          {/* 「原创歌词即源码」——中文专属彩蛋(《孤勇》原创词 + alias-literal 字面量宏 + LayoutMap)。文案内联,
              仅 zh locale 展示;非 zh 不列(歌词是中文的)。 */}
          {locale.toLowerCase().startsWith('zh') && (
            <li key="guyong">
              <Link href="/demos/guyong" className="block h-full focus:outline-none">
                <Card className="h-full transition-shadow hover:shadow-brand">
                  <CardBody className="flex h-full flex-col gap-3 pt-6">
                    <span className="text-3xl" aria-hidden>🕯️</span>
                    <h2 className="font-display text-xl font-semibold tracking-tight text-fg">
                      原创歌词即源码
                    </h2>
                    <p className="flex-1 text-sm text-fg-muted">
                      一段原创押韵短诗即源码——切换末句触发词、运行，引擎把它就地展开成一句押韵主题句；
                      LayoutMap 让源码读成工整短诗、编译带空格规范源码。
                    </p>
                    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-primary">
                      {t('enter')}
                      <span aria-hidden>→</span>
                    </span>
                  </CardBody>
                </Card>
              </Link>
            </li>
          )}
        </ul>
      </Container>
    </main>
  );
}
