'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import dynamic from 'next/dynamic';
import {
  POKER_RULES, toDemoLocale, pokerHighlightTerms,
  type HandCategory,
} from '@/config/poker';
import { usePokerLoop } from './use-poker-loop';
import { cn } from '@/components/ui';

// 牌桌场景纯 SVG/CSS 可 SSR，但用 dynamic 与 kitten 一致（避免首屏闪烁）。
const PokerTableScene = dynamic(() => import('./poker-table-scene').then((m) => m.PokerTableScene), {
  ssr: false,
  loading: () => <div className="poker-stage" aria-hidden />,
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 高亮规则里的扑克领域词（sky）。 */
function highlightVocab(source: string, terms: string[]): ReactNode[] {
  const valid = terms.filter(Boolean).sort((a, b) => b.length - a.length);
  if (valid.length === 0) return [source];
  const re = new RegExp(`(${valid.map(escapeRegExp).join('|')})`, 'g');
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(source)) !== null) {
    if (m.index > last) out.push(source.slice(last, m.index));
    out.push(<span key={key++} className="font-semibold text-sky-400">{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < source.length) out.push(source.slice(last));
  return out;
}

const HAND_CATEGORIES: HandCategory[] = [
  'high', 'pair', 'twoPair', 'trips', 'straight',
  'flush', 'fullHouse', 'quads', 'straightFlush',
];

export function PokerContent({ locale }: { locale: string }) {
  const t = useTranslations('pokerPage');
  const loc = toDemoLocale(locale);
  const rule = POKER_RULES[loc];
  const { hand, paused, togglePause, dealNext } = usePokerLoop(loc);

  const playerLabels: [string, string] = useMemo(
    () => [t('player1'), t('player2')],
    [t],
  );
  const categoryLabel = useMemo(
    () => (c: HandCategory) => t(`hands.${c}`),
    [t],
  );

  // 当前手的状态文案（发牌中/翻牌中/引擎判定中/赢家）。
  const phaseText = (() => {
    if (!hand) return t('phases.shuffling');
    switch (hand.phase) {
      case 'deal': return t('phases.dealing');
      case 'reveal': return t('phases.revealing');
      case 'judge': return t('phases.judging');
      case 'award':
        return hand.winner === 0
          ? t('phases.tie')
          : t('phases.winner', { player: hand.winner === 1 ? playerLabels[0] : playerLabels[1] });
    }
  })();

  return (
    <div className="mx-auto max-w-4xl px-4 py-12 sm:py-16">
      {/* 标题区 */}
      <div className="mb-6 text-center">
        <p className="text-sm font-semibold uppercase tracking-wide text-primary">{t('eyebrow')}</p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
          {t('title')}
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-lg text-fg-muted">{t('subtitle')}</p>
      </div>

      {/* 牌桌（C 位，自动往复发牌→翻牌→引擎判赢→颁奖杯） */}
      <section className="mb-3">
        <PokerTableScene
          hand={hand}
          playerLabels={playerLabels}
          categoryLabel={categoryLabel}
          tieLabel={t('phases.tie')}
        />
      </section>

      {/* 阶段说明 + 控制 */}
      <div className="mb-6 flex flex-col items-center gap-3">
        <div
          className={cn(
            'inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-base font-semibold ring-1 transition-colors',
            hand?.phase === 'award' && hand.winner !== 0
              ? 'bg-amber-50 text-amber-800 ring-amber-200'
              : hand?.phase === 'judge'
                ? 'bg-sky-50 text-sky-800 ring-sky-200'
                : 'bg-bg-subtle text-fg-muted ring-border',
          )}
          aria-live="polite"
        >
          {hand?.phase === 'judge' && <span className="poker-judge-dot" aria-hidden />}
          {phaseText}
        </div>
        <div className="flex gap-2">
          <button
            onClick={togglePause}
            className="rounded-lg border border-border bg-bg px-4 py-1.5 text-sm font-medium text-fg transition-colors hover:bg-bg-subtle"
          >
            {paused ? t('controls.resume') : t('controls.pause')}
          </button>
          <button
            onClick={dealNext}
            disabled={!paused}
            className="rounded-lg border border-border bg-bg px-4 py-1.5 text-sm font-medium text-fg transition-colors hover:bg-bg-subtle disabled:opacity-40"
          >
            {t('controls.deal')}
          </button>
        </div>
      </div>

      {/* 规则（纯 CNL 牌型判定，默认折叠——源较长，best-5-of-7 全在 CNL） */}
      <section className="mb-8">
        <details className="group">
          <summary className="mb-2 flex cursor-pointer items-center gap-2 text-sm font-semibold text-fg">
            <span className="text-fg-subtle transition-transform group-open:rotate-90">▶</span>
            {t('ruleTitle')}
          </summary>
          <pre tabIndex={0} className="overflow-x-auto rounded-lg bg-zinc-900 p-4 text-xs leading-relaxed text-zinc-100">
            {highlightVocab(rule.source, pokerHighlightTerms(loc))}
          </pre>
          <p className="mt-2 text-xs text-fg-subtle">
            <span className="font-mono font-semibold text-sky-600 dark:text-sky-400">{t('legendTerm')}</span>
            {' '}{t('legend')}
          </p>
        </details>
      </section>

      {/* 牌型强弱表（图例） */}
      <section className="mb-8">
        <h2 className="mb-2 text-sm font-semibold text-fg">{t('handsTitle')}</h2>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {HAND_CATEGORIES.map((c, i) => (
            <div key={c} className="rounded-md border border-border bg-bg-subtle px-2 py-1.5 text-center text-[11px] text-fg-muted">
              <span className="mr-1 font-mono text-fg-subtle">{i + 1}</span>
              {t(`hands.${c}`)}
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-fg-subtle">{t('handsHint')}</p>
      </section>

      {/* 收尾彩蛋 */}
      <div className="mt-10 rounded-xl border border-border bg-bg-subtle p-5 text-center">
        <p className="text-sm text-fg-muted">{t('footer')}</p>
      </div>
    </div>
  );
}
