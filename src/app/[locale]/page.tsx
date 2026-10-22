/**
 * Landing page — public marketing surface.
 *
 * W2.2 rewrite goals:
 *   - Token-driven (no raw indigo/purple/blue utilities)
 *   - Fraunces for display headings, Inter for body
 *   - Composed from @/components/ui primitives so the visual identity
 *     stays locked to the design system
 *   - All i18n keys, plan logic, Stripe currency mapping preserved
 *
 * Structure (unchanged from W1.5):
 *   1. Fixed nav (wordmark + lang switcher + sign-in + CTA)
 *   2. Hero (display headline + sub + CTA)
 *   3. Features grid (6 cards, semantic-colored icon tiles)
 *   4. Pricing preview (3-tier, Pro highlighted)
 *   5. Bottom CTA (full-bleed violet section)
 *   6. Footer
 *
 * The 6 feature icon tiles use *semantic role* colors instead of the
 * old rainbow indigo/green/purple/yellow/red/blue palette. The intent
 * stays the same (visual variety so cards don't read as a uniform
 * block) but every tile pulls from the token system — replacing the
 * brand later is then a token edit, not a 6× color find-replace.
 */
import { useTranslations } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { guardianTryItUrl } from '@/lib/guardian-embed';
import { IS_SAAS } from '@/lib/deployment-mode';
import {
  Languages,
  ShieldCheck,
  Sparkles,
  Zap,
  GlobeLock,
  Server,
  Check,
  Cpu,
  FileLock,
  GlobeIcon,
} from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { LanguageSwitcher } from '@/components/language-switcher';
import { HeroLocalesLine } from '@/components/landing/hero-locales-line';
import { SkipToContent } from '@/components/skip-to-content';
import { locales, localeNames, type Locale } from '@/i18n/config';
import {
  buttonVariants,
  Card,
  CardHeader,
  CardBody,
  Container,
  Stack,
  Wordmark,
  cn,
} from '@/components/ui';
import { CnlDemo } from '@/components/marketing/cnl-demo';
import { GuardianEmbed } from '@/components/marketing/guardian-embed';
import {
  getCurrencyForLocale,
  formatPrice,
  getProPrice,
  PLANS,
  PLAN_FEATURE_MESSAGE_VALUES,
} from '@/lib/plans';

type Props = {
  params: Promise<{ locale: string }>;
};

