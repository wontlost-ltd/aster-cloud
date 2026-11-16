'use client';

import { getWhitepaper } from '@/config/whitepaper';

interface WhitepaperContentProps {
  locale: string;
}

/**
 * 双引擎等价白皮书的可读 + 可打印渲染。
 *
 * 「下载 PDF」= 触发浏览器 window.print()，配合 print CSS（globals.css 的
 * @media print）隐藏页眉/按钮、收紧版面，浏览器「另存为 PDF」即得一份干净白皮书。
 * 不引第三方 PDF 库——零依赖、CSP/Workers 友好，且 PDF 永远与页面内容同源一致。
 */
export function WhitepaperContent({ locale }: WhitepaperContentProps) {
  const w = getWhitepaper(locale);

  return (
    <article className="whitepaper mx-auto max-w-3xl px-4 py-12 sm:py-16">
      {/* 操作条（打印时隐藏） */}
      <div className="no-print mb-10 flex flex-wrap items-center justify-between gap-3">
        <a
          href={`/${locale}/equivalence`}
          className="text-sm font-medium text-primary hover:underline"
        >
          ← {w.meta.backToEquivalence}
        </a>
        <button
          onClick={() => window.print()}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-fg shadow-sm hover:bg-primary-hover"
        >
          <svg className="size-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
            <path fillRule="evenodd" d="M5 4v3h10V4a1 1 0 00-1-1H6a1 1 0 00-1 1zm-2 4a2 2 0 00-2 2v4a2 2 0 002 2h1v1a1 1 0 001 1h8a1 1 0 001-1v-1h1a2 2 0 002-2v-4a2 2 0 00-2-2H3zm3 6a1 1 0 011-1h6a1 1 0 011 1v3H6v-3z" clipRule="evenodd" />
          </svg>
          {w.meta.downloadPdf}
        </button>
      </div>

      {/* 标题块 */}
      <header className="mb-10 border-b border-border pb-8">
        <h1 className="font-display text-3xl font-bold tracking-tight text-fg sm:text-4xl">
          {w.meta.title}
        </h1>
        <p className="mt-3 text-lg text-fg-muted">{w.meta.subtitle}</p>
        <dl className="mt-6 space-y-1 text-sm text-fg-muted">
          <MetaRow label={w.meta.audienceLabel} value={w.meta.audience} />
          <MetaRow label={w.meta.versionLabel} value={w.meta.version} />
          <MetaRow label={w.meta.whatLabel} value={w.meta.what} />
        </dl>
        <p className="no-print mt-4 text-xs text-fg-subtle">{w.meta.printHint}</p>
      </header>

      {/* §1 问题 */}
      <Section heading={w.problem.heading}>
        {w.problem.paras.map((p, i) => (
          <p key={i} className="prose-p">{p}</p>
        ))}
      </Section>

      {/* §2 含义 */}
      <Section heading={w.meaning.heading}>
        {w.meaning.paras.map((p, i) => (
          <p key={i} className="prose-p">{p}</p>
        ))}
      </Section>

      {/* §3 证据表 */}
      <Section heading={w.evidence.heading}>
        <p className="prose-p">{w.evidence.intro}</p>
        <div className="my-4 overflow-x-auto rounded-lg border border-border">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="bg-bg-subtle">
              <tr>
                <Th>{w.evidence.colLayer}</Th>
                <Th>{w.evidence.colResult}</Th>
                <Th>{w.evidence.colProves}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {w.evidence.rows.map((r) => (
                <tr key={r.layer}>
                  <td className="px-4 py-3 align-top font-medium text-fg">{r.layer}</td>
                  <td className="px-4 py-3 align-top font-mono text-xs text-fg">{r.result}</td>
                  <td className="px-4 py-3 align-top text-fg-muted">{r.proves}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="prose-p font-medium text-fg">{w.evidence.zeroDivergence}</p>
        <blockquote className="mt-4 border-l-4 border-border bg-bg-subtle px-4 py-3 text-sm text-fg-muted">
          {w.evidence.honestyNote}
        </blockquote>
      </Section>

      {/* §4 实例 */}
      <Section heading={w.example.heading}>
        <p className="prose-p">{w.example.intro}</p>
        <pre tabIndex={0} className="my-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-xs leading-relaxed text-zinc-100 print:border print:border-zinc-300 print:bg-white print:text-zinc-900">
          {w.example.ruleCode}
        </pre>
        <p className="prose-p">{w.example.declinedLead}</p>
        <ol className="my-3 list-decimal space-y-1 pl-6 text-sm text-fg">
          {w.example.steps.map((s, i) => (
            <li key={i} className="font-mono">{s}</li>
          ))}
        </ol>
        <p className="prose-p">{w.example.closing}</p>
        <p className="prose-p italic text-fg-muted">{w.example.tryAt}</p>
      </Section>

      {/* §5 回报 */}
      <Section heading={w.buys.heading}>
        <ul className="space-y-3">
          {w.buys.items.map((b) => (
            <li key={b.title} className="text-sm text-fg-muted">
              <span className="font-semibold text-fg">{b.title}</span> {b.body}
            </li>
          ))}
        </ul>
      </Section>

      {/* §6 范围与诚实 */}
      <Section heading={w.scope.heading}>
        <ul className="space-y-3">
          {w.scope.items.map((b) => (
            <li key={b.title} className="text-sm text-fg-muted">
              <span className="font-semibold text-fg">{b.title}</span> {b.body}
            </li>
          ))}
        </ul>
      </Section>

      {/* §7 一句话 */}
      <Section heading={w.oneSentence.heading}>
        <blockquote className="border-l-4 border-primary bg-primary-subtle px-4 py-3 text-base font-medium text-fg">
          {w.oneSentence.body}
        </blockquote>
      </Section>

      {/* 脚注 */}
      <footer className="mt-10 border-t border-border pt-6 text-xs leading-relaxed text-fg-subtle">
        {w.footer}
      </footer>
    </article>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
      <dt className="font-semibold text-fg sm:min-w-28">{label}:</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-xl font-semibold text-fg">{heading}</h2>
      {children}
    </section>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider text-fg-subtle">
      {children}
    </th>
  );
}
