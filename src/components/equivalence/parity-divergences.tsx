/**
 * 分歧区：当前未解决的分歧（仅在最新运行有分歧时出现，链接到原始报告）
 * + 已解决分歧台账（公开「追踪→修复」闭环，是信任证据而不是隐藏历史）。
 */
import { getTranslations } from 'next-intl/server';
import { ArrowUpRight, Check } from 'lucide-react';
import { Card, CardBody, Container } from '@/components/ui';
import { AGREEMENT_DIMENSIONS, type ParitySummary } from '@/lib/equivalence/parity';
import { repoFileUrl } from '@/lib/equivalence/fetch';

/** 已解决分歧台账的一行（文案来自 equivalencePage.resolvedDivergences.rows）。 */
type ResolvedDivergence = { case: string; ts: string; java: string; resolution: string };

/** 每个维度出现分歧时，去哪里看受影响的具体样本。 */
const DIVERGENCE_SOURCES = [
  { key: 'reportLink', file: 'equivalence-report.json' },
  { key: 'manifestLink', file: 'DIVERGENT-MANIFEST.md' },
  { key: 'irLedgerLink', file: 'IR-DIVERGENCE-LEDGER.md' },
] as const;

export async function ParityDivergences({ summary }: { summary: ParitySummary }) {
  const t = await getTranslations('equivalencePage');
  const resolved = t.raw('resolvedDivergences.rows') as ResolvedDivergence[];
  const open = AGREEMENT_DIMENSIONS.map((d) => summary.agreement[d]).filter((s) => s.gap > 0);

  if (open.length === 0 && resolved.length === 0) return null;

  return (
    <section id="divergences" className="scroll-mt-8 border-t border-border py-14" aria-labelledby="parity-divergences">
      <Container size="wide" className="space-y-10">
        {open.length > 0 && (
          <Card className="border-danger">
            <CardBody className="space-y-4">
              <h2 id="parity-divergences" className="font-display text-2xl font-semibold tracking-tight text-danger">
                {t('divergences.openHeading')}
              </h2>
              <p className="max-w-2xl text-sm leading-relaxed text-fg-muted">{t('divergences.openIntro')}</p>
              <ul className="grid gap-2 sm:grid-cols-3">
                {open.map((s) => (
                  <li key={s.dimension} className="rounded-lg bg-danger-subtle px-4 py-3 text-sm">
                    <span className="font-semibold text-fg">{t(`dimensions.${s.dimension}.title`)}</span>
                    <span className="block text-danger">{t('dimensions.badgeDiverged', { count: s.gap })}</span>
                  </li>
                ))}
              </ul>
              <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
                {DIVERGENCE_SOURCES.map((src) => (
                  <li key={src.file}>
                    <a href={repoFileUrl(src.file)} className="inline-flex items-center gap-1 font-medium text-primary hover:text-primary-hover">
                      {t(`divergences.${src.key}`)}
                      <ArrowUpRight className="size-3.5" aria-hidden />
                    </a>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        {resolved.length > 0 && (
          <div className="space-y-6">
            <div className="max-w-2xl space-y-2">
              {open.length > 0 ? (
                <h3 className="font-display text-xl font-semibold tracking-tight">{t('divergences.resolvedHeading')}</h3>
              ) : (
                <h2 id="parity-divergences" className="font-display text-2xl font-semibold tracking-tight">
                  {t('divergences.resolvedHeading')}
                </h2>
              )}
              <p className="text-sm leading-relaxed text-fg-muted">{t('divergences.resolvedIntro')}</p>
            </div>
            <ul className="grid gap-4 md:grid-cols-3">
              {resolved.map((d) => (
                <li key={d.case}>
                  <Card className="h-full">
                    <CardBody className="flex h-full flex-col gap-4">
                      <p className="break-all font-mono text-sm font-semibold text-fg">{d.case}</p>
                      <div className="space-y-1">
                        <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{t('divergences.beforeLabel')}</p>
                        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-bg-subtle p-3 font-mono text-xs">
                          <dt className="text-fg-subtle">TS</dt>
                          <dd className="break-words text-fg">{d.ts}</dd>
                          <dt className="text-fg-subtle">Java</dt>
                          <dd className="break-words text-fg">{d.java}</dd>
                        </dl>
                      </div>
                      <p className="mt-auto flex items-start gap-2 text-sm text-fg-muted">
                        <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                        <span>
                          <span className="sr-only">{t('divergences.fixLabel')}: </span>
                          {d.resolution}
                        </span>
                      </p>
                    </CardBody>
                  </Card>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Container>
    </section>
  );
}
