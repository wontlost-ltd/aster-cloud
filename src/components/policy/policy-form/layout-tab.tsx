'use client';

/**
 * 编辑器侧栏「排版」标签页（ADR 0058 §7.4–7.6，计划 T10，裁决 R11 / R12）。只在 structured_authoring 为真时挂载。
 *
 * Monaco 仍是唯一的 canonical 编辑器；这里只做「从 canonical 切分 + 改 display」：
 * - 源码超出 §7.6 上限：不提供任何入口，只说明原因与上限值；
 * - 无排版：「开始排版」（恒等排版）或「导入 JSON」；
 * - 源码改动后排版失效：不自动重排，只给「从恒等排版重新开始」「移除排版」（R12）；
 * - 有效排版：结构片段列表、把编辑器选区标为结构、并排视图开关，以及与保存同一实现的实时校验。
 * 排版状态由 PolicyForm 持有（LayoutDraft），经 PolicySaveContext 交给保存，不进 localStorage 草稿（R13）。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { editor as MonacoEditor } from 'monaco-editor';
import {
  LAYOUT_LIMITS,
  LayoutError,
  parseLayout,
  toCanonical,
  validatePolicyLayout,
  type LayoutValidation,
  type PolicyLayout,
} from '@aster-cloud/aster-lang-ts/layout';
import { cn } from '@/components/ui';
import { getLexicon } from '@/lib/aster-lexicon';
import {
  identityLayout,
  layoutEditErrorCode,
  markStructural,
  offsetAt,
  positionAt,
  setStructuralDisplay,
  sourceLayoutLimitExceeded,
  unmarkStructural,
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

export function LayoutTab({
  editor,
  source,
  cnlLocale,
  aliasSet,
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

  const limitExceeded = useMemo(() => sourceLayoutLimitExceeded(source), [source]);
  const matchesSource = layout !== null && toCanonical(layout) === source;

  // 实时校验：与保存接口同一实现（包的 validatePolicyLayout），按版本 locale 的词法表 + 当前别名；防抖后执行
  useEffect(() => {
    if (!layout || !matchesSource) return;
    const timer = setTimeout(() => {
      const result = validatePolicyLayout(layout, source, getLexicon(cnlLocale), aliasSet ?? undefined);
      setChecked({ layout, source, result });
    }, LAYOUT_VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [layout, matchesSource, source, cnlLocale, aliasSet]);
  const validation = checked && checked.layout === layout && checked.source === source ? checked.result : null;

  const edit = (fn: () => PolicyLayout) => {
    try {
      onChange({ kind: 'edited', layout: fn() });
      setOpError(null);
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
          <button type="button" className={buttonClass} aria-pressed={sideBySide} onClick={() => onSideBySideChange(!sideBySide)}>
            {t('sideBySide')}
          </button>
          <button type="button" className={buttonClass} onClick={() => onChange({ kind: 'removed' })}>{t('remove')}</button>
        </div>
        <p className="text-xs text-fg-subtle">{t('sideBySideNote')}</p>
        {opError && <p role="alert" className="text-xs text-danger">{t(`opErrors.${opError}`)}</p>}
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
      <p className="text-xs text-fg-muted">{t('hint')}</p>
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
              <button type="button" className={buttonClass} onClick={() => onEdit(() => unmarkStructural(layout, index))}>
                {t('unmark')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
