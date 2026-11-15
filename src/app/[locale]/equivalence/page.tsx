/**
 * 双引擎一致性公开页（/equivalence）。
 *
 * 面向评估者回答一个问题：Java 与 TypeScript 两个引擎对同一条规则是否给出同一结果、
 * 证据是否新鲜。信息按渐进披露排列：结论 → 三个比较维度 → 覆盖率 → 历史 → 分歧 → 方法。
 * 设计说明见 docs/superpowers/specs/2026-11-15-equivalence-page-redesign.md。
 *
 * 数据：服务端从 aster-lang-test 拉取五个 history CSV（ISR，每小时重新验证），
 * 由 summarizeParity 判定一致 / 分歧 / 过期 / 无数据。
 */
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Container } from '@/components/ui';
import { SkipToContent } from '@/components/skip-to-content';
import { PublicTopBar } from '@/components/marketing/public-top-bar';
import { AgreementCards, CoverageMeters, ParityVerdict } from '@/components/equivalence/parity-overview';
import { ParityHistoryChart, type HistorySeries } from '@/components/equivalence/parity-history-chart';
import { ParityDivergences } from '@/components/equivalence/parity-divergences';
import { ParityMethodology } from '@/components/equivalence/parity-methodology';
import { loadParity, rawFileUrl, HISTORY_FILES } from '@/lib/equivalence/fetch';
import { dedupeByDay } from '@/lib/equivalence/parity';

// 不能 force-static：JSON-LD 内联 <script> 必须带 middleware 设置的 per-request
// CSP nonce（strict-dynamic 下无 nonce 会被拦），读 headers() 自动转为动态渲染。
// 配 revalidate 仍享 ISR 缓存。
export const revalidate = 3600;

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'equivalencePage.seo' });
  return {
    title: t('title'),
    description: t('description'),
    alternates: { canonical: `/${locale}/equivalence` },
    openGraph: { title: t('title'), description: t('description'), type: 'website' },
  };
}

export default async function EquivalencePage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  const t = await getTranslations('equivalencePage');
  const tRoot = await getTranslations();

  const { history, summary } = await loadParity();

  const series: HistorySeries[] = [
    { key: 'parse', label: t('dimensions.parse.title'), tone: 'primary', points: dedupeByDay(history.parse) },
    { key: 'eval', label: t('dimensions.eval.title'), tone: 'sky', points: dedupeByDay(history.eval) },
    { key: 'ir', label: t('dimensions.ir.title'), tone: 'amber', points: dedupeByDay(history.ir) },
  ];

  const firstParse = history.parse[0]?.timestamp;
  const jsonLd =
    summary.verdict === 'empty'
      ? null
      : {
          '@context': 'https://schema.org',
          '@type': 'Dataset',
          name: 'Aster Lang dual-engine parity history',
          description:
            'Nightly comparison of the Java and TypeScript Aster Lang engines over the Tier 1 corpus at three layers: parse acceptance, runtime output on golden cases, and field-level Core IR. Published openly with eval and feature coverage and a ledger of resolved divergences.',
          url: rawFileUrl(HISTORY_FILES.parse),
          creator: { '@type': 'Organization', name: 'Aster Cloud' },
          license: 'https://opensource.org/license/mit',
          variableMeasured: [
            'parse parity (samples both engines accept / total Tier 1 parse samples)',
            'runtime eval parity (golden cases with identical output / total golden cases)',
            'Core IR parity (samples with field-identical normalized IR / total IR samples)',
          ],
          ...(firstParse ? { temporalCoverage: `${firstParse.slice(0, 10)}/..` } : {}),
        };

  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg">
      <SkipToContent targetId="main" />
      {jsonLd && (
        <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      )}
      <PublicTopBar brandLabel={tRoot('nav.brand')} signInLabel={tRoot('common.signIn')} />

      <main id="main" className="flex flex-col">
        <ParityVerdict summary={summary} locale={locale} />

        {summary.verdict !== 'empty' && (
          <>
            <AgreementCards summary={summary} locale={locale} />
            <CoverageMeters summary={summary} locale={locale} />

            <section className="border-t border-border py-14" aria-labelledby="parity-history">
              <Container size="wide" className="space-y-6">
                <div className="max-w-2xl space-y-2">
                  <h2 id="parity-history" className="font-display text-2xl font-semibold tracking-tight">
                    {t('history.heading')}
                  </h2>
                  <p className="text-sm leading-relaxed text-fg-muted">{t('history.intro')}</p>
                </div>
                <ParityHistoryChart
                  series={series}
                  locale={locale}
                  labels={{
                    rangeLabel: t('history.rangeLabel'),
                    ranges: { week: t('trend.range.week'), month: t('trend.range.month'), all: t('trend.range.all') },
                    summary: t.raw('history.summary') as string,
                    agreeOf: t.raw('history.agreeOf') as string,
                    divergedLegend: t('history.divergedLegend'),
                    tableToggle: t('history.tableToggle'),
                    colDate: t('history.colDate'),
                    empty: t('history.empty'),
                  }}
                />
              </Container>
            </section>

            <ParityDivergences summary={summary} />
          </>
        )}

        <ParityMethodology />
      </main>
    </div>
  );
}
