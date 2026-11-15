/**
 * 方法区：测量口径要点 + 原始数据（五个 history CSV）+ 白皮书入口。
 * 面向想自己核对数字的读者；所有链接指向公开的 aster-lang-test 仓库。
 */
import { getTranslations } from 'next-intl/server';
import { ArrowRight, ArrowUpRight, FileText } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Card, CardBody, Container } from '@/components/ui';
import { HISTORY_FILES, PARITY_REPO_URL, repoFileUrl } from '@/lib/equivalence/fetch';

export async function ParityMethodology() {
  const t = await getTranslations('equivalencePage');
  const items = t.raw('methodology.items') as string[];

  return (
    <section className="border-t border-border bg-bg-subtle py-14" aria-labelledby="parity-methodology">
      <Container size="wide">
        <div className="grid gap-10 lg:grid-cols-[1.5fr_1fr]">
          <div className="space-y-5">
            <h2 id="parity-methodology" className="font-display text-2xl font-semibold tracking-tight">
              {t('methodology.heading')}
            </h2>
            <ul className="space-y-3 text-sm leading-relaxed text-fg-muted">
              {items.map((item, i) => (
                <li key={i} className="flex gap-3">
                  <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-4">
            <Card>
              <CardBody className="space-y-3">
                <h3 className="text-sm font-semibold text-fg">{t('methodology.rawDataHeading')}</h3>
                <ul className="space-y-1.5 text-sm">
                  {Object.values(HISTORY_FILES).map((file) => (
                    <li key={file}>
                      <a href={repoFileUrl(file)} className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:text-primary-hover">
                        {file}
                        <ArrowUpRight className="size-3" aria-hidden />
                      </a>
                    </li>
                  ))}
                </ul>
                <a href={PARITY_REPO_URL} className="inline-flex items-center gap-1 text-sm font-medium text-fg hover:text-primary">
                  {t('methodology.repoLink')}
                  <ArrowUpRight className="size-3.5" aria-hidden />
                </a>
              </CardBody>
            </Card>
            <Card>
              <CardBody className="space-y-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
                  <FileText className="size-4 text-primary" aria-hidden />
                  {t('whitepaperCta.heading')}
                </h3>
                <p className="text-sm leading-relaxed text-fg-muted">{t('whitepaperCta.body')}</p>
                <Link href="/equivalence/whitepaper" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:text-primary-hover">
                  {t('methodology.whitepaperLink')}
                  <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              </CardBody>
            </Card>
          </div>
        </div>
      </Container>
    </section>
  );
}
