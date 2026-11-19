'use client';

/**
 * 「本策略」内嵌词汇编辑器（ADR 0060 §6、§7.5）：增、删、改写在策略版本里的词条，含字面量宏（literal）。
 *
 * - 词条形状、上限与校验全部来自 `@/lib/policy-embedded-vocabulary`（与保存时服务端同一份代码）：
 *   表单每次输入都对「加上这条后的整份内嵌词汇」跑一次 validateEmbeddedVocabulary，错误按码本地化显示，
 *   只有通过校验的词条才能提交——所以交给编辑器编译 / LSP 的永远是合法词汇，且提交是离散的，
 *   不会每次按键都让 LSP 按新词汇重新初始化。
 * - field / enum_value 必须填写所属类型（parent，规范名）；候选来自作用域内词汇的类型与源码里声明的类型。
 * - literal 行标「展开为字符串」并显示展开值：审阅者一眼能看到触发词最终变成什么文本。
 * - readOnly：无结构化编写能力的作者只看到列表（没有任何输入控件）；保存时省略字段，服务端沿用。
 */
import { useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Input, Label, Select } from '@/components/ui';
import type { AliasSet } from '@/lib/policy-alias-shared';
import {
  EMBEDDED_VOCABULARY_LIMITS,
  EmbeddedVocabularyError,
  validateEmbeddedVocabulary,
  type EmbeddedTerm,
  type EmbeddedTermKind,
  type EmbeddedVocabulary,
  type EmbeddedVocabularyErrorCode,
} from '@/lib/policy-embedded-vocabulary';

export interface EmbeddedVocabularyEditorProps {
  /** 当前内嵌词汇；null 表示没有词条。 */
  value: EmbeddedVocabulary | null;
  /** 提交增删改后的整份内嵌词汇（只读时不调用）。 */
  onChange?: (next: EmbeddedVocabulary) => void;
  /** 策略的 CNL 语言（规范标签）：关键词碰撞按它判定。 */
  locale: string;
  /** 本策略的关键词别名：内嵌写法不得与其中的别名同形。 */
  aliasSet: AliasSet | null;
  readOnly?: boolean;
  /** field / enum_value 的所属类型候选（规范名）。 */
  parentOptions?: readonly string[];
}

const KINDS: readonly EmbeddedTermKind[] = ['literal', 'struct', 'field', 'function', 'enum_value'];
const NO_PARENTS: readonly string[] = [];
const MAX_TERMS = EMBEDDED_VOCABULARY_LIMITS.maxTerms;

const needsParent = (kind: EmbeddedTermKind) => kind === 'field' || kind === 'enum_value';

interface FormState {
  /** 正在编辑的词条下标；null 为新增。 */
  index: number | null;
  kind: EmbeddedTermKind;
  localized: string;
  canonical: string;
  parent: string;
  /** 用户已动过表单：之后才显示「必填」提示，空表单不报错。 */
  touched: boolean;
}

const BLANK: FormState = { index: null, kind: 'literal', localized: '', canonical: '', parent: '', touched: false };

/** 表单 → 词条：写法、规范名与所属类型去掉首尾空白；字面量文本原样保留（空白也是内容）。 */
function termOf(form: FormState): EmbeddedTerm {
  const base = {
    kind: form.kind,
    localized: form.localized.trim(),
    canonical: form.kind === 'literal' ? form.canonical : form.canonical.trim(),
  };
  return needsParent(form.kind) ? { ...base, parent: form.parent.trim() } : base;
}

/** 用表单词条替换（编辑）或追加（新增）后的整份词条。 */
function candidateTerms(terms: readonly EmbeddedTerm[], form: FormState): EmbeddedTerm[] {
  const term = termOf(form);
  return form.index === null ? [...terms, term] : terms.map((t, i) => (i === form.index ? term : t));
}

/** 校验整份内嵌词汇，返回第一个错误码；合法（含无词条）为 null。 */
export function embeddedVocabularyErrorCode(
  terms: readonly EmbeddedTerm[],
  ctx: { locale: string; aliasSet: AliasSet | null },
): EmbeddedVocabularyErrorCode | null {
  if (terms.length === 0) return null;
  try {
    validateEmbeddedVocabulary({ v: 1, terms: [...terms] }, ctx);
    return null;
  } catch (err) {
    if (err instanceof EmbeddedVocabularyError) return err.code;
    throw err;
  }
}

/** 必填项缺失时的文案键；齐全为 null。 */
function missingKey(form: FormState): string | null {
  if (form.localized.trim() === '') return 'requiredLocalized';
  if (form.canonical.trim() === '') return form.kind === 'literal' ? 'requiredLiteral' : 'requiredCanonical';
  if (needsParent(form.kind) && form.parent.trim() === '') return 'requiredParent';
  return null;
}