export default async function Home({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <HomeContent locale={locale} />;
}

function HomeContent({
  locale,
}: {
  locale: string;
}) {
  const t = useTranslations();
  const currency = getCurrencyForLocale(locale);
  const proMonthlyPrice = formatPrice(getProPrice(currency, 'monthly'), currency);

  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg">
      <SkipToContent targetId="main" />
      <Nav t={t} />
      <main id="main" className="flex flex-col">
        <Hero t={t} locale={locale} />
        <TrustBand t={t} />
        <Features t={t} />
        {/* AI Guardian 演示嵌入 aster-lang.dev 的剧情，仅 SaaS 渲染（CSP frame-src 同样只在该来源放行）。 */}
        {IS_SAAS && <GuardianShowcase t={t} locale={locale} />}
        {/* Pricing preview 是 SaaS 三档定价表（Free/Pro/Enterprise）。
            On-prem 客户的"定价"是 license 协商，公开三档表会误导。
            IS_SAAS = false 时 terser DCE 这个分支 + PricingPreview 子树。 */}
        {IS_SAAS && (
          <PricingPreview
            t={t}
            currency={currency}
            proMonthlyPrice={proMonthlyPrice}
          />
        )}
        <BottomCta t={t} />
      </main>
      <Footer t={t} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

function Nav({
  t,
}: {
  t: ReturnType<typeof useTranslations>;
}) {
  // Public landing nav — evaluator-grade. Three rows of links exist
  // in the IA proposal (Product, Pricing, Docs, Blog, Sign in,
  // Start free trial). We surface the destinations that have real
  // landing pages today: Pricing (SaaS only) and Docs (internal
  // /docs subsite). "Product" / "Security" / "Blog" placeholders are
  // deferred until those pages exist — a dead link is worse for an
  // evaluator than a missing one.
  //
  // Internal destinations use next-intl's <Link /> so the locale
  // prefix (zh/de) is automatically attached.
  return (
    <nav
      className={cn(
        'fixed inset-x-0 top-0 z-20',
        'border-b border-border bg-bg/80 backdrop-blur-md',
      )}
    >
      <Container size="xl">
        <div className="flex h-16 items-center justify-between">
          {/* Brand: hex-framed Aster mark + "Aster Cloud" wordmark.
              On sub-640px viewports the wordmark hides, leaving the
              icon alone — keeps the nav from wrapping when the
              middle nav links + right CTA cluster competes for room. */}
          <Link
            href="/"
            aria-label={t('nav.brand')}
            className="flex items-center gap-2"
          >
            {/* SVG vector — next/image's raster pipeline would either
                rasterize it (losing crispness) or require unoptimized
                config; a plain <img> renders the file as-is at the
                browser's vector resolution. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo.svg"
              alt=""
              aria-hidden
              className="h-8 w-8 shrink-0"
            />
            <span className="hidden sm:inline">
              <Wordmark variant="product" size="md" />
            </span>
          </Link>
          <Stack direction="row" gap={6} align="center">
            {/* Primary evaluator links — middle of the bar, separated
                from sign-in / CTA on the right so the visual weight
                stays on the trial CTA.
                Pricing is an in-page anchor (#pricing) so the click
                smooth-scrolls to the PricingPreview section already
                rendered on the home page rather than a full route
                change. The dedicated /pricing route remains for SEO
                and direct linking. */}
            <Stack direction="row" gap={4} align="center" className="hidden md:flex">
              {IS_SAAS && (
                <a
                  href="#pricing"
                  className="text-sm font-medium text-fg-muted transition-colors hover:text-fg"
                >
                  {t('nav.pricing')}
                </a>
              )}
              <Link
                href="/docs"
                className="text-sm font-medium text-fg-muted transition-colors hover:text-fg"
              >
                {t('nav.docs')}
              </Link>
            </Stack>
            <Stack direction="row" gap={4} align="center">
              {/* 公开 landing 无团队上下文；平台真相来自编译集 ∩ 后端 lexicon 注册表。 */}
              <LanguageSwitcher allowedLocales={null} />
              <Link
                href="/login"
                className="text-sm font-medium text-fg-muted transition-colors hover:text-fg"
              >
                {t('common.signIn')}
              </Link>
              {/* Link rendered with Button visuals via buttonVariants().
                  We don't use Button-wraps-Link because that nests
                  interactive elements (invalid HTML + a11y violation). */}
              <MarketingPrimaryCta
                saasLabel={t('common.startFreeTrial')}
                onPremLabel={t('common.contactSales')}
                variant="primary"
                size="md"
              />
            </Stack>
          </Stack>
        </div>
      </Container>
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/* Hero                                                                */
/* ------------------------------------------------------------------ */

function Hero({
  t,
  locale,
}: {
  t: ReturnType<typeof useTranslations>;
  locale: string;
}) {
  // Subtitle lists the *available* native locale names rather than a
  // hard-coded "English / 中文 / Deutsch" string. The locale set is the
  // single source of truth in i18n/config.ts — adding a language pack
  // there automatically surfaces it in the hero. Current locale leads
  // the list so users see their own language first.
  const orderedLocales: Locale[] = locales.includes(locale as Locale)
    ? [
        locale as Locale,
        ...locales.filter((l) => l !== locale),
      ]
    : [...locales];
  const localesLabel = orderedLocales.map((l) => localeNames[l]).join(' / ');

  return (
    <section className="relative overflow-hidden pt-32 pb-24">
      {/* Decorative gradient — kept very subtle so it doesn't fight the
          editorial weight of the Fraunces headline. */}
      <div
        aria-hidden
        className={cn(
          'absolute inset-x-0 top-0 -z-10 h-[40rem]',
          'bg-[radial-gradient(ellipse_60%_50%_at_50%_0%,var(--aster-color-violet-100),transparent_60%)]',
        )}
      />
      <Container size="xl">
        <Stack gap={6} align="center" className="text-center">
          {/* Fluid font-size keeps `hero.title` on a single line at every
              viewport width.
              Why clamp() instead of step breakpoints (text-4xl/5xl/6xl
              /7xl): the longest localized title is German's "Policy as
              Code in der Muttersprache" at 35 chars (incl. spaces).
              At Fraunces semibold tracking-tighter the average glyph
              width is ~0.422em (measured live, including the spaces),
              so the line is ~14.77em wide. To fit inside the viewport
              with the section's 24px side padding, font-size must
              satisfy `14.77em ≤ viewport_px - 48`, i.e. font-size
              ≤ (viewport_px - 48) / 14.77.
              Coefficient 5.5vw (= 100/14.77 × 0.81 safety factor)
              gives ~19% headroom against font-loading FOUT, OS-level
              text inflation, and rounding.
              Floor 1.125rem (18px) keeps the headline readable on
              320px phones — at that viewport 5.5vw drops to 17.6px,
              so the floor lifts it to 18px and the text still fits
              (18 × 14.77 = 266px < 272px container).
              Ceiling 4.75rem (76px) caps growth on >1380px viewports
              so the headline doesn't dominate desktop layouts.
              whitespace-nowrap is a belt-and-suspenders guarantee: if
              a future translation is longer than DE, the title may
              overflow the container instead of wrapping (loud, easy
              to spot in a screenshot), rather than silently breaking
              the visual cadence by going multi-line. */}
          <h1
            className={cn(
              'font-display font-semibold tracking-tighter text-fg',
              // 收敛后的 title 较长（价值主张句而非短标语），允许自然折行——
              // 不再用 whitespace-nowrap，否则长句会被 clamp 压成过小字号或溢出。
              'text-balance leading-[1.1] text-[clamp(1.75rem,4.5vw,3.75rem)]',
            )}
          >
            {t('hero.title')}
            {/* Native-locale list rendered as its own line — keeps the
                main title weight clean and lets the gradient highlight
                read as a separate "available languages" stamp under it.
                Inherits the fluid font-size from the parent so the two
                lines stay in proportion.

                ★动态化★：这行原本硬编码成 compiled 全集，管理员在后端禁用
                某语言后不会变。改为 <HeroLocalesLine>（client 子组件）按
                compiled∩backend 实时收敛——与 landing 语言切换器同口径。
                hero.titleHighlight 的值就是占位符 {locales}，所以服务端算好的
                localesLabel（compiled 全集）正是首屏 / 无 JS 的标签，hydrate
                后再按后端可用性收敛。fail-open：后端探测失败时退回全集。 */}
            <HeroLocalesLine serverLabel={localesLabel} locale={locale} />
          </h1>
          <p className="max-w-2xl text-lg leading-relaxed text-fg-muted sm:text-xl">
            {t('hero.description')}
          </p>
          <p className="max-w-2xl text-sm text-fg-subtle">
            <a
              href="https://aster-lang.dev"
              className="underline-offset-2 hover:text-fg hover:underline"
            >
              {t('hero.builtOnAsterLang')}
            </a>
          </p>
          {/* No hero CTA — the same "Start free" / "Contact sales" CTA
              already lives in the top nav (Nav → MarketingPrimaryCta).
              Duplicating it here put two identical primary buttons within
              ~200px of each other on first paint, which read as visual
              noise rather than reinforcement. The nav CTA stays sticky
              as the user scrolls, so removing the hero copy doesn't
              hurt conversion paths; the source-link + tagline still
              carry the editorial weight of the hero. The "no credit
              card required" footnote went with it since it only made
              sense as a CTA modifier. */}

          {/* Live CNL demo — typewriter cycles three real, compilable
              snippets. The whole pitch of Aster is "policies written by
              humans, run as code" — show it, don't just say it.
              mt-10 adds breathing room above the demo block so the dark
              terminal window reads as its own beat below the hero copy,
              not as the next inline item in the Stack. */}
          <div className="mt-10 w-full">
            <CnlDemo />
          </div>
          {/* Handoff to the interactive credit-risk demo — the snippet
              above shows the rule; the demo lets you replay a real
              decision (the killer story for the credit-risk beachhead). */}
          <Link
            href="/demos/credit"
            className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary-hover"
          >
            {t('hero.tryDemo')}
            <span aria-hidden>→</span>
          </Link>
        </Stack>
      </Container>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Trust band                                                          */
/* ------------------------------------------------------------------ */

/**
 * 3-column strip directly under the hero that anchors the page on
 * *real* product facts. The fact that we don't have customer logos yet
 * is OK — what we DO have is unusual in policy-DSL space (GraalVM
 * compilation, hash-chain audit, native trilingual support) and that's
 * what the band advertises.
 *
 * The 3 items map 1:1 to keys under `trust.items` in messages/*.json so
 * copy edits are i18n-driven, no hard-coded English.
 */
function TrustBand({ t }: { t: ReturnType<typeof useTranslations> }) {
  const items = [
    { icon: Cpu,       key: 'compiled'  },
    { icon: FileLock,  key: 'audited'   },
    { icon: GlobeIcon, key: 'multilang' },
  ] as const;

  return (
    <section className="border-y border-border bg-bg-subtle py-14">
      <Container size="xl">
        <Stack gap={8}>
          <p className="text-center font-sans text-xs font-semibold uppercase tracking-widest text-primary">
            {t('trust.eyebrow')}
          </p>
          <div className="grid gap-8 sm:grid-cols-3 sm:gap-10">
            {items.map(({ icon: Icon, key }) => (
              <Stack key={key} gap={3} align="center" className="text-center">
                <span
                  aria-hidden
                  className="flex size-11 items-center justify-center rounded-lg bg-primary-subtle text-primary"
                >
                  <Icon className="size-5" />
                </span>
                <h3 className="font-display text-lg font-semibold tracking-tight text-fg">
                  {t(`trust.items.${key}.title`)}
                </h3>
                <p className="text-sm leading-relaxed text-fg-muted">
                  {t(`trust.items.${key}.description`)}
                </p>
              </Stack>
            ))}
          </div>
        </Stack>
      </Container>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Features                                                            */
/* ------------------------------------------------------------------ */

type FeatureTone = 'primary' | 'success' | 'accent' | 'warning' | 'danger' | 'neutral';

interface FeatureDef {
  icon: React.ComponentType<{ className?: string }>;
  tone: FeatureTone;
  titleKey: string;
  descKey: string;
}

/** Tone → tailwind utility map. Centralized so the rainbow stays
 *  on-brand: every shade is a token, no raw hex/utility values. */
const TONE_BG: Record<FeatureTone, string> = {
  primary: 'bg-primary-subtle text-primary',
  success: 'bg-success-subtle text-success',
  accent:  'bg-accent-subtle text-accent',
  warning: 'bg-warning-subtle text-warning',
  danger:  'bg-danger-subtle text-danger',
  neutral: 'bg-bg-muted text-fg-muted',
};

const FEATURES: readonly FeatureDef[] = [
  { icon: Languages,   tone: 'primary', titleKey: 'features.nativeLanguage.title',     descKey: 'features.nativeLanguage.description' },
  { icon: Sparkles,    tone: 'accent',  titleKey: 'features.aiDraftHumanReview.title', descKey: 'features.aiDraftHumanReview.description' },
  { icon: ShieldCheck, tone: 'success', titleKey: 'features.hashChainAudit.title',     descKey: 'features.hashChainAudit.description' },
  { icon: Zap,         tone: 'warning', titleKey: 'features.dualEngineSemantics.title', descKey: 'features.dualEngineSemantics.description' },
  { icon: GlobeLock,   tone: 'danger',  titleKey: 'features.multiLanguagePacks.title', descKey: 'features.multiLanguagePacks.description' },
  { icon: Server,      tone: 'neutral', titleKey: 'features.selfHostable.title',       descKey: 'features.selfHostable.description' },
] as const;

function Features({ t }: { t: ReturnType<typeof useTranslations> }) {
  return (
    <section className="bg-bg-subtle py-20">
      <Container size="xl">
        <Stack gap={12} align="center">
          <h2 className="font-display text-4xl font-semibold tracking-tight text-fg text-center">
            {t('features.title')}
          </h2>
          <div className="grid w-full gap-6 md:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, tone, titleKey, descKey }) => (
              <Card key={titleKey} className="transition-shadow duration-medium ease-standard hover:shadow-md">
                <CardBody className="pt-6">
                  <Stack gap={4}>
                    <div className={cn(
                      'flex size-12 items-center justify-center rounded-lg',
                      TONE_BG[tone],
                    )}>
                      <Icon className="size-6" aria-hidden />
                    </div>
                    <Stack gap={2}>
                      <h3 className="font-display text-xl font-semibold tracking-tight text-fg">
                        {t(titleKey)}
                      </h3>
                      <p className="text-sm leading-relaxed text-fg-muted">
                        {t(descKey)}
                      </p>
                    </Stack>
                  </Stack>
                </CardBody>
              </Card>
            ))}
          </div>
        </Stack>
      </Container>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* AI Guardian showcase                                                */
/* ------------------------------------------------------------------ */

function GuardianShowcase({ t, locale }: { t: ReturnType<typeof useTranslations>; locale: string }) {
  return (
    <section className="py-20">
      <Container size="xl">
        <Stack gap={8} align="center">
          <Stack gap={2} align="center" className="text-center">
            <p className="text-sm font-semibold uppercase tracking-wide text-primary">
              {t('guardianShowcase.eyebrow')}
            </p>
            <h2 className="font-display text-4xl font-semibold tracking-tight text-fg">
              {t('guardianShowcase.title')}
            </h2>
            <p className="max-w-2xl text-lg text-fg-muted">{t('guardianShowcase.subtitle')}</p>
          </Stack>
          <div className="w-full max-w-4xl">
            <GuardianEmbed locale={locale} posterAlt={t('guardianShowcase.posterAlt')} />
          </div>
          <a
            href={guardianTryItUrl(locale)}
            className="text-sm font-medium text-primary hover:underline"
          >
            {t('guardianShowcase.tryIt')}
          </a>
        </Stack>
      </Container>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Pricing preview                                                     */
/* ------------------------------------------------------------------ */

function PricingPreview({
  t, currency, proMonthlyPrice,
}: {
  t: ReturnType<typeof useTranslations>;
  currency: ReturnType<typeof getCurrencyForLocale>;
  proMonthlyPrice: string;
}) {
  return (
    // id="pricing" is the anchor target for the nav's Pricing link —
    // clicking the nav scrolls the landing page to this section
    // (smooth-scroll behaviour comes from CSS, see globals.css). The
    // dedicated /pricing route still exists for direct linking and SEO.
    <section id="pricing" className="scroll-mt-20 py-20">
      <Container size="xl">
        <Stack gap={12} align="center">
          <Stack gap={3} align="center" className="text-center">
            <h2 className="font-display text-4xl font-semibold tracking-tight text-fg">
              {t('pricing.title')}
            </h2>
            <p className="max-w-xl text-fg-muted">{t('pricing.subtitle')}</p>
          </Stack>
          <div className="grid w-full max-w-5xl gap-6 md:grid-cols-3">
            {/* Free */}
            <PricingCard
              t={t}
              label={t('billing.plans.names.free')}
              price={formatPrice(0, currency)}
              perMonthLabel={t('pricing.perMonth')}
              features={PLANS.free.featureKeys}
              cta={{ href: '/signup', label: t('common.getStarted'), variant: 'outline' }}
            />
            {/* Pro — highlighted */}
            <PricingCard
              t={t}
              label={t('billing.plans.names.pro')}
              price={proMonthlyPrice}
              perMonthLabel={t('pricing.perMonth')}
              features={PLANS.pro.featureKeys}
              cta={{ href: '/signup', label: t('common.startFreeTrial'), variant: 'primary' }}
              highlight={t('billing.mostPopular')}
            />
            {/* Enterprise */}
            <PricingCard
              t={t}
              label={t('billing.plans.names.enterprise')}
              price={t('common.contactSales')}
              priceIsLabel
              features={PLANS.enterprise.featureKeys}
              cta={{ href: 'mailto:sales@aster-lang.cloud', label: t('common.contactSales'), variant: 'outline', external: true }}
            />
          </div>
        </Stack>
      </Container>
    </section>
  );
}

interface PricingCardProps {
  t: ReturnType<typeof useTranslations>;
  label: string;
  price: string;
  perMonthLabel?: string;
  /** When true, render the price slot as a single label instead of "price + /month". */
  priceIsLabel?: boolean;
  features: readonly string[];
  highlight?: string;
  cta: {
    href: string;
    label: string;
    variant: 'primary' | 'outline';
    external?: boolean;
  };
}

function PricingCard({
  t, label, price, perMonthLabel, priceIsLabel,
  features, highlight, cta,
}: PricingCardProps) {
  return (
    <Card className={cn(
      'relative flex flex-col',
      highlight && 'border-2 border-primary shadow-lg shadow-primary/10',
    )}>
      {highlight && (
        <span className={cn(
          'absolute -top-3 left-1/2 -translate-x-1/2',
          'rounded-full bg-primary text-primary-fg',
          'px-3 py-1 text-xs font-semibold',
        )}>
          {highlight}
        </span>
      )}
      <CardHeader>
        <p className="text-sm font-semibold uppercase tracking-wide text-fg-muted">
          {label}
        </p>
        {priceIsLabel ? (
          <p className="font-display text-2xl font-semibold tracking-tight text-fg">
            {price}
          </p>
        ) : (
          <p className="flex items-baseline gap-1">
            <span className="font-display text-4xl font-semibold tracking-tight text-fg">
              {price}
            </span>
            {perMonthLabel && (
              <span className="text-sm text-fg-muted">{perMonthLabel}</span>
            )}
          </p>
        )}
      </CardHeader>
      <CardBody className="flex flex-1 flex-col gap-6">
        <ul className="space-y-3 text-sm text-fg-muted">
          {features.map((featureKey) => (
            <li key={featureKey} className="flex items-start gap-2">
              <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
              <span>{t(`billing.plans.features.${featureKey}`, PLAN_FEATURE_MESSAGE_VALUES)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-auto pt-2">
          {cta.external ? (
            <a
              href={cta.href}
              className={buttonVariants({ variant: cta.variant, size: 'md', className: 'w-full' })}
            >
              {cta.label}
            </a>
          ) : (
            <Link
              href={cta.href}
              className={buttonVariants({ variant: cta.variant, size: 'md', className: 'w-full' })}
            >
              {cta.label}
            </Link>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Bottom CTA                                                          */
/* ------------------------------------------------------------------ */

function BottomCta({ t }: { t: ReturnType<typeof useTranslations> }) {
  return (
    <section className="relative overflow-hidden bg-primary py-20 text-primary-fg">
      {/* Subtle radial highlight to keep the dense violet from feeling flat. */}
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(ellipse_60%_60%_at_50%_50%,rgb(255_255_255/0.08),transparent_70%)]"
      />
      <Container size="base" className="relative">
        <Stack gap={6} align="center" className="text-center">
          <h2 className="font-display text-4xl font-semibold tracking-tight">
            {t('cta.title')}
          </h2>
          <p className="max-w-xl text-lg leading-relaxed text-violet-100">
            {t('cta.description')}
          </p>
          <MarketingPrimaryCta
            saasLabel={t('common.startFreeTrial')}
            onPremLabel={t('common.contactSales')}
            variant="secondary"
            size="lg"
          />
        </Stack>
      </Container>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Footer                                                              */
/* ------------------------------------------------------------------ */

function Footer({ t }: { t: ReturnType<typeof useTranslations> }) {
  return (
    <footer className="mt-auto bg-zinc-900 py-12 text-zinc-400">
      <Container size="xl">
        <Stack gap={8}>
          <Stack direction="row" justify="between" align="center" wrap gap={6}>
            {/* @aster-cloud/ui@0.2.0 added `tone="inverted"` for exactly
                this case (hand-painted dark surface that doesn't follow
                the theme token cascade). Drops the previous inline
                two-span workaround in favor of the canonical primitive. */}
            <Wordmark variant="product" size="md" tone="inverted" />
            <Stack direction="row" gap={6} wrap>
              <FooterLink href="/privacy">{t('footer.privacy')}</FooterLink>
              <FooterLink href="/terms">{t('footer.terms')}</FooterLink>
              <FooterLink href="/demos">{t('footer.demos')}</FooterLink>
              <FooterLink href="/equivalence">{t('footer.equivalence')}</FooterLink>
              <FooterLink href="/equivalence/whitepaper">{t('footer.whitepaper')}</FooterLink>
              <FooterLink href="https://aster-lang.dev/" external>
                {t('footer.documentation')}
              </FooterLink>
              <FooterLink href="mailto:support@aster-lang.cloud" external>
                {t('footer.support')}
              </FooterLink>
            </Stack>
          </Stack>
          <p className="text-center text-xs text-zinc-500">
            © {new Date().getFullYear()} {t('nav.brand')}. {t('footer.copyright')}
          </p>
        </Stack>
      </Container>
    </footer>
  );
}

/**
 * Marketing primary CTA — SaaS: 跳 /signup 自助注册；on-prem: mailto sales。
 *
 * 编译期常量 IS_SAAS 决定渲染哪个分支（terser DCE 一个分支）。在 marketing
 * 上下文，"开始使用" 在 SaaS 和 on-prem 是不同的转化路径：SaaS 注册即用，
 * on-prem 需销售对接 license。共用同一组件让所有 CTA 行为保持一致。
 */
function MarketingPrimaryCta({
  saasLabel,
  onPremLabel,
  variant,
  size,
}: {
  saasLabel: string;
  onPremLabel: string;
  variant: 'primary' | 'secondary' | 'outline';
  size: 'sm' | 'md' | 'lg';
}) {
  if (IS_SAAS) {
    return (
      <Link href="/signup" className={buttonVariants({ variant, size })}>
        {saasLabel}
      </Link>
    );
  }
  return (
    <a
      href="mailto:sales@aster-lang.cloud"
      className={buttonVariants({ variant, size })}
    >
      {onPremLabel}
    </a>
  );
}

function FooterLink({
  href, external, children,
}: { href: string; external?: boolean; children: React.ReactNode }) {
  const className = 'text-sm transition-colors hover:text-white';
  return external ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {children}
    </a>
  ) : (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
