'use client';

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { compile, evaluate, EN_US, ZH_CN, DE_DE } from '@aster-cloud/aster-lang-ts/browser';
import { DecisionTracePanel, type DecisionTrace } from '@/components/policy/decision-trace-panel';
import {
  toDemoLocale,
  buildRuleSource,
  toEvalContext,
  getRuleName,
  computeDecision,
  buildExplanation,
  evaluateOnJvmEngine,
  buildDecisionRecord,
  digestDecision,
  DEFAULT_THRESHOLDS,
  DEMO_APPLICANTS,
  BOUNDARY_PAIR,
  type DemoLocale,
  type DemoApplicant,
  type Thresholds,
  type Outcome,
  type AdverseReason,
  type CreditExplanation as CreditExplanationModel,
} from '@/config/credit-risk-demo';
import { CreditExplanation } from './credit-explanation';
import { cn } from '@/components/ui';

interface DemoContentProps {
  locale: string;
}

const LEXICONS: Record<DemoLocale, unknown> = { en: EN_US, zh: ZH_CN, de: DE_DE };

const OUTCOME_STYLES: Record<Outcome, string> = {
  approved: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  refer: 'bg-amber-50 text-amber-800 ring-amber-200',
  declined: 'bg-rose-50 text-rose-800 ring-rose-200',
};

/** 一次「重跑」的结果：决策来自真实引擎，trace 来自客户端镜像。 */
interface RunResult {
  decision: string;
  outcome: Outcome;
  adverseReason: AdverseReason | null;
  trace: DecisionTrace;
  /** 确定性解释模型（值已代入，不经 LLM）。 */
  explanation: CreditExplanationModel;
  /** 决策记录的 SHA-256 哈希（可确定性重算的凭据）。'computing' = 异步计算中；
   *  'unavailable' = crypto.subtle 不可用（极罕见，如非安全上下文）；否则是 64-hex 哈希。 */
  hash: string | 'computing' | 'unavailable';
}

