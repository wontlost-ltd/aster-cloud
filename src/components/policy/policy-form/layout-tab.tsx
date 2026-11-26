'use client';

/**
 * 编辑器侧栏「排版」标签页（ADR 0058 §7.4–7.6，计划 T10，裁决 R11 / R12）。只在 structured_authoring 为真时挂载。
 *
 * Monaco 仍是唯一的 canonical 编辑器；这里只做「从 canonical 切分 + 改 display」：
 * - 源码超出 §7.6 上限：不提供任何入口，只说明原因与上限值；
 * - 无排版：「开始排版」（恒等排版）或「导入 JSON」；
 * - 源码改动后排版失效：不自动重排，只给「从恒等排版重新开始」「移除排版」（R12）；
 * - 有效排版：结构片段列表、把编辑器选区标为结构、并排视图开关，以及与保存同一实现的实时校验。
 *   实时校验带版本的编译上下文（locale、aliasSet、allowStructural、词汇），与保存时 `prepareLayout` 同口径，
 *   隐藏转义的 L10b 因而能在编辑器里判定（ADR 0058 修订 3 E8）；
 * - 开关 `nameEscape` 打开时另有「隐藏转义符」（E6）：把光标所在名字转义的两个反引号做成 L10a 三元组，当场跑 L10 预检，
 *   不通过就显示原因、不应用。
 * 排版状态由 PolicyForm 持有（LayoutDraft），经 PolicySaveContext 交给保存，不进 localStorage 草稿（R13）。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { LearnMoreLink } from '@/components/docs/docs-link';
import type { editor as MonacoEditor } from 'monaco-editor';
import {
  LAYOUT_LIMITS,
  LayoutError,
  parseLayout,
  toCanonical,
  validatePolicyLayout,
  type LayoutCompileContext,
  type LayoutValidation,
  type PolicyLayout,
} from '@aster-cloud/aster-lang-ts/layout';
import type { DomainVocabulary } from '@aster-cloud/aster-lang-ts/browser';
import { cn } from '@/components/ui';
import { getLexicon } from '@/lib/aster-lexicon';
import {
  escapeAt,
  hideEscapeDelimiters,
  identityLayout,
  layoutEditErrorCode,
  markStructural,
  offsetAt,
  positionAt,
  setStructuralDisplay,
  sourceLayoutLimitExceeded,
  unmarkStructuralSpan,
  type LayoutEditErrorCode,
} from '@/lib/policy-layout/edit-ops';
import { useLayoutErrorText } from './layout-error-text';

/** 编辑器里的排版草稿：未动 = 沿用加载时的排版（保存时省略 layout），edited = 提交该对象，removed = 提交 null。 */
export type LayoutDraft = { kind: 'untouched' } | { kind: 'edited'; layout: PolicyLayout } | { kind: 'removed' };

/** 实时校验的防抖间隔（毫秒）。 */
export const LAYOUT_VALIDATE_DEBOUNCE_MS = 300;

export interface LayoutTabProps {
  editor: MonacoEditor.IStandaloneCodeEditor | null;
  /** 编辑器当前的 canonical 源码。 */
  source: string;
  /** 策略的 CNL 语言：校验用该语言的词法表。 */
  cnlLocale: string;
  /** 策略当前的关键词别名：校验时与词法表取并集（与保存口径一致，R7）。 */
  aliasSet: Record<string, string[]> | null;
  /** 作者是否持有结构词别名授权（与保存时编译同一判定）：L10b 编译输入。 */
  allowStructural?: boolean;
  /** 编辑器编译所用的有效词汇：L10b 编译输入（与保存时 loadSaveVocabulary 同一合并）。 */
  vocabulary?: DomainVocabulary | null;
  /** 平台开关 `authoring.name_escape.enabled`：提供「隐藏转义符」（ADR 0058 修订 3 E6）。缺省关闭。 */
  nameEscape?: boolean;
  /** 当前排版（已按草稿推出）；null = 没有排版。 */
  layout: PolicyLayout | null;
  /** 已存排版复验不一致、未加载。 */
  inconsistent: boolean;
  sideBySide: boolean;
  onSideBySideChange: (value: boolean) => void;
  onChange: (next: LayoutDraft) => void;
}

const buttonClass =
  'rounded-md border border-border bg-bg px-2.5 py-1 text-xs font-medium text-fg hover:bg-bg-subtle focus-visible:outline-none focus-visible:shadow-ring disabled:opacity-50';
const noticeClass = 'rounded-lg border px-3 py-2 text-sm';
const warnNotice = cn(noticeClass, 'border-warning/30 bg-warning/10 text-fg');

interface CheckedLayout {
  layout: PolicyLayout;
  source: string;
  result: LayoutValidation;
}

/** L10 的两个失败码：「隐藏转义符」预检只因它们拒绝应用，其余问题照常由实时校验报告。 */
const L10_CODES: ReadonlySet<string> = new Set(['layout_escape_delimiter_invalid', 'layout_hidden_escape_changes_program']);

