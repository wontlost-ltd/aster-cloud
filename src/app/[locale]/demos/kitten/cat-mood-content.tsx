'use client';

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { compile, evaluate } from '@aster-cloud/aster-lang-ts/browser';
import {
  CAT_RULES, CAT_SCENES, CAT_DEMO_TENANT,
  registerCatVocab, catLexiconFor, catMoodOf, catTermLabel, catVocabTerms,
  toDemoLocale,
  type CatMood, type CatScene as CatSceneData,
} from '@/config/cat-mood';
import dynamic from 'next/dynamic';
import type { Cat25DHandle } from './cat-25d-scene';
import { cn } from '@/components/ui';

// 2.5D 场景（纯 SVG + CSS，无 WebGL）；客户端动态加载，加载前显示占位。
const Cat25DScene = dynamic(() => import('./cat-25d-scene').then((m) => m.Cat25DScene), {
  ssr: false,
  loading: () => <div className="cat-3d-stage" aria-hidden />,
});

/** 正则转义。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 高亮规则里的撸猫领域词（sky）。 */
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

interface RunResult {
  sceneId: CatMood;
  mood: CatMood;
}

export function CatMoodContent({ locale }: { locale: string }) {
  const t = useTranslations('catMoodPage');
  const loc = toDemoLocale(locale);
  const rule = CAT_RULES[loc];
  const [run, setRun] = useState<RunResult | null>(null);
  const sceneRef = useRef<Cat25DHandle>(null);

  // 编译猫规则（注入猫词汇）。
  const core = useMemo(() => {
    const domainKey = registerCatVocab(loc);
    const r = compile(rule.source, {
      lexicon: catLexiconFor(loc), domain: domainKey, tenantId: CAT_DEMO_TENANT,
    } as Parameters<typeof compile>[1]);
    return r.core ?? null;
  }, [rule, loc]);

  // 运行场景：引擎求心情 → 让活猫走过去做出响应。
  function runScene(scene: CatSceneData) {
    if (!core) return;
    const ev = evaluate(core, rule.ruleName, { [rule.paramName]: scene.input });
    const mood = (ev.success ? String(ev.value) : catMoodOf(scene.input)) as CatMood;
    setRun({ sceneId: scene.id, mood });
    sceneRef.current?.react(mood);
  }

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

      {/* 活猫布景（C 位，始终在场——平时自主游荡，运行规则时响应） */}
      <section className="mb-3">
        <Cat25DScene ref={sceneRef} />
      </section>

      {/* 心情说明（运行后显示） */}
      <div className="mb-4 min-h-14 text-center">
        {run ? (
          <>
            <div className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-4 py-1.5 text-base font-semibold text-emerald-800 ring-1 ring-emerald-200">
              {t(`moods.${run.mood}.name`)}
            </div>
            <p className="mx-auto mt-2 max-w-md text-sm italic text-fg-muted">{t(`moods.${run.mood}.quip`)}</p>
          </>
        ) : (
          <p className="mt-2 text-sm text-fg-subtle">{t('idleHint')}</p>
        )}
      </div>

      {/* 场景按钮（紧跟布景，方便控制 → 运行规则 → 活猫响应） */}
      <section className="mb-8">
        <h2 className="mb-2 text-sm font-semibold text-fg">{t('sceneTitle')}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {CAT_SCENES.map((scene) => (
            <button
              key={scene.id}
              onClick={() => runScene(scene)}
              className={cn(
                'rounded-lg border p-3 text-left transition-colors',
                run?.sceneId === scene.id
                  ? 'border-primary bg-primary-subtle ring-1 ring-primary'
                  : 'border-border bg-bg hover:bg-bg-subtle',
              )}
            >
              <div className="text-sm font-semibold text-fg">{t(`scenes.${scene.id}.label`)}</div>
              <div className="mt-1 space-y-0.5 text-[11px] text-fg-muted">
                {Object.entries(scene.input).map(([k, v]) => (
                  <div key={k} className="font-mono">{catTermLabel(k, loc)}: {v}</div>
                ))}
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* 诗 */}
      <blockquote className="mx-auto mb-8 max-w-xl rounded-lg border-l-4 border-primary bg-primary-subtle px-5 py-4 text-center text-sm italic leading-relaxed text-fg">
        {t('poem').split('\n').map((line, i) => (
          <span key={i} className="block">{line}</span>
        ))}
      </blockquote>

      {/* 规则（撸猫领域词高亮） */}
      <section className="mb-8">
        <h2 className="mb-2 text-sm font-semibold text-fg">{t('ruleTitle')}</h2>
        <pre tabIndex={0} className="overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm leading-relaxed text-zinc-100">
          {highlightVocab(rule.source, catVocabTerms(loc))}
        </pre>
        <p className="mt-2 text-xs text-fg-subtle">
          <span className="font-mono font-semibold text-sky-600 dark:text-sky-400">{t('legendTerm')}</span>
          {' '}{t('legend')}
        </p>
      </section>

      {/* 收尾彩蛋 */}
      <div className="mt-10 rounded-xl border border-border bg-bg-subtle p-5 text-center">
        <p className="text-sm text-fg-muted">{t('footer')}</p>
      </div>
    </div>
  );
}