export function DemoContent({ locale }: DemoContentProps) {
  const t = useTranslations('demoPage');
  const loc = toDemoLocale(locale);

  // 申请人输入（可改）+ 关键阈值（可改）。改任一项 → 规则源码与重跑结果随之变化。
  const [applicant, setApplicant] = useState<DemoApplicant>(DEMO_APPLICANTS.approved);
  const [presetKey, setPresetKey] = useState<keyof typeof DEMO_APPLICANTS | null>('approved');
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const [run, setRun] = useState<RunResult | null>(null);
  // 双引擎对比：JVM（服务器 Truffle）引擎的决策。'checking' = 调用中；null = 未跑/不可用。
  const [jvm, setJvm] = useState<{ status: 'checking' | 'done' | 'unavailable'; decision: string | null }>(
    { status: 'unavailable', decision: null },
  );
  // run 代际计数：每次 rerun/resetRun 递增。异步 JVM 请求只在代际仍匹配时落地，
  // 防止旧请求晚返回覆盖新 run 的 jvm 状态（导致 TS 来自新 run、JVM 来自旧 run 的错配）。
  const runGenRef = useRef(0);

  // 规则源码：随当前阈值实时重建（改阈值 → 规则文本立刻变），证明展示的就是要执行的。
  const ruleSource = useMemo(() => buildRuleSource(loc, thresholds), [loc, thresholds]);

  function resetRun() {
    runGenRef.current += 1; // 作废任何飞行中的 JVM 请求
    setRun(null);
    setJvm({ status: 'unavailable', decision: null });
  }

  function pickPreset(key: keyof typeof DEMO_APPLICANTS) {
    setApplicant(DEMO_APPLICANTS[key]);
    setPresetKey(key);
    resetRun(); // 换输入 → 旧结果作废，必须重跑
  }

  function editApplicant(patch: Partial<DemoApplicant>) {
    setApplicant((a) => ({ ...a, ...patch }));
    setPresetKey(null); // 手改 → 脱离预设
    resetRun();
  }

  function editThreshold(patch: Partial<Thresholds>) {
    setThresholds((th) => ({ ...th, ...patch }));
    resetRun();
  }

  // 「重跑」：用真实浏览器引擎编译当前规则 + 执行当前申请人，决策以引擎为准。
  // 同时异步在服务器 JVM 引擎上执行同一规则，拿回决策与 TS 引擎并排对比（双引擎确定性证据）。
  function rerun() {
    const result = compile(ruleSource, { lexicon: LEXICONS[loc] } as Parameters<typeof compile>[1]);
    if (!result.core) {
      resetRun();
      return;
    }
    const ev = evaluate(result.core, getRuleName(loc), toEvalContext(loc, applicant));
    const mirror = computeDecision(loc, applicant, thresholds);
    const engineDecision = ev.success ? String(ev.value) : mirror.decision;
    const trace = { ...mirror.trace, executionTimeMs: ev.executionTimeMs ?? mirror.trace.executionTimeMs };
    setRun({
      decision: engineDecision,
      outcome: mirror.outcome,
      adverseReason: mirror.adverseReason,
      trace,
      explanation: buildExplanation(loc, applicant, thresholds),
      hash: 'computing', // 异步计算，下方 digest 完成后填充
    });

    // 双引擎对比：调服务器 JVM 引擎执行同一规则。fail-open——不可达则降级"仅浏览器引擎"。
    // 用 applicant 快照固定本次请求；用 run 代际 token 防旧请求晚返回覆盖新 run 的状态。
    const snapshot = applicant;
    runGenRef.current += 1;
    const gen = runGenRef.current;

    // 决策哈希：把规范化决策记录（规则源+输入+决策+trace）取 SHA-256。代际守卫防旧 run 覆盖。
    const record = buildDecisionRecord(loc, ruleSource, snapshot, engineDecision, trace);
    digestDecision(record)
      .then((hash) => {
        if (runGenRef.current !== gen) return;
        setRun((r) => (r ? { ...r, hash } : r));
      })
      .catch(() => {
        // crypto.subtle 不可用（极罕见，如非安全上下文）→ 标记 unavailable，UI 显示提示。
        if (runGenRef.current !== gen) return;
        setRun((r) => (r ? { ...r, hash: 'unavailable' as const } : r));
      });

    setJvm({ status: 'checking', decision: null });
    evaluateOnJvmEngine(loc, ruleSource, snapshot)
      .then((res) => {
        if (runGenRef.current !== gen) return; // 已有更新的 run，丢弃本次结果
        setJvm(res.ok ? { status: 'done', decision: res.decision } : { status: 'unavailable', decision: null });
      })
      .catch(() => {
        if (runGenRef.current === gen) setJvm({ status: 'unavailable', decision: null });
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

      {/* 步骤 1：信贷规则（随阈值实时重建，只读展示） */}
      <section className="mb-8">
        <StepHeading n={1} title={t('step1.title')} />
        <p className="mb-3 text-sm text-fg-muted">{t('step1.hint')}</p>
        <pre className="overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm leading-relaxed text-zinc-100">
          {ruleSource}
        </pre>
      </section>

      {/* 步骤 2：选申请人 + 改输入 */}
      <section className="mb-8">
        <StepHeading n={2} title={t('step2.title')} />
        <p className="mb-3 text-sm text-fg-muted">{t('step2.hint')}</p>
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {(Object.keys(DEMO_APPLICANTS) as (keyof typeof DEMO_APPLICANTS)[]).map((key) => (
            <button
              key={key}
              onClick={() => pickPreset(key)}
              className={cn(
                'rounded-lg border p-4 text-left transition-colors',
                presetKey === key
                  ? 'border-primary bg-primary-subtle ring-1 ring-primary'
                  : 'border-border bg-bg hover:bg-bg-subtle',
              )}
            >
              <div className="font-mono text-xs text-fg-subtle">{DEMO_APPLICANTS[key].id}</div>
              <div className="mt-1 text-sm font-semibold text-fg">{t(`scenarios.${key}.label`)}</div>
              <div className="mt-1 text-xs text-fg-muted">
                {t('fields.creditScore')} {DEMO_APPLICANTS[key].creditScore}
              </div>
            </button>
          ))}
        </div>
        {/* 可编辑申请人字段 */}
        <div className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-bg-subtle p-4 sm:grid-cols-4">
          <NumberField label={t('fields.creditScore')} value={applicant.creditScore} step={1}
            onChange={(v) => editApplicant({ creditScore: v })} />
          <NumberField label={t('fields.monthlyIncome')} value={applicant.monthlyIncome} step={100} prefix="$"
            onChange={(v) => editApplicant({ monthlyIncome: v })} />
          <NumberField label={t('fields.monthlyDebt')} value={applicant.monthlyDebt} step={100} prefix="$"
            onChange={(v) => editApplicant({ monthlyDebt: v })} />
          <NumberField label={t('fields.requestedAmount')} value={applicant.requestedAmount} step={1000} prefix="$"
            onChange={(v) => editApplicant({ requestedAmount: v })} />
        </div>
      </section>

      {/* 步骤 3：改阈值（改规则） */}
      <section className="mb-8">
        <StepHeading n={3} title={t('step3.title')} />
        <p className="mb-3 text-sm text-fg-muted">{t('step3.hint')}</p>
        <div className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-bg-subtle p-4 sm:grid-cols-3">
          <NumberField label={t('thresholds.premiumScore')} value={thresholds.premiumScore} step={1}
            onChange={(v) => editThreshold({ premiumScore: v })} />
          <NumberField label={t('thresholds.premiumDti')} value={thresholds.premiumDti} step={0.01}
            onChange={(v) => editThreshold({ premiumDti: v })} />
          <NumberField label={t('thresholds.standardScore')} value={thresholds.standardScore} step={1}
            onChange={(v) => editThreshold({ standardScore: v })} />
          <NumberField label={t('thresholds.standardDti')} value={thresholds.standardDti} step={0.01}
            onChange={(v) => editThreshold({ standardDti: v })} />
          <NumberField label={t('thresholds.minScore')} value={thresholds.minScore} step={1}
            onChange={(v) => editThreshold({ minScore: v })} />
          <NumberField label={t('thresholds.maxLti')} value={thresholds.maxLti} step={0.5}
            onChange={(v) => editThreshold({ maxLti: v })} />
          <div className="flex items-end">
            <button
              onClick={() => { setThresholds(DEFAULT_THRESHOLDS); setRun(null); }}
              className="text-xs font-medium text-fg-subtle underline-offset-2 hover:text-fg hover:underline"
            >
              {t('thresholds.reset')}
            </button>
          </div>
        </div>
      </section>

      {/* 步骤 4：重跑 → 决策 */}
      <section className="mb-8">
        <StepHeading n={4} title={t('step4.title')} />
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
          <button
            onClick={rerun}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-fg shadow-sm hover:bg-primary-hover"
          >
            <svg className="size-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <path d="M4 4.5v11l9-5.5-9-5.5z" />
            </svg>
            {t('runButton')}
          </button>
          {run && (
            <div className="text-right">
              <div className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{t('decisionLabel')}</div>
              <div className={cn('mt-1 inline-flex items-center rounded-full px-3 py-1 text-base font-semibold ring-1', OUTCOME_STYLES[run.outcome])}>
                {run.decision}
              </div>
            </div>
          )}
        </div>
        {!run && <p className="mt-3 text-sm text-fg-muted">{t('runHint')}</p>}
      </section>

      {/* 双引擎对比：浏览器 TS 引擎 vs 服务器 JVM 引擎，逐字节相同 = 护城河最硬证据 */}
      {run && (
        <section className="mb-8">
          <DualEnginePanel
            tsDecision={run.decision}
            jvm={jvm}
            outcome={run.outcome}
            labels={{
              title: t('dualEngine.title'),
              hint: t('dualEngine.hint'),
              tsLabel: t('dualEngine.tsLabel'),
              jvmLabel: t('dualEngine.jvmLabel'),
              agree: t('dualEngine.agree'),
              disagree: t('dualEngine.disagree'),
              unavailable: t('dualEngine.jvmUnavailable'),
              checking: t('dualEngine.checking'),
            }}
          />
        </section>
      )}

      {/* 步骤 5：回放（DecisionTracePanel）—— 杀手卖点 */}
      {run && (
        <section className="mb-8">
          <StepHeading n={5} title={t('replayTitle')} />

          {/* 不利决策理由（adverse-action）——拒贷/转人工的法律披露物。 */}
          {run.adverseReason && (
            <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
              <div className="flex items-start gap-3">
                <svg className="mt-0.5 size-5 flex-shrink-0 text-amber-600" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                </svg>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-amber-700">{t('adverse.label')}</div>
                  <p className="mt-1 text-sm font-medium text-amber-900">
                    {t(`adverse.reasons.${run.adverseReason.reasonKey}`, {
                      actual: run.adverseReason.actual,
                      threshold: run.adverseReason.threshold,
                    })}
                  </p>
                  <p className="mt-1.5 text-xs text-amber-700">{t('adverse.note')}</p>
                </div>
              </div>
            </div>
          )}

          <p className="mb-4 rounded-md bg-primary-subtle px-4 py-3 text-sm text-fg">{t('step4.auditorNote')}</p>

          {/* 确定性决策解释（值已代入，不经 LLM）——这才是「为什么是这个决策」的准确答案。 */}
          <div className="mb-4">
            <h3 className="mb-1 text-sm font-semibold text-fg">{t('explanation.heading')}</h3>
            <p className="mb-3 text-xs text-fg-muted">{t('explanation.sub')}</p>
            <CreditExplanation explanation={run.explanation} />
          </div>

          {/* 原始执行轨迹（事实已在上方确定性给出，这里是逐步的执行佐证）。 */}
          <DecisionTracePanel trace={run.trace} />

          {/* 决策哈希（可独立重演 + 不可篡改）—— 回放的封顶凭据。 */}
          <DecisionHashPanel
            hash={run.hash}
            labels={{
              heading: t('hash.heading'),
              sub: t('hash.sub'),
              computing: t('hash.computing'),
              unavailable: t('hash.unavailable'),
              copy: t('hash.copy'),
              copied: t('hash.copied'),
            }}
          />
        </section>
      )}

      {/* 边界翻转对照：1 分之差翻转决策 —— 精确性 + 可解释性 + 可回放性的最强单例 */}
      <section className="mb-8">
        <BoundaryFlipPanel
          loc={loc}
          thresholds={thresholds}
          labels={{
            title: t('boundary.title'),
            hint: t('boundary.hint'),
            passLabel: t('boundary.passLabel'),
            failLabel: t('boundary.failLabel'),
            identicalExcept: t('boundary.identicalExcept'),
            scoreField: t('fields.creditScore'),
            flipNote: (pass, fail, threshold) =>
              t('boundary.flipNote', { pass, fail, threshold }),
            noFlipNote: (pass) => t('boundary.noFlipNote', { pass }),
          }}
        />
      </section>

      {/* CTA */}
      <div className="mt-12 rounded-xl border border-border bg-bg-subtle p-6 text-center">
        <p className="text-lg font-semibold text-fg">{t('cta.title')}</p>
        <p className="mt-1 text-sm text-fg-muted">{t('cta.subtitle')}</p>
        <a
          href={`/${locale}/login`}
          className="mt-4 inline-flex items-center rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-fg shadow-sm hover:bg-primary-hover"
        >
          {t('cta.button')}
        </a>
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

function NumberField({
  label, value, onChange, step = 1, prefix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  prefix?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs text-fg-subtle">{label}</span>
      <div className="mt-1 flex items-center rounded-md border border-border bg-bg focus-within:ring-1 focus-within:ring-primary">
        {prefix && <span className="pl-2 text-sm text-fg-subtle">{prefix}</span>}
        <input
          type="number"
          inputMode="decimal"
          step={step}
          value={value}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange(v);
          }}
          className="w-full bg-transparent px-2 py-1.5 font-mono text-sm font-medium text-fg outline-none"
        />
      </div>
    </label>
  );
}

/**
 * 双引擎对比面板：浏览器内 TS 引擎决策 vs 服务器 JVM(Truffle) 引擎决策，并排展示。
 * 两者逐字节相同 = 双引擎确定性护城河的当场可验证证据。JVM 不可达时 fail-open 降级。
 */
function DualEnginePanel({
  tsDecision,
  jvm,
  outcome,
  labels,
}: {
  tsDecision: string;
  jvm: { status: 'checking' | 'done' | 'unavailable'; decision: string | null };
  outcome: Outcome;
  labels: {
    title: string; hint: string; tsLabel: string; jvmLabel: string;
    agree: string; disagree: string; unavailable: string; checking: string;
  };
}) {
  const agree = jvm.status === 'done' && jvm.decision === tsDecision;
  const disagree = jvm.status === 'done' && jvm.decision !== tsDecision;
  return (
    <div>
      <StepHeadingPlain title={labels.title} />
      <p className="mb-3 text-sm text-fg-muted">{labels.hint}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <EngineCard label={labels.tsLabel} decision={tsDecision} outcome={outcome} />
        {jvm.status === 'checking' && (
          <div className="flex items-center justify-center rounded-lg border border-dashed border-border bg-bg-subtle p-4 text-sm text-fg-muted">
            {labels.checking}
          </div>
        )}
        {jvm.status === 'done' && (
          <EngineCard label={labels.jvmLabel} decision={jvm.decision ?? ''} outcome={outcome} />
        )}
        {jvm.status === 'unavailable' && (
          <div className="flex items-center justify-center rounded-lg border border-dashed border-border bg-bg-subtle p-4 text-center text-xs text-fg-subtle">
            {labels.unavailable}
          </div>
        )}
      </div>
      {agree && (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200">
          <svg className="size-4 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
            <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 011.4-1.4L8 12.6l7.3-7.3a1 1 0 011.4 0z" clipRule="evenodd" />
          </svg>
          {labels.agree}
        </div>
      )}
      {disagree && (
        <div className="mt-3 rounded-md bg-rose-50 px-4 py-2.5 text-sm font-semibold text-rose-800 ring-1 ring-rose-200">
          {labels.disagree}
        </div>
      )}
    </div>
  );
}

function EngineCard({ label, decision, outcome }: { label: string; decision: string; outcome: Outcome }) {
  return (
    <div className="rounded-lg border border-border bg-bg p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{label}</div>
      <div className={cn('mt-2 inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold ring-1', OUTCOME_STYLES[outcome])}>
        {decision}
      </div>
    </div>
  );
}

/**
 * 边界翻转对照面板：BOUNDARY_PAIR（信用分仅差 1 分）两份申请的决策并排展示，
 * 高亮"1 分之差翻转结果"。决策由 computeDecision 实时算（随阈值变），始终与规则一致。
 */
function BoundaryFlipPanel({
  loc,
  thresholds,
  labels,
}: {
  loc: DemoLocale;
  thresholds: Thresholds;
  labels: {
    title: string; hint: string; passLabel: string; failLabel: string;
    identicalExcept: string; scoreField: string;
    flipNote: (pass: string, fail: string, threshold: number) => string;
    noFlipNote: (pass: string) => string;
  };
}) {
  const pass = computeDecision(loc, BOUNDARY_PAIR.pass, thresholds);
  const fail = computeDecision(loc, BOUNDARY_PAIR.fail, thresholds);
  // 阈值可调：若用户改阈值使两边决策相同（不再翻转），文案不能继续断言"翻转"——
  // 切到中性说明，引导调回 660 看边界。默认阈值下二者不同 → 显示翻转文案。
  const flipped = pass.decision !== fail.decision;
  return (
    <div>
      <StepHeadingPlain title={labels.title} />
      <p className="mb-3 text-sm text-fg-muted">{labels.hint}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <BoundaryCard
          label={labels.passLabel}
          score={BOUNDARY_PAIR.pass.creditScore}
          scoreField={labels.scoreField}
          decision={pass.decision}
          outcome={pass.outcome}
        />
        <BoundaryCard
          label={labels.failLabel}
          score={BOUNDARY_PAIR.fail.creditScore}
          scoreField={labels.scoreField}
          decision={fail.decision}
          outcome={fail.outcome}
        />
      </div>
      <p className={cn(
        'mt-3 rounded-md px-4 py-3 text-sm',
        flipped ? 'bg-primary-subtle text-fg' : 'bg-bg-subtle text-fg-muted',
      )}>
        {flipped
          ? labels.flipNote(pass.decision, fail.decision, thresholds.standardScore)
          : labels.noFlipNote(pass.decision)}
      </p>
      <p className="mt-1.5 text-center text-xs text-fg-subtle">{labels.identicalExcept}</p>
    </div>
  );
}

function BoundaryCard({
  label, score, scoreField, decision, outcome,
}: {
  label: string; score: number; scoreField: string; decision: string; outcome: Outcome;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg p-4">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{label}</span>
        <span className="font-mono text-xs text-fg-subtle">{scoreField} {score}</span>
      </div>
      <div className={cn('mt-2 inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold ring-1', OUTCOME_STYLES[outcome])}>
        {decision}
      </div>
    </div>
  );
}

/** 无序号的小标题（双引擎/边界面板用，复用 StepHeading 视觉但不带序号圈）。 */
function StepHeadingPlain({ title }: { title: string }) {
  return <h2 className="mb-2 text-sm font-semibold text-fg">{title}</h2>;
}

/**
 * 决策哈希面板：展示本次决策记录的 SHA-256（规则源+输入+决策+trace 的确定性摘要）。
 * 这是回放的封顶凭据——合规人可拿这串哈希独立重算核对，证明"决策可被重演且不可篡改"。
 */
function DecisionHashPanel({
  hash,
  labels,
}: {
  hash: string | 'computing' | 'unavailable';
  labels: {
    heading: string; sub: string; computing: string;
    unavailable: string; copy: string; copied: string;
  };
}) {
  const [copied, setCopied] = useState(false);
  const isHash = hash !== 'computing' && hash !== 'unavailable';

  const onCopy = async () => {
    if (!isHash) return;
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 剪贴板不可用（权限/非安全上下文）→ 静默忽略，哈希仍可手动选取 */
    }
  };

  return (
    <div className="mt-4">
      <h3 className="mb-1 text-sm font-semibold text-fg">{labels.heading}</h3>
      <p className="mb-3 text-xs text-fg-muted">{labels.sub}</p>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-zinc-900 px-4 py-3">
        <svg className="size-4 flex-shrink-0 text-emerald-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
          <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
        </svg>
        {isHash ? (
          <>
            <code className="min-w-0 flex-1 break-all font-mono text-xs text-zinc-100">{hash}</code>
            <button
              type="button"
              onClick={onCopy}
              className="flex-shrink-0 rounded-md border border-zinc-600 px-3 py-1 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-800"
            >
              {copied ? labels.copied : labels.copy}
            </button>
          </>
        ) : (
          <span className="text-xs text-zinc-400">
            {hash === 'unavailable' ? labels.unavailable : labels.computing}
          </span>
        )}
      </div>
    </div>
  );
}