/** 版本的 L10b 编译输入（ADR 0059 修订 5 §2.3）：与保存时 prepareLayout 同口径，空 aliasSet 视为无别名。 */
export function layoutCompileContext(
  locale: string,
  aliasSet: Record<string, string[]> | null,
  allowStructural: boolean,
  vocabulary: DomainVocabulary | null,
): LayoutCompileContext {
  const aliases = aliasSet && Object.keys(aliasSet).length > 0 ? aliasSet : null;
  return { locale, aliasSet: aliases, allowStructural, vocabulary };
}

export function LayoutTab({
  editor,
  source,
  cnlLocale,
  aliasSet,
  allowStructural = false,
  vocabulary = null,
  nameEscape = false,
  layout,
  inconsistent,
  sideBySide,
  onSideBySideChange,
  onChange,
}: LayoutTabProps) {
  const t = useTranslations('policyEditor.layoutTab');
  const layoutErrorText = useLayoutErrorText();
  const [opError, setOpError] = useState<LayoutEditErrorCode | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [checked, setChecked] = useState<CheckedLayout | null>(null);
  // 「隐藏转义符」被 L10 预检拒绝时的原因（已本地化）；任何其他排版操作都清掉它
  const [hideError, setHideError] = useState<string | null>(null);
  const compileContext = useMemo(
    () => layoutCompileContext(cnlLocale, aliasSet, allowStructural, vocabulary),
    [cnlLocale, aliasSet, allowStructural, vocabulary],
  );

  const limitExceeded = useMemo(() => sourceLayoutLimitExceeded(source), [source]);
  const matchesSource = layout !== null && toCanonical(layout) === source;

  // 实时校验：与保存接口同一实现（包的 validatePolicyLayout），按版本 locale 的词法表 + 当前别名，并带编译上下文（L10b）；防抖后执行
  useEffect(() => {
    if (!layout || !matchesSource) return;
    const timer = setTimeout(() => {
      const result = validatePolicyLayout(layout, source, getLexicon(cnlLocale), aliasSet ?? undefined, compileContext);
      setChecked({ layout, source, result });
    }, LAYOUT_VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [layout, matchesSource, source, cnlLocale, aliasSet, compileContext]);
  const validation = checked && checked.layout === layout && checked.source === source ? checked.result : null;

  const edit = (fn: () => PolicyLayout) => {
    try {
      onChange({ kind: 'edited', layout: fn() });
      setOpError(null);
      setHideError(null);
    } catch (e) {
      const code = layoutEditErrorCode(e);
      if (!code) throw e;
      setOpError(code);
    }
  };

  const jumpTo = (offset: number) => {
    if (!editor) return;
    const { line, column } = positionAt(source, offset);
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column });
    editor.focus();
  };

  const markSelection = () => {
    if (!layout) return;
    const selection = editor?.getSelection();
    edit(() => {
      if (!selection) throw new RangeError('empty_range');
      const start = offsetAt(source, selection.startLineNumber, selection.startColumn);
      const end = offsetAt(source, selection.endLineNumber, selection.endColumn);
      // 新结构片段的 display 先与 canonical 相同，作者随后在列表里改写或清空
      return markStructural(layout, start, end, source.slice(start, end));
    });
  };

  /** 「隐藏转义符」：光标所在的转义做成三元组；L10 预检不过就显示原因、不应用（E6）。 */
  const hideSelectedEscape = () => {
    if (!layout) return;
    // 选区起点（无选区时即光标）
    const selection = editor?.getSelection();
    let candidate: PolicyLayout;
    try {
      const escape = selection ? escapeAt(source, offsetAt(source, selection.startLineNumber, selection.startColumn)) : null;
      if (!escape) throw new RangeError('no_escape');
      candidate = hideEscapeDelimiters(layout, escape);
    } catch (e) {
      const code = layoutEditErrorCode(e);
      if (!code) throw e;
      setOpError(code);
      setHideError(null);
      return;
    }
    const result = validatePolicyLayout(candidate, source, getLexicon(cnlLocale), aliasSet ?? undefined, compileContext);
    if (!result.ok && L10_CODES.has(result.code)) {
      setOpError(null);
      setHideError(layoutErrorText(result, source));
      return;
    }
    edit(() => candidate);
  };

  const applyImport = () => {
    try {
      onChange({ kind: 'edited', layout: parseLayout(importText) });
      setImportOpen(false);
      setImportText('');
      setImportError(null);
    } catch (e) {
      if (!(e instanceof LayoutError)) throw e;
      setImportError(layoutErrorText({ code: e.code, offset: e.offset, limit: e.limit }, source));
    }
  };

  const body = () => {
    if (limitExceeded) {
      const { limit, actual } = limitExceeded;
      return (
        <p className={warnNotice} data-layout-limit={limit}>
          {t('tooLarge', { limit: t(`limits.${limit}`), actual, max: LAYOUT_LIMITS[limit] })}
        </p>
      );
    }
    if (!layout) {
      return (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} disabled={source === ''} onClick={() => edit(() => identityLayout(source))}>
              {t('start')}
            </button>
            <button type="button" className={buttonClass} aria-expanded={importOpen} onClick={() => setImportOpen((v) => !v)}>
              {t('importJson')}
            </button>
          </div>
          {importOpen && (
            <div className="space-y-2">
              <label className="block text-xs font-medium text-fg-muted">
                {t('importLabel')}
                <textarea
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  rows={6}
                  spellCheck={false}
                  className="mt-1 block w-full rounded-md border border-border bg-bg p-2 font-mono text-xs text-fg"
                />
              </label>
              {importError && <p role="alert" className="text-xs text-danger">{importError}</p>}
              <div className="flex gap-2">
                <button type="button" className={buttonClass} onClick={applyImport}>{t('importApply')}</button>
                <button type="button" className={buttonClass} onClick={() => setImportOpen(false)}>{t('importCancel')}</button>
              </div>
            </div>
          )}
        </div>
      );
    }
    if (!matchesSource) {
      return (
        <div className="space-y-2">
          <p className={warnNotice} data-layout-invalidated="">{t('invalidated')}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} disabled={source === ''} onClick={() => edit(() => identityLayout(source))}>
              {t('restart')}
            </button>
            <button type="button" className={buttonClass} onClick={() => onChange({ kind: 'removed' })}>{t('remove')}</button>
          </div>
        </div>
      );
    }
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} onClick={markSelection}>{t('markSelection')}</button>
          {nameEscape && (
            <button type="button" className={buttonClass} onClick={hideSelectedEscape} data-layout-hide-escape="">
              {t('hideEscape')}
            </button>
          )}
          <button type="button" className={buttonClass} aria-pressed={sideBySide} onClick={() => onSideBySideChange(!sideBySide)}>
            {t('sideBySide')}
          </button>
          <button type="button" className={buttonClass} onClick={() => onChange({ kind: 'removed' })}>{t('remove')}</button>
        </div>
        <p className="text-xs text-fg-subtle">{t('sideBySideNote')}</p>
        {opError && <p role="alert" className="text-xs text-danger">{t(`opErrors.${opError}`)}</p>}
        {hideError && <p role="alert" data-layout-hide-escape-error="" className="text-xs text-danger">{hideError}</p>}
        <ValidationStatus
          validation={validation}
          message={validation && !validation.ok ? layoutErrorText(validation, source) : ''}
          jumpLabel={validation && !validation.ok && validation.offset !== undefined
            ? t('jump', { line: positionAt(source, validation.offset).line })
            : null}
          onJump={() => validation && !validation.ok && validation.offset !== undefined && jumpTo(validation.offset)}
        />
        <StructuralList layout={layout} onEdit={edit} />
      </div>
    );
  };

  return (
    <div className="space-y-3" data-testid="structured-authoring-layout">
      <p className="text-xs text-fg-muted">
        {t('hint')} <LearnMoreLink slug="guides/display-layouts" />
      </p>
      {inconsistent && !layout && <p className={warnNotice} data-layout-stored-inconsistent="">{t('storedInconsistent')}</p>}
      {body()}
    </div>
  );
}

