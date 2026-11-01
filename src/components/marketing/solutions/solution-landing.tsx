/**
 * 需求验证落地页（/solutions/*）共用版式：与首页 / 定价页同一套设计 token 与 UI 原语
 * （Fraunces 标题、Container / Stack / Card、primary 色调），不进主导航，只供直链分发。
 *
 * 每页一个具体承诺；「现已可用」与「开发中 / 试点」分开列，后者带徽章，避免承诺尚未实现的能力。
 */
import { getTranslations } from 'next-intl/server';
import { ArrowRight, Check, FlaskConical } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { LanguageSwitcher } from '@/components/language-switcher';
import { SkipToContent } from '@/components/skip-to-content';
import { Badge, Card, CardBody, Container, Stack, Wordmark, buttonVariants, cn } from '@/components/ui';
import { SOLUTION_PAGES, type SolutionSlug } from '@/lib/solutions';
import { SOLUTION_CONTENT } from './content';
import { LandingViewTracker } from './landing-view-tracker';
import { PilotApplicationForm } from './pilot-application-form';

const FORM_ANCHOR = 'apply';

export async function SolutionLanding({ slug, locale }: { slug: SolutionSlug; locale: string }) {
  const content = SOLUTION_CONTENT[slug];
  const t = await getTranslations('solutionsPage');
  const tRoot = await getTranslations();
  const p = (key: string) => t(`pages.${content.messageKey}.${key}`);

  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg">
      <SkipToContent targetId="main" />
      <LandingViewTracker page={slug} locale={locale} />

      <header className="border-b border-border bg-bg/80 backdrop-blur-md">
        <Container size="xl">
          <div className="flex h-16 items-center justify-between gap-4">
            <Link href="/" aria-label={tRoot('nav.brand')} className="flex items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.svg" alt="" aria-hidden className="h-8 w-8 shrink-0" />
              <span className="hidden sm:inline">
                <Wordmark variant="product" size="md" />
              </span>
            </Link>
            <Stack direction="row" gap={4} align="center">
              <LanguageSwitcher allowedLocales={null} />
              <Link href="/login" className="text-sm font-medium text-fg-muted transition-colors hover:text-fg">
                {tRoot('common.signIn')}
              </Link>
            </Stack>
          </div>
        </Container>
      </header>

      <main id="main" className="flex flex-col">
        <section className="relative overflow-hidden pt-20 pb-16">
          <div
            aria-hidden
            className={cn(
              'absolute inset-x-0 top-0 -z-10 h-[32rem]',
              'bg-[radial-gradient(ellipse_60%_50%_at_50%_0%,var(--aster-color-violet-100),transparent_60%)]',
            )}
          />
          <Container size="base">
            <Stack gap={6} align="center" className="text-center">
              <p className="font-sans text-xs font-semibold uppercase tracking-widest text-primary">{p('eyebrow')}</p>
              <h1 className="text-balance font-display text-[clamp(1.75rem,4.5vw,3.25rem)] font-semibold leading-[1.1] tracking-tight text-fg">
                {p('title')}
              </h1>
              <p className="max-w-2xl text-lg leading-relaxed text-fg-muted">{p('subtitle')}</p>
              <a href={`#${FORM_ANCHOR}`} className={buttonVariants({ variant: 'primary', size: 'lg' })}>
                {t('cta')}
                <ArrowRight className="ml-1.5 size-4" aria-hidden />
              </a>
            </Stack>
          </Container>
        </section>

        <section className="border-y border-border bg-bg-subtle py-14" aria-labelledby="solution-context">
          <Container size="base">
            <Stack gap={6}>
              <h2 id="solution-context" className="font-display text-2xl font-semibold tracking-tight">{t('contextHeading')}</h2>
              <ul className="grid gap-4 sm:grid-cols-2">
                {content.facts.map((fact) => (
                  <li key={fact.id} className="rounded-lg border border-border bg-bg p-5">
                    <p className="text-sm leading-relaxed text-fg">{p(`facts.${fact.id}.text`)}</p>
                    <p className="mt-3 text-xs text-fg-subtle">
                      {t('sourceLabel')}{' '}
                      <a href={fact.href} rel="noopener noreferrer" target="_blank" className="underline underline-offset-2 hover:text-fg">
                        {p(`facts.${fact.id}.source`)}
                      </a>
                    </p>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-fg-subtle">{t('contextNote')}</p>
            </Stack>
          </Container>
        </section>

        {content.positioning && (
          <section className="py-14" aria-labelledby="solution-positioning">
            <Container size="base">
              <Card>
                <CardBody className="space-y-3">
                  <h2 id="solution-positioning" className="font-display text-xl font-semibold tracking-tight">{p('positioning.title')}</h2>
                  <p className="text-sm leading-relaxed text-fg-muted">{p('positioning.body')}</p>
                </CardBody>
              </Card>
            </Container>
          </section>
        )}

        <section className="py-14" aria-labelledby="solution-capabilities">
          <Container size="base">
            <h2 id="solution-capabilities" className="sr-only">{t('capabilitiesHeading')}</h2>
            <div className="grid gap-6 md:grid-cols-2">
              <Card>
                <CardBody className="space-y-4">
                  <h3 className="font-display text-xl font-semibold tracking-tight">{t('availableHeading')}</h3>
                  <ul className="space-y-3 text-sm text-fg-muted">
                    {content.available.map((id) => (
                      <li key={id} className="flex items-start gap-2">
                        <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                        <span>{p(`available.${id}`)}</span>
                      </li>
                    ))}
                  </ul>
                  {content.demoHref && (
                    <Link href={content.demoHref} className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary-hover">
                      {p('demoLink')}
                      <span aria-hidden>→</span>
                    </Link>
                  )}
                </CardBody>
              </Card>
              <Card className="border-dashed">
                <CardBody className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-display text-xl font-semibold tracking-tight">{t('developmentHeading')}</h3>
                    <Badge variant="warning">{t('developmentBadge')}</Badge>
                  </div>
                  <ul className="space-y-3 text-sm text-fg-muted">
                    {content.development.map((id) => (
                      <li key={id} className="flex items-start gap-2">
                        <FlaskConical className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                        <span>{p(`development.${id}`)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs text-fg-subtle">{t('developmentNote')}</p>
                </CardBody>
              </Card>
            </div>
          </Container>
        </section>

        <section className="border-t border-border bg-bg-subtle py-14" aria-labelledby="solution-pilot">
          <Container size="base">
            <Stack gap={6}>
              <h2 id="solution-pilot" className="font-display text-2xl font-semibold tracking-tight">{t('pilot.heading')}</h2>
              <ol className="grid gap-4 md:grid-cols-3">
                {(['step1', 'step2', 'step3'] as const).map((step, i) => (
                  <li key={step} className="rounded-lg border border-border bg-bg p-5">
                    <p className="text-xs font-semibold text-primary">{i + 1}</p>
                    <h3 className="mt-1 font-display text-lg font-semibold tracking-tight">{t(`pilot.${step}Title`)}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-fg-muted">{t(`pilot.${step}Body`)}</p>
                  </li>
                ))}
              </ol>
            </Stack>
          </Container>
        </section>

        <section id={FORM_ANCHOR} className="scroll-mt-8 py-16" aria-labelledby="solution-apply">
          <Container size="narrow">
            <Card>
              <CardBody className="space-y-6">
                <div className="space-y-2">
                  <h2 id="solution-apply" className="font-display text-2xl font-semibold tracking-tight">{t('form.heading')}</h2>
                  <p className="text-sm text-fg-muted">{t('form.intro')}</p>
                </div>
                <PilotApplicationForm page={slug} locale={locale} defaultUseCase={SOLUTION_PAGES[slug]} />
              </CardBody>
            </Card>
          </Container>
        </section>
      </main>

      <footer className="border-t border-border py-8">
        <Container size="base">
          <p className="text-xs leading-relaxed text-fg-subtle">{t('disclaimer')}</p>
        </Container>
      </footer>
    </div>
  );
}

/** 各落地页 page.tsx 共用的 metadata：canonical 指向本语种 URL。 */
export async function solutionMetadata(slug: SolutionSlug, locale: string) {
  const t = await getTranslations({ locale, namespace: 'solutionsPage' });
  const key = SOLUTION_CONTENT[slug].messageKey;
  const title = t(`pages.${key}.seoTitle`);
  const description = t(`pages.${key}.seoDescription`);
  return {
    title,
    description,
    alternates: { canonical: `/${locale}/solutions/${slug}` },
    openGraph: { title, description, type: 'website' as const },
  };
}
