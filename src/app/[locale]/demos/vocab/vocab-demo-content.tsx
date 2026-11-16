'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { compile, evaluate } from '@aster-cloud/aster-lang-ts/browser';
import {
  VOCAB_DOMAINS,
  VOCAB_DOMAIN_IDS,
  VOCAB_DEMO_TENANT,
  registerVocabForDomain,
  lexiconFor,
  toDemoLocale,
  explainCase,
  type VocabDomainId,
  type CaseExplanation,
} from '@/config/vocab-demo';
import { cn } from '@/components/ui';
import type { ReactNode } from 'react';

/** 正则元字符转义（术语名可能含特殊字符，安全起见）。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把规则源码里的领域术语高亮成 sky 色（呼应 monaco 编辑器「your vocabulary」约定）。
 * 让访客一眼看出哪些是「你的行业词」。最长优先匹配避免子串误切；术语名互不包含，
 * 但仍按长度降序拼正则以稳妥。中文无词边界，故不加 \b（术语集内无包含关系，安全）。
 */
function highlightVocab(source: string, terms: string[]): ReactNode[] {
  const valid = terms.filter((t) => t && t.length > 0).sort((a, b) => b.length - a.length);
  if (valid.length === 0) return [source];
  const re = new RegExp(`(${valid.map(escapeRegExp).join('|')})`, 'g');
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(source)) !== null) {
    if (m.index > last) out.push(source.slice(last, m.index));
    out.push(
      <span key={key++} className="font-semibold text-sky-400">{m[0]}</span>,
    );
    last = m.index + m[0].length;
  }
  if (last < source.length) out.push(source.slice(last));
  return out;
}

interface RunResult {
  caseId: string;
  decision: string;
  ok: boolean;
  /** 确定性回放（行业术语逐步说明，不经 LLM）。 */
  explanation: CaseExplanation;
}