function ValidationStatus({
  validation,
  message,
  jumpLabel,
  onJump,
}: {
  validation: LayoutValidation | null;
  message: string;
  jumpLabel: string | null;
  onJump: () => void;
}) {
  const t = useTranslations('policyEditor.layoutTab');
  if (!validation) return <p role="status" className="text-xs text-fg-subtle">{t('checking')}</p>;
  if (validation.ok) return <p role="status" className="text-xs text-success">{t('valid')}</p>;
  return (
    <div role="alert" data-layout-validation={validation.code} className={cn(noticeClass, 'border-danger/30 bg-danger/10 text-danger')}>
      <p>{message}</p>
      {jumpLabel && (
        <button type="button" onClick={onJump} className="mt-1 text-xs underline hover:no-underline">
          {jumpLabel}
        </button>
      )}
    </div>
  );
}

function StructuralList({ layout, onEdit }: { layout: PolicyLayout; onEdit: (fn: () => PolicyLayout) => void }) {
  const t = useTranslations('policyEditor.layoutTab');
  const structural = layout.spans.flatMap((span, index) => ('text' in span ? [] : [{ index, span }]));
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-fg">{t('structuralList')}</h3>
      {structural.length === 0 ? (
        <p className="text-xs text-fg-subtle">{t('structuralEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {structural.map(({ index, span }) => (
            <li key={index} className="flex items-center gap-2" data-layout-structural-row={index}>
              {/* JSON 形式让空白与换行可见 */}
              <code className="max-w-[8rem] shrink-0 truncate rounded bg-bg-subtle px-1 font-mono text-xs" title={span.canonical}>
                {JSON.stringify(span.canonical)}
              </code>
              <input
                type="text"
                value={span.display}
                placeholder={t('displayPlaceholder')}
                aria-label={t('displayInputLabel', { canonical: span.canonical })}
                onChange={(e) => onEdit(() => setStructuralDisplay(layout, index, e.target.value))}
                className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1 font-mono text-xs text-fg"
              />
              <button type="button" className={buttonClass} onClick={() => onEdit(() => unmarkStructuralSpan(layout, index))}>
                {t('unmark')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