export function EmbeddedVocabularyEditor({
  value,
  onChange,
  locale,
  aliasSet,
  readOnly = false,
  parentOptions = NO_PARENTS,
}: EmbeddedVocabularyEditorProps) {
  const t = useTranslations('policyEditor.embeddedTerms');
  const headingId = useId();
  const terms = useMemo(() => value?.terms ?? [], [value]);
  const ctx = useMemo(() => ({ locale, aliasSet }), [locale, aliasSet]);
  // 整份词汇的问题（例如作者事后加的关键词别名与某个写法同形）：列表上方提示，保存会被拒
  const wholeError = useMemo(() => embeddedVocabularyErrorCode(terms, ctx), [terms, ctx]);
  const [form, setForm] = useState<FormState>(BLANK);
  const editable = !readOnly && Boolean(onChange);

  const commit = (next: EmbeddedTerm[]) => {
    onChange?.({ v: 1, terms: next });
    setForm(BLANK);
  };
  const remove = (index: number) => {
    // 删除正在编辑的词条时收起表单；删除它之前的词条时下标随之前移
    setForm((f) => (f.index === index ? BLANK : f.index !== null && f.index > index ? { ...f, index: f.index - 1 } : f));
    onChange?.({ v: 1, terms: terms.filter((_, i) => i !== index) });
  };
  const edit = (index: number) => {
    const term = terms[index]!;
    setForm({ index, kind: term.kind, localized: term.localized, canonical: term.canonical, parent: term.parent ?? '', touched: false });
  };

  return (
    <section aria-labelledby={headingId} data-testid="embedded-vocabulary" className="space-y-2">
      <h3 id={headingId} className="flex items-center justify-between text-xs font-semibold uppercase text-fg-muted">
        <span>{t('title')}</span>
        <span>{t('count', { count: terms.length, max: MAX_TERMS })}</span>
      </h3>
      <p className="text-xs text-fg-muted">{readOnly ? t('readOnlyNote') : t('hint')}</p>
      {wholeError && (
        <p role="alert" className="rounded border border-danger/30 bg-danger/5 px-2 py-1 text-xs text-danger">
          {t(`errors.${wholeError}`)}
        </p>
      )}
      {terms.length === 0 ? (
        <p className="text-xs text-fg-muted">{t('empty')}</p>
      ) : (
        <ul aria-labelledby={headingId} className="space-y-1">
          {terms.map((term, index) => (
            <li
              key={`${term.kind}/${term.parent ?? ''}/${term.localized}/${index}`}
              data-testid="embedded-term"
              className="flex items-start justify-between gap-2 rounded border border-border px-2 py-1"
            >
              <TermSummary term={term} />
              {editable && (
                <span className="flex shrink-0 gap-0.5">
                  <button
                    type="button"
                    aria-label={t('edit', { term: term.localized })}
                    aria-pressed={form.index === index}
                    onClick={() => edit(index)}
                    className="inline-flex size-7 items-center justify-center rounded text-sm text-fg-muted hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:shadow-ring"
                  >
                    <span aria-hidden>✎</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t('remove', { term: term.localized })}
                    onClick={() => remove(index)}
                    className="inline-flex size-7 items-center justify-center rounded text-sm text-fg-muted hover:bg-bg-subtle hover:text-danger focus-visible:outline-none focus-visible:shadow-ring"
                  >
                    <span aria-hidden>×</span>
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <TermForm
          form={form}
          onFormChange={setForm}
          terms={terms}
          ctx={ctx}
          parentOptions={parentOptions}
          onSubmit={commit}
          onCancel={() => setForm(BLANK)}
        />
      )}
    </section>
  );
}

/** 一条词条的只读展示：写法 → 规范名；字面量显示「展开为字符串」与展开值。 */
export function TermSummary({ term }: { term: EmbeddedTerm }) {
  const t = useTranslations('policyEditor.embeddedTerms');
  return (
    <span className="min-w-0 space-y-0.5">
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium text-fg">{term.localized}</span>
        <span className="text-[10px] uppercase text-fg-muted">{t(`kind_${term.kind}`)}</span>
      </span>
      {term.kind === 'literal' ? (
        <span className="block text-xs text-fg-muted">
          <span className="mr-1 rounded bg-sky-100 px-1 py-0.5 text-[10px] font-medium text-sky-900 dark:bg-sky-900/60 dark:text-sky-100">
            {t('expandsTo')}
          </span>
          <span className="break-all font-mono">&quot;{term.canonical}&quot;</span>
        </span>
      ) : (
        <span className="block break-all font-mono text-xs text-fg-muted">
          {term.parent ? `${term.parent}.` : ''}
          {term.canonical}
        </span>
      )}
    </span>
  );
}

interface TermFormProps {
  form: FormState;
  onFormChange: (form: FormState) => void;
  terms: readonly EmbeddedTerm[];
  ctx: { locale: string; aliasSet: AliasSet | null };
  parentOptions: readonly string[];
  onSubmit: (terms: EmbeddedTerm[]) => void;
  onCancel: () => void;
}

/** 新增 / 编辑一条词条；提交前即时校验「加上这条后的整份内嵌词汇」。 */
function TermForm({ form, onFormChange, terms, ctx, parentOptions, onSubmit, onCancel }: TermFormProps) {
  const t = useTranslations('policyEditor.embeddedTerms');
  const id = useId();
  const errorId = `${id}-error`;
  const atCap = form.index === null && terms.length >= MAX_TERMS;
  const missing = missingKey(form);
  const candidate = useMemo(() => candidateTerms(terms, form), [terms, form]);
  const code = useMemo(() => (missing ? null : embeddedVocabularyErrorCode(candidate, ctx)), [missing, candidate, ctx]);
  const message = atCap
    ? t('capReached', { max: MAX_TERMS })
    : code
      ? t(`errors.${code}`)
      : missing && form.touched
        ? t(missing)
        : null;
  const canSubmit = !atCap && !missing && !code;
  const set = (patch: Partial<FormState>) => onFormChange({ ...form, ...patch, touched: true });
  const describedBy = message ? errorId : undefined;
  const isLiteral = form.kind === 'literal';

  return (
    <form
      aria-labelledby={`${id}-title`}
      className="space-y-2 rounded border border-dashed border-border p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) onSubmit(candidate);
        else onFormChange({ ...form, touched: true });
      }}
    >
      <p id={`${id}-title`} className="text-xs font-medium text-fg">
        {form.index === null ? t('formTitleAdd') : t('formTitleEdit')}
      </p>
      <div className="space-y-1">
        <Label htmlFor={`${id}-kind`} className="text-xs">{t('kindLabel')}</Label>
        <Select
          id={`${id}-kind`}
          value={form.kind}
          disabled={atCap}
          onChange={(event) => set({ kind: event.target.value as EmbeddedTermKind })}
        >
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>{t(`kind_${kind}`)}</option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-localized`} className="text-xs">{t('localizedLabel')}</Label>
        <Input
          id={`${id}-localized`}
          value={form.localized}
          disabled={atCap}
          autoComplete="off"
          maxLength={EMBEDDED_VOCABULARY_LIMITS.maxLocalized * 2}
          aria-invalid={Boolean(message) && (code !== null || missing === 'requiredLocalized')}
          aria-describedby={describedBy}
          onChange={(event) => set({ localized: event.target.value })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-canonical`} className="text-xs">{isLiteral ? t('literalLabel') : t('canonicalLabel')}</Label>
        <Input
          id={`${id}-canonical`}
          value={form.canonical}
          disabled={atCap}
          autoComplete="off"
          aria-invalid={Boolean(message) && (code !== null || missing === 'requiredCanonical' || missing === 'requiredLiteral')}
          aria-describedby={describedBy}
          onChange={(event) => set({ canonical: event.target.value })}
        />
      </div>
      {needsParent(form.kind) && (
        <div className="space-y-1">
          <Label htmlFor={`${id}-parent`} className="text-xs">{t('parentLabel')}</Label>
          <Input
            id={`${id}-parent`}
            value={form.parent}
            list={`${id}-parents`}
            disabled={atCap}
            autoComplete="off"
            aria-invalid={Boolean(message) && missing === 'requiredParent'}
            aria-describedby={`${id}-parent-hint${describedBy ? ` ${describedBy}` : ''}`}
            onChange={(event) => set({ parent: event.target.value })}
          />
          <datalist id={`${id}-parents`}>
            {parentOptions.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
          <p id={`${id}-parent-hint`} className="text-xs text-fg-muted">
            {form.kind === 'field' ? t('parentHintField') : t('parentHintEnum')}
          </p>
        </div>
      )}
      <p id={errorId} role="status" aria-live="polite" className="min-h-4 text-xs text-danger">
        {message}
      </p>
      <div className="flex justify-end gap-2">
        {form.index !== null && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>{t('cancelEdit')}</Button>
        )}
        <Button type="submit" variant="secondary" size="sm" disabled={!canSubmit}>
          {form.index === null ? t('add') : t('update')}
        </Button>
      </div>
    </form>
  );
}