export function VocabDemoContent({ locale }: { locale: string }) {
  const t = useTranslations('vocabDemoPage');
  const loc = toDemoLocale(locale);
  const [domainId, setDomainId] = useState<VocabDomainId>('healthcare');
  const [run, setRun] = useState<RunResult | null>(null);

  const domain = VOCAB_DOMAINS[domainId];
  const rule = domain.rules[loc];

  // canonical 字段名 → 当前语言行业术语（案例输入按行业说法展示，与规则一致）。
  const termLabel = (canonical: string): string =>
    domain.terms.find((term) => term.canonical === canonical)?.localized[loc] ?? canonical;

  // 编译该领域规则（按当前语言）：注入对应 locale 的领域词汇 → compile 翻成 canonical IR。
  const core = useMemo(() => {
    const domainKey = registerVocabForDomain(domain, loc);
    const r = compile(rule.source, {
      lexicon: lexiconFor(loc),
      domain: domainKey,
      tenantId: VOCAB_DEMO_TENANT,
    } as Parameters<typeof compile>[1]);
    return r.core ?? null;
  }, [domain, rule, loc]);

  function pickDomain(id: VocabDomainId) {
    setDomainId(id);
    setRun(null);
  }

  // 运行案例：eval 输入用 canonical 字段名（领域词只在表层，IR 是规范名）。
  function runCase(caseId: string) {
    const c = domain.cases.find((x) => x.id === caseId);
    if (!c || !core) return;
    const ev = evaluate(core, rule.ruleName, { [rule.paramName]: c.input });
    setRun({
      caseId,
      decision: ev.success ? String(ev.value) : c.expect[loc],
      ok: ev.success,
      explanation: explainCase(domain, loc, c.input),
    });
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:py-16">
      {/* 标题区 */}
      <div className="mb-10 text-center">
        <p className="text-sm font-semibold uppercase tracking-wide text-primary">{t('eyebrow')}</p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
          {t('title')}
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-lg text-fg-muted">{t('subtitle')}</p>
      </div>

      {/* 步骤 1：选领域 */}
      <section className="mb-8">
        <StepHeading n={1} title={t('step1.title')} />
        <p className="mb-3 text-sm text-fg-muted">{t('step1.hint')}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {VOCAB_DOMAIN_IDS.map((id) => (
            <button
              key={id}
              onClick={() => pickDomain(id)}
              className={cn(
                'rounded-lg border p-4 text-left transition-colors',
                domainId === id
                  ? 'border-primary bg-primary-subtle ring-1 ring-primary'
                  : 'border-border bg-bg hover:bg-bg-subtle',
              )}
            >
              <div className="text-sm font-semibold text-fg">{t(`domains.${id}.name`)}</div>
              <div className="mt-1 text-xs text-fg-muted">{t(`domains.${id}.tagline`)}</div>
            </button>
          ))}
        </div>
      </section>

      {/* 步骤 2：领域术语表（行业词用当前语言） */}
      <section className="mb-8">
        <StepHeading n={2} title={t('step2.title')} />
        <p className="mb-3 text-sm text-fg-muted">{t('step2.hint')}</p>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="bg-bg-subtle">
              <tr>
                <Th>{t('terms.colIndustry')}</Th>
                <Th>{t('terms.colCanonical')}</Th>
                <Th>{t('terms.colKind')}</Th>
                <Th>{t('terms.colGloss')}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {domain.terms.map((term) => (
                <tr key={term.canonical}>
                  <td className="px-4 py-2 font-mono font-medium text-sky-700 dark:text-sky-400">{term.localized[loc]}</td>
                  <td className="px-4 py-2 font-mono text-xs text-fg-muted">{term.canonical}</td>
                  <td className="px-4 py-2 text-xs text-fg-muted">{t(`terms.kind.${term.kind}`)}</td>
                  <td className="px-4 py-2 text-fg-muted">{t(`glosses.${term.canonical}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-fg-subtle">{t('terms.note')}</p>
      </section>

      {/* 步骤 3：用行业术语 + 当前语言 CNL 写的规则 */}
      <section className="mb-8">
        <StepHeading n={3} title={t('step3.title')} />
        <p className="mb-3 text-sm text-fg-muted">{t('step3.hint')}</p>
        <pre className="overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm leading-relaxed text-zinc-100">
          {highlightVocab(rule.source, domain.terms.map((t) => t.localized[loc]))}
        </pre>
        <p className="mt-2 text-xs text-fg-subtle">
          <span className="font-mono font-semibold text-sky-700 dark:text-sky-400">{t('step3.legendTerm')}</span>
          {' '}{t('step3.legend')}
        </p>
      </section>

      {/* 步骤 4：选案例运行 */}
      <section className="mb-8">
        <StepHeading n={4} title={t('step4.title')} />
        <p className="mb-3 text-sm text-fg-muted">{t('step4.hint')}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {domain.cases.map((c) => (
            <button
              key={c.id}
              onClick={() => runCase(c.id)}
              className={cn(
                'rounded-lg border p-4 text-left transition-colors',
                run?.caseId === c.id
                  ? 'border-primary bg-primary-subtle ring-1 ring-primary'
                  : 'border-border bg-bg hover:bg-bg-subtle',
              )}
            >
              <div className="font-mono text-xs text-fg-subtle">{c.id}</div>
              <div className="mt-1 text-sm font-semibold text-fg">{t(`domains.${domainId}.cases.${c.labelKey}`)}</div>
              <div className="mt-1 space-y-0.5 text-xs text-fg-muted">
                {Object.entries(c.input).map(([k, v]) => (
                  // 显示行业术语而非 canonical key（与该语言规则一致）。
                  <div key={k} className="font-mono">{termLabel(k)}: {v}</div>
                ))}
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* 决策结果 + 轻量回放（行业术语逐步说明，可审计） */}
      {run && (
        <section className="mb-8 rounded-xl border border-border bg-bg-subtle p-5">
          <div className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{t('result.label')}</div>
          <div className="mt-2 inline-flex items-center rounded-full bg-emerald-50 px-3 py-1 text-base font-semibold text-emerald-800 ring-1 ring-emerald-200">
            {run.decision}
          </div>

          {/* 决策回放：逐档展示命中/未命中（行业术语 + 实际值）。 */}
          <div className="mt-4">
            <div className="mb-2 text-xs font-semibold text-fg">{t('replay.title')}</div>
            <ol className="space-y-2">
              {run.explanation.tiers.map((tier, i) => (
                <li key={i} className="border-l-2 border-border pl-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-fg">{tier.decision}</span>
                    {tier.evaluated ? (
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 text-[10px] font-semibold',
                          tier.matched ? 'bg-emerald-50 text-emerald-700' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
                        )}
                      >
                        {tier.matched ? t('replay.matched') : t('replay.notMatched')}
                      </span>
                    ) : (
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 dark:bg-zinc-800">
                        {t('replay.skipped')}
                      </span>
                    )}
                  </div>
                  {tier.conditions.length > 0 && (
                    <ul className="mt-0.5 space-y-0.5">
                      {tier.conditions.map((cond, j) => (
                        <li key={j} className="font-mono text-xs text-fg-muted">
                          {cond.expression}{' '}
                          <span className={cond.matched ? 'text-success' : 'text-fg-subtle'}>
                            {cond.matched ? '✓' : '✗'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          </div>

          <p className="mt-3 text-sm text-fg-muted">{t('result.note')}</p>
        </section>
      )}

      {/* CTA */}
      <div className="mt-12 rounded-xl border border-border bg-bg-subtle p-6 text-center">
        <p className="text-lg font-semibold text-fg">{t('cta.title')}</p>
        <p className="mt-1 text-sm text-fg-muted">{t('cta.subtitle')}</p>
      </div>
    </div>
  );
}

function StepHeading({ n, title }: { n: number; title: string }) {
  return (
    <h2 className="mb-2 text-sm font-semibold text-fg">
      <span className="mr-2 inline-flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-fg">{n}</span>
      {title}
    </h2>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider text-fg-subtle">
      {children}
    </th>
  );
}
