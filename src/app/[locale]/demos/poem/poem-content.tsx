'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { compile, evaluate, canonicalize, buildVocabularyScopes } from '@aster-cloud/aster-lang-ts/browser';
import { POEMS, toPoemLocale } from '@/config/poem-demo';
import { toCanonical, toDisplay } from '@/lib/layout-map';
import { cn } from '@/components/ui';

interface RunResult {
  poemId: string;
  /** computed 范式：所选样本 input；alias-literal 范式：0（单次运行，无意义入参）。 */
  input: number;
  /** 运行输出：computed=算出的整首诗；alias-literal=诗名。 */
  woven: string;
  /** computed 范式的「这一遍在算什么」说明；alias-literal 范式为空。 */
  computed: string;
  /**
   * alias-literal 范式专属：诗体源码经 `canonicalize()` 得到的**真实引擎输出**（非 config 手写
   * poem.canonical）。这一步只展开**字面量宏**（末词 → 目标字符串，如 思故乡→「静夜思」、
   * जागे→英文结句），可直接看到宏在表层生效；关键词别名由下一步 token translation 解析，
   * 不在此产物里。computed 范式为空。
   */
  canonical?: string;
}

export function PoemDemoContent({ locale }: { locale: string }) {
  const t = useTranslations('poemDemoPage');
  const poem = POEMS[toPoemLocale(locale)];
  const isAliasLiteral = poem.paradigm === 'alias-literal';
  const isDecision = poem.paradigm === 'decision';
  // 结果连同其所属诗一起存：诗变了（切语言）旧结果即失效（render 期守卫，避免 set-state-in-effect）。
  const [run, setRun] = useState<RunResult | null>(null);
  const result = run && run.poemId === poem.lexicon.id ? run : null;
  const [showCanonical, setShowCanonical] = useState(false);

  // LayoutMap 解耦：`compileSource` 是编译用的规范源码（关键词间带语法必需空格）；`displaySource`
  // 是给用户看的排版（如无空格工整原诗）。无 layout 时二者都退回 poem.source（向后兼容）。
  // 不变式（poem-demo.compile.test.ts 钉死）：toCanonical(layout) === poem.source，故编译行为不变，
  // 仅**显示**变成无空格原诗。
  const compileSource = poem.layout ? toCanonical(poem.layout) : poem.source;
  const displaySource = poem.layout ? toDisplay(poem.layout) : poem.source;

  // 编译诗体源码（注入诗词别名词典）→ canonicalize 归一回规范关键词 → 同款引擎编译。
  // alias-literal 范式（《静夜思》）还需字面量宏词汇表：直接作为编译词汇传入（ADR 0051）。
  const core = useMemo(() => {
    const r = compile(compileSource, {
      lexicon: poem.lexicon,
      ...(poem.vocab ? { vocabulary: poem.vocab } : {}),
    });
    return r.core ?? null;
  }, [poem, compileSource]);

  // computed 范式：代入 input 算出整首诗。
  function runAt(input: number) {
    if (!core || !poem.param) return;
    const sample = poem.samples?.find((s) => s.input === input);
    const ev = evaluate(core, poem.entry, { [poem.param]: input });
    setRun({
      poemId: poem.lexicon.id,
      input,
      woven: ev.success ? String(ev.value) : '—',
      computed: sample?.computed ?? '',
    });
  }

  // alias-literal 范式：单次运行。展示引擎实况——① 诗体源码经 canonicalize 的真实输出（字面量宏
  // 把领字就地展开成字符串字面量的**引擎产物**，非 config 手写）② evaluate 入口 rule 的真实返回。
  // 入口 rule 无 given 参数，故传空参对象。
  function runOnce() {
    if (!core || !poem.vocab) return;
    const canonical = canonicalize(compileSource, {
      lexicon: poem.lexicon,
      vocabulary: buildVocabularyScopes(poem.vocab),
    });
    const ev = evaluate(core, poem.entry, {});
    setRun({
      poemId: poem.lexicon.id,
      input: 0,
      woven: ev.success ? String(ev.value) : '—',
      computed: '',
      canonical,
    });
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:py-16">
      {/* 标题区 */}
      <div className="mb-10 text-center">
        <p className="text-sm font-semibold uppercase tracking-wide text-primary">{t('eyebrow')}</p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
          {t('title')}
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-lg text-fg-muted">{t('subtitle')}</p>
      </div>

      {/* 诗体源码 —— 上半诗句，下半真计算 */}
      <section className="mb-8">
        <h2 className="mb-1 text-sm font-semibold text-fg">{t('source.title')}</h2>
        <p className="mb-1 text-sm text-fg-muted">{t('source.hint')}</p>
        <p className="mb-3 text-xs text-fg-subtle">
          <span className="font-display italic text-fg">{poem.title}</span>
          <span> · {poem.attribution}</span>
        </p>
        <pre className="overflow-x-auto rounded-xl border border-border bg-bg-subtle p-5 font-mono text-sm leading-relaxed text-fg">
          {displaySource}
        </pre>
        <button
          onClick={() => setShowCanonical((v) => !v)}
          className="mt-3 text-sm font-medium text-primary hover:underline"
        >
          {showCanonical ? t('source.hideCanonical') : t('source.showCanonical')}
        </button>
        {showCanonical && (
          <div className="mt-3">
            <p className="mb-2 text-xs text-fg-subtle">{t('source.canonicalNote')}</p>
            <pre className="overflow-x-auto rounded-xl border border-border bg-bg p-5 font-mono text-sm leading-relaxed text-fg-muted">
              {poem.canonical}
            </pre>
          </div>
        )}
      </section>

      {/* decision 范式（《Du bist mein》）：拨动前提 → 引擎实时推导裁决 */}
      {isDecision && poem.decision ? (
        <DecisionRunner poem={poem} core={core} t={t} />
      ) : (
        <>
          {/* 运行 —— alias-literal 单次运行看引擎实况；computed 三样本按 input 算出整首诗 */}
          <section className="mb-8">
            <h2 className="mb-2 text-sm font-semibold text-fg">{t('run.title')}</h2>
            <p className="mb-3 text-sm text-fg-muted">{t('run.hint')}</p>
            {isAliasLiteral ? (
              <button
                onClick={runOnce}
                disabled={!core}
                className={cn(
                  'rounded-lg border px-6 py-3 text-sm font-medium transition-colors',
                  result
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-bg-subtle text-fg hover:border-primary/50',
                  !core && 'cursor-not-allowed opacity-50',
                )}
              >
                {t('run.button')}
              </button>
            ) : (
              <div className="flex flex-wrap gap-3">
                {(poem.samples ?? []).map((s) => (
                  <button
                    key={s.input}
                    onClick={() => runAt(s.input)}
                    disabled={!core}
                    className={cn(
                      'rounded-lg border px-5 py-3 text-sm font-medium transition-colors',
                      result?.input === s.input
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-bg-subtle text-fg hover:border-primary/50',
                      !core && 'cursor-not-allowed opacity-50',
                    )}
                  >
                    {t('run.button', { n: s.input })}
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* 结果 —— alias-literal 展示编译+求值实况；computed 展示算出的整首诗 + 计算说明 */}
          {result && isAliasLiteral && (
            <section className="mb-8 rounded-xl border border-border bg-bg-subtle p-6">
              <p className="mb-4 text-sm font-semibold text-fg">{t('result.title')}</p>

              {/* ① canonicalize 真实展开出的规范源码（引擎产物） */}
              <p className="mb-2 text-xs font-semibold text-fg-subtle">{t('result.canonicalizeLabel')}</p>
              <pre className="overflow-x-auto rounded-lg border border-border bg-bg p-4 font-mono text-xs leading-relaxed text-fg-muted">
                {result.canonical}
              </pre>

              {/* ② evaluate 入口 rule 的真实返回 */}
              <p className="mt-5 mb-2 text-xs font-semibold text-fg-subtle">{t('result.evaluateLabel')}</p>
              <p className="font-display text-3xl leading-relaxed text-fg">{result.woven}</p>

              <p className="mt-5 text-sm text-fg-muted">{t('result.note')}</p>
            </section>
          )}
          {result && !isAliasLiteral && (
            <section className="mb-8 rounded-xl border border-border bg-bg-subtle p-6">
              <p className="mb-3 text-sm font-semibold text-fg">{t('result.title', { n: result.input })}</p>
              <p className="font-display text-xl leading-relaxed text-fg">{result.woven}</p>
              {result.computed && (
                <p className="mt-4 border-l-2 border-primary/40 pl-3 font-mono text-xs text-fg-subtle">
                  {result.computed}
                </p>
              )}
              <p className="mt-4 text-sm text-fg-muted">{t('result.note')}</p>
            </section>
          )}
        </>
      )}

      {/* CTA */}
      <div className="mt-12 rounded-xl border border-border bg-bg-subtle p-6 text-center">
        <p className="text-lg font-semibold text-fg">{t('cta.title')}</p>
        <p className="mt-1 text-sm text-fg-muted">{t('cta.subtitle')}</p>
      </div>
    </div>
  );
}

/**
 * decision 范式子组件（《Du bist mein, ich bin dein》）：用户拨动诗的四个布尔前提，引擎**实时
 * 重求值**入口裁决规则并显示裁决。翻任一前提裁决即变——真判定，非查表。
 *
 * 边界说明（诚实性）：**裁决**（verdict）由 `evaluate` 给出——前端只把 toggle 布尔传进去，
 * 不实现裁决逻辑。而**中间值展示**（gehoert/verschlossen）是前端按 `decision.derived.from`
 * 镜像规范源码的 let 绑定（AND 复算）得到的，仅供解释推导链，非 evaluate 的输出。
 */
function DecisionRunner({
  poem,
  core,
  t,
}: {
  poem: (typeof POEMS)[keyof typeof POEMS];
  core: ReturnType<typeof compile>['core'] | null;
  t: ReturnType<typeof useTranslations>;
}) {
  const spec = poem.decision!;
  // 每个前提一个布尔，初值全真（„für immer" 情形）。
  const [values, setValues] = useState<Record<string, boolean>>(
    () => Object.fromEntries(spec.toggles.map((tg) => [tg.name, true])),
  );

  // 引擎实时裁决：把当前前提布尔传进 evaluate，拿真实返回。前端不实现裁决逻辑。
  const verdict = useMemo(() => {
    if (!core) return null;
    const ev = evaluate(core, poem.entry, values);
    return ev.success ? String(ev.value) : '—';
  }, [core, poem.entry, values]);

  // 中间值展示：前端按规范源码的 let 绑定**镜像复算**（其 from 前提全为真时该中间值为真）。
  // 这仅供展示推导链，**不是** evaluate 的输出——真裁决由上面的 evaluate 决定。
  const derivedTrue = (from: string[]) => from.every((n) => values[n]);
  const allTrue = spec.toggles.every((tg) => values[tg.name]);

  return (
    <>
      {/* 拨动前提 */}
      <section className="mb-8">
        <h2 className="mb-2 text-sm font-semibold text-fg">{t('run.title')}</h2>
        <p className="mb-4 text-sm text-fg-muted">{t('run.hint')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {spec.toggles.map((tg) => (
            <button
              key={tg.name}
              type="button"
              role="switch"
              aria-checked={values[tg.name]}
              onClick={() => setValues((v) => ({ ...v, [tg.name]: !v[tg.name] }))}
              disabled={!core}
              className={cn(
                'flex items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm font-medium transition-colors',
                values[tg.name]
                  ? 'border-primary bg-primary/10 text-fg'
                  : 'border-border bg-bg-subtle text-fg-muted hover:border-primary/50',
                !core && 'cursor-not-allowed opacity-50',
              )}
            >
              <span
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs',
                  values[tg.name] ? 'border-primary bg-primary text-white' : 'border-border',
                )}
                aria-hidden
              >
                {values[tg.name] ? '✓' : ''}
              </span>
              <span className="font-display italic">{tg.label}</span>
            </button>
          ))}
        </div>
      </section>

      {/* 引擎推导 + 裁决 */}
      <section className="mb-8 rounded-xl border border-border bg-bg-subtle p-6">
        <p className="mb-4 text-sm font-semibold text-fg">{t('result.title')}</p>

        {/* 引擎推导的中间值（let 绑定） */}
        <p className="mb-2 text-xs font-semibold text-fg-subtle">{t('result.derivedLabel')}</p>
        <div className="space-y-1 font-mono text-xs text-fg-muted">
          {spec.derived.map((d) => (
            <p key={d.name}>
              <span className="text-fg">{d.label}</span>
              {' → '}
              <span className={derivedTrue(d.from) ? 'text-primary' : 'text-fg-subtle'}>
                {derivedTrue(d.from) ? t('result.true') : t('result.false')}
              </span>
            </p>
          ))}
        </div>

        {/* 裁决（引擎真返回） */}
        <p className="mt-5 mb-2 text-xs font-semibold text-fg-subtle">{t('result.verdictLabel')}</p>
        <p
          className={cn(
            'font-display text-3xl leading-relaxed',
            allTrue ? 'text-primary' : 'text-fg',
          )}
        >
          {verdict}
        </p>

        <p className="mt-5 text-sm text-fg-muted">{t('result.note')}</p>
      </section>
    </>
  );
}
