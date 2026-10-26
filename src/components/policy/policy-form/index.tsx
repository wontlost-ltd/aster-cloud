/**
 * PolicyForm — shared editor shell for /policies/new and
 * /policies/[id]/edit.
 *
 * ============================================================
 * SECURITY MODEL — do not break this invariant.
 * ============================================================
 *
 * VALIDATE (real-time editor feedback):
 *   Runs entirely client-side via @aster-cloud/aster-lang-ts's
 *   `validateSyntaxWithSpan()` (see use-compile.ts). Source never
 *   leaves the browser; diagnostics paint as Monaco markers in
 *   the same tick. Cost: zero network, zero MITM surface.
 *
 * EXECUTE (any "Run" / "Test" button reachable from the dashboard):
 *   MUST POST to /api/policies/[id]/execute and pass only the
 *   `input` payload. The backend resolves the policy SOURCE by id
 *   from Postgres / the policy KV cache. The current source the
 *   user has typed but not saved is irrelevant — only persisted,
 *   ownership-checked content is ever interpreted.
 *
 * NEVER, from inside this form (or any other dashboard surface):
 *   - POST the editor buffer to /api/policies/evaluate-source
 *   - POST the editor buffer to /api/policies/[id]/execute as a
 *     `source` field
 *   - Pipe the editor buffer into ANY runtime path
 *
 * Why this matters:
 *   1. MITM hardening — even if a browser session is hijacked,
 *      what runs in prod is whatever's in the database, not what
 *      the attacker injects mid-flight.
 *   2. Mental-model contract — when a dashboard user clicks Run,
 *      they expect the result to match the version they last
 *      saved. Silently substituting the editor buffer creates
 *      ghost behavior the version history won't explain.
 *   3. Audit chain — DB-resolved execution is what the policy
 *      version table + executions log are keyed against. Source-
 *      from-buffer execution would orphan the audit trail.
 *
 * The /api/policies/evaluate-source endpoint *exists* (and is
 * actively promoted in aster-lang-dev's quickstart docs) for
 * developer experimentation — "no need to CREATE a policy first."
 * That is a separate, deliberate dev-experience API protected by
 * HMAC + InternalCallerFilter + login session. It is correct for
 * curl + SDKs. It is wrong for the dashboard editor.
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type { editor } from 'monaco-editor';
import { nextTemplateName } from './template-name';
// `next/link` (not the next-intl variant) because every caller of
// this component passes locale-prefixed paths via `cancelHref` /
// `detailHrefFor`, and the in-component `<Link href={`/${uiLocale}/billing`} />`
// for upgrade hints also pre-prefixes. Using next-intl's Link would
// double-prepend the locale and produce 404 URLs like /zh/zh/policies
// on prefetch.
import Link from 'next/link';
import { CLIENT_CAPABILITIES } from '@/hooks/use-deployment-mode';
import {
  Breadcrumbs,
  Container,
  PageHeader,
  buttonVariants,
  cn,
} from '@/components/ui';
import { ConfirmDialog } from '@/components/ui';
import { normalizeLocale } from '@/data/policy-examples';

import { SidePanel, type SidePanelTab } from './side-panel';
import { useAiWorkspace } from '@/components/ai-workspace-context';
import { StatusBar } from './status-bar';
import { useAiInlineCompletion } from '@/lib/preferences/ai-inline-completion';
import { usePolicyDraft, type PolicyDraftFields } from './use-policy-draft';
import { useUnsavedWarning } from './use-unsaved-warning';
import { usePolicyShortcuts } from './use-policy-shortcuts';
import { useIsMobile } from './use-is-mobile';
import { useFitViewportHeight } from './use-fit-viewport-height';
import { useSuppressLauncherSafeArea } from '@/components/assistant/assistant-context';
import { EditorPalette } from './editor-palette';
import { EditorRail } from './editor-rail';
import { CNLSyntaxConverterDialog } from '@/components/policy/cnl-syntax-converter-dialog';
import { type PolicyExample, getExampleSource } from '@/data/policy-examples';
import { extractReservedAliasSets, getLexicon } from '@/lib/aster-lexicon';
import { validateUserAliases } from '@/lib/policy-alias-shared';
import { useAliasIssueMessage } from '@/components/policy/use-alias-issue-message';
import { localizedErrorMessage } from '@/lib/api/localized-error-message';

// 类型-only 导入（不拉入 Monaco 重包；运行时组件仍走下方 dynamic）。
import type { EditorCompileState } from '@/components/policy/monaco-policy-editor';

const MonacoPolicyEditor = dynamic(
  () =>
    import('@/components/policy/monaco-policy-editor').then(
      (mod) => mod.MonacoPolicyEditor,
    ),
  {
    ssr: false,
    loading: () => (
      <div
        className="flex h-full min-h-[clamp(300px,50vh,500px)] items-center justify-center rounded-lg bg-bg-muted text-sm text-fg-subtle"
        role="status"
        aria-label="Loading editor"
      >
        Loading editor…
      </div>
    ),
  },
);

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type PolicyFormMode = 'create' | 'edit';

export type PolicyFormInitialFields = PolicyDraftFields;

export interface PolicySaveResult {
  /** Saved policy id — used to navigate to detail on "save and view". */
  id: string;
}

export interface PolicySaveError {
  message: string;
  code?: string;
  diagnostics?: Array<{
    severity?: 'error' | 'warning' | 'info' | 'hint';
    code?: string;
    message?: string;
    startLine?: number;
    startColumn?: number;
    endLine?: number;
    endColumn?: number;
  }>;
  /** Backend signalled the user should upgrade their plan. */
  upgrade?: boolean;
}

export interface PolicyFormProps {
  mode: PolicyFormMode;
  uiLocale: string;
  /** Existing policy id when editing; null for create. */
  policyId: string | null;
  /** Seed values for the form. */
  initial: PolicyFormInitialFields;
  /** Mode-specific page title. */
  title: string;
  subtitle: string;
  /** Persist the policy. Must throw / return error on failure. */
  onSave: (
    fields: PolicyDraftFields,
  ) => Promise<PolicySaveResult | PolicySaveError>;
  /** Where to navigate on Cancel. */
  cancelHref: string;
  /** Detail-page href builder for "save and view" navigation. */
  detailHrefFor: (id: string) => string;
  /** Breadcrumb trail for the top bar. */
  breadcrumbs: Array<{ label: string; href?: string }>;
  /** Whether this user may configure structural keyword aliases. */
  allowStructuralAliases?: boolean;
}

/* ------------------------------------------------------------------ */
/* PolicyForm                                                          */
/* ------------------------------------------------------------------ */

export function PolicyForm({
  mode,
  uiLocale,
  policyId,
  initial,
  title,
  subtitle,
  onSave,
  cancelHref,
  detailHrefFor,
  breadcrumbs,
  allowStructuralAliases = false,
}: PolicyFormProps) {
  const router = useRouter();
  const t = useTranslations('policies.form');
  const tCommon = useTranslations('common');
  const aliasIssueMessage = useAliasIssueMessage();
  const cnlLocale = normalizeLocale(uiLocale);
  // dashboard layout 下发的 AI 工作台开关；null 时「AI」tab 保持原面板。
  const aiWorkspace = useAiWorkspace();
  // Mobile users (< md) are here to review, not to author CNL —
  // swap Monaco for a read-only viewer so the page is usable on
  // phones without dragging in the editor's keyboard + completion
  // surface.
  const isMobile = useIsMobile();

  // ---------------------------------------------------------------
  // Form fields
  // ---------------------------------------------------------------
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [content, setContent] = useState(initial.content);
  const autoTemplateName = useRef<string | null>(null);
  const [isPublic, setIsPublic] = useState(initial.isPublic);
  const [groupId, setGroupId] = useState<string | null>(initial.groupId);
  const [aliasSet, setAliasSet] = useState<Record<string, string[]>>(
    initial.aliasSet ?? {},
  );
  const fields: PolicyDraftFields = useMemo(
    () => ({
      name,
      description,
      content,
      isPublic,
      groupId,
      aliasSet: Object.keys(aliasSet).length > 0 ? aliasSet : null,
    }),
    [name, description, content, isPublic, groupId, aliasSet],
  );

  // ---------------------------------------------------------------
  // UI state
  // ---------------------------------------------------------------
  const [sidePanelOpen, setSidePanelOpen] = useState(mode === 'create');
  const aiInlineCompletion = useAiInlineCompletion();
  const [requestedTab, setRequestedTab] = useState<SidePanelTab | undefined>(
    mode === 'create' ? 'settings' : undefined,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [serverError, setServerError] = useState<PolicySaveError | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  // 点击模板整体替换编辑器内容时，若已有内容先弹确认，避免误抹未保存草稿。
  const [pendingTemplate, setPendingTemplate] = useState<PolicyExample | null>(
    null,
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [converterOpen, setConverterOpen] = useState(false);

  // Editor instance is captured imperatively. We also hold a state
  // boolean so child hooks (markers, jump-to-line) re-run after
  // monaco's async onMount — refs alone won't trigger a re-render.
  const editorInstanceRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  // 保留 ready 布尔：onMount 是异步的，翻转它触发一次 re-render，让依赖 editor 实例的
  // 子组件（SidePanel / palette）在挂载后拿到实例（ref 变化本身不触发 re-render）。
  const [, setEditorReady] = useState(false);

  // ---------------------------------------------------------------
  // Compile-on-type —— 单一真相源
  // ---------------------------------------------------------------
  // 编译诊断由 MonacoPolicyEditor 内部的 useAsterCompiler（完整 parse+typecheck，别名感知，
  // 且自己画 Monaco 红波浪线）统一产出并经 onCompileChange 上抛。父层不再跑第二遍 parse-only
  // 编译（原 useCompile）——消除每次按键的双重解析、双份 Problems 面板、双份红波浪线，并根除
  // 两条管线的 aliasSet 不同步（编辑器 footer 曾误报解析错误的根因）。StatusBar/SidePanel 直接
  // 消费这份诊断；typecheck 覆盖比原 parse-only 更全（含类型/降级/PII 错误），且 module 摘要
  // 现在能真正填充（原 useCompile 永远返回 undefined，Decision 面板的 module 块从不渲染）。
  const [compile, setCompile] = useState<EditorCompileState & { transportError?: string }>({
    state: 'idle',
    diagnostics: [],
  });
  const reservedSets = useMemo(
    () => extractReservedAliasSets(getLexicon(cnlLocale)),
    [cnlLocale],
  );
  const compileErrorCount = useMemo(
    () => compile.diagnostics.filter((d) => d.severity === 'error').length,
    [compile.diagnostics],
  );

  const openSidePanel = useCallback((tab: SidePanelTab) => {
    setRequestedTab(tab);
    setSidePanelOpen(true);
  }, []);

  // 工作区高度按实际顶边填满首屏（上方横幅、换行等变化由 hook 自动重测）。
  // reserve = 状态栏（约 30px）+ 间距 12px + 底部留白，保证状态栏同在视口内。
  const workbenchRef = useRef<HTMLDivElement>(null);
  const workbenchHeight = useFitViewportHeight(workbenchRef, { min: 560, max: 900, reserve: 64 });
  // 编辑器已按视口填满首屏、状态栏自行给悬浮按钮让位：页面末尾不需要按钮安全区，否则整页会多滚一段。
  useSuppressLauncherSafeArea(true);
  const previousErrorCountRef = useRef(0);
  useEffect(() => {
    if (compileErrorCount > 0 && previousErrorCountRef.current === 0) {
      openSidePanel('problems');
    }
    previousErrorCountRef.current = compileErrorCount;
  }, [compileErrorCount, openSidePanel]);

  // ---------------------------------------------------------------
  // Editor command helpers
  // ---------------------------------------------------------------

  /** Insert a text snippet at the current cursor (or replace selection). */
  const insertAtCursor = useCallback((snippet: string) => {
    const ed = editorInstanceRef.current;
    if (!ed) {
      // No editor yet — fall back to appending. Rare edge: palette
      // opened before onMount completed.
      setContent((prev) => (prev ? prev + '\n' + snippet : snippet));
      return;
    }
    const selection = ed.getSelection();
    const range = selection ?? {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    };
    ed.executeEdits('aster.insert-snippet', [
      {
        range,
        text: snippet,
        forceMoveMarkers: true,
      },
    ]);
    ed.focus();
  }, []);

  /** Insert a template at the cursor (or replace selection). Sets a
   *  default name only when the name field is empty so we don't
   *  clobber whatever the user already typed. */
  const insertTemplateAtCursor = useCallback(
    (tpl: PolicyExample) => {
      const body = getExampleSource(tpl, cnlLocale);
      insertAtCursor(body);
      setName((prev) => prev || tpl.id);
      toast.success(t('templateInsertedAtCursor'));
    },
    [cnlLocale, insertAtCursor, t],
  );

  /** 用模板内容整体替换编辑器（清空后写入），非插入到光标。设默认名称仅在
   *  名称为空时，避免覆盖用户已填内容。侧栏「模板」tab 走此路径。 */
  const applyTemplateReplace = useCallback(
    (tpl: PolicyExample) => {
      const body = getExampleSource(tpl, cnlLocale);
      // setContent 是编辑器内容的唯一真相源（Monaco 受控于 value），直接整体
      // 替换即清空并写入模板；无需先手动清空。
      setContent(body);
      const previousAutoName = autoTemplateName.current;
      setName((prev) => nextTemplateName(prev, previousAutoName, tpl.id));
      autoTemplateName.current = tpl.id;
      toast.success(t('templateReplaced'));
    },
    [cnlLocale, t],
  );

  /** 侧栏「模板」tab 点击入口：编辑器有内容先弹确认（防误抹未保存草稿），
   *  为空则直接替换。 */
  const requestTemplateReplace = useCallback(
    (tpl: PolicyExample) => {
      if (content.trim().length > 0) {
        setPendingTemplate(tpl);
      } else {
        applyTemplateReplace(tpl);
      }
    },
    [content, applyTemplateReplace],
  );

  /** Trigger Monaco's built-in format-document action. */
  const formatDocument = useCallback(() => {
    const ed = editorInstanceRef.current;
    if (!ed) return;
    void ed.getAction('editor.action.formatDocument')?.run();
  }, []);

  // ---------------------------------------------------------------
  // Draft persistence
  // ---------------------------------------------------------------
  const {
    isDirty,
    lastSavedAt,
    pendingDraft,
    acceptPendingDraft,
    discardPendingDraft,
    clearDraft,
  } = usePolicyDraft({
    policyId,
    fields,
    baseline: initial,
  });

  useUnsavedWarning(isDirty && !isSaving);

  // Show the restore-draft toast at most once, after the form mounts.
  // sonner is mounted at the locale-layout level (see [locale]/layout.tsx)
  // so we can call it here without any provider plumbing.
  const restorePromptedRef = useRef(false);
  useEffect(() => {
    if (restorePromptedRef.current) return;
    if (!pendingDraft) return;
    restorePromptedRef.current = true;
    const id = toast(t('draftRestoreTitle'), {
      description: t('draftRestoreBody', { time: 'recently' }),
      duration: 10_000,
      action: {
        label: t('draftRestore'),
        onClick: () => {
          setName(pendingDraft.name);
          setDescription(pendingDraft.description);
          setContent(pendingDraft.content);
          setIsPublic(pendingDraft.isPublic);
          setGroupId(pendingDraft.groupId);
          setAliasSet(pendingDraft.aliasSet ?? {});
          acceptPendingDraft();
        },
      },
      cancel: {
        label: t('draftDiscard'),
        onClick: () => {
          discardPendingDraft();
        },
      },
    });
    return () => {
      // If the user navigates away before responding, dismiss the toast.
      toast.dismiss(id);
    };
  }, [pendingDraft, t, acceptPendingDraft, discardPendingDraft]);

  // ---------------------------------------------------------------
  // Save handlers
  // ---------------------------------------------------------------

  /** Validate; return true if save can proceed. */
  const validate = useCallback((): boolean => {
    if (name.trim().length === 0) {
      setNameError(t('nameRequired'));
      openSidePanel('settings');
      return false;
    }
    setNameError(null);
    const aliasValidation = validateUserAliases(aliasSet, reservedSets, {
      allowStructural: allowStructuralAliases,
    });
    if (!aliasValidation.valid) {
      // 跨 kind 重复等整体问题不能静默拦截：打开别名面板并给出首条问题的本地化说明。
      openSidePanel('aliases');
      toast.error(t('aliasesInvalidBeforeSaving'), {
        description: aliasIssueMessage(aliasValidation.issues[0]),
      });
      return false;
    }
    // 有解析/编译错误的策略不允许保存——落库不可编译的源码会污染版本链，
    // 且执行时必然失败。此门禁是**唯一生效的门禁**：编译由客户端 alias-aware
    // 编译器（useAsterCompiler）即时完成，compileErrorCount 已别名感知。
    // 注：后端 defense-in-depth 尚缺——aster-api 无 raw-source compile 端点
    // （/api/v1/policies/compile 实测 404，只有按 module.function 名的 /validate），
    // 故 API 直调目前仍可绕过。补齐需 aster-api 先加源码编译端点（独立工作）。
    // idle=空策略/未编译允许保存（空策略合法）。
    if (compileErrorCount > 0) {
      openSidePanel('problems');
      toast.error(t('parseErrorsBeforeSaving'));
      return false;
    }
    // pending=编译中（非空源码，debounce 未跑完）：此刻 compileErrorCount 可能
    // 还是旧值（0），直接保存会漏过刚引入的错误。非空内容编译未定论前不放行，
    // 提示稍候。空源码走 idle 分支不受影响。
    if (compile.state === 'pending' && content.trim().length > 0) {
      toast.error(t('checkingSyntax'));
      return false;
    }
    return true;
  }, [
    name,
    t,
    aliasSet,
    reservedSets,
    allowStructuralAliases,
    aliasIssueMessage,
    compileErrorCount,
    compile.state,
    content,
    openSidePanel,
  ]);

  /** Submit. Optional callback to fire on success (e.g. navigate). */
  const handleSubmit = useCallback(
    async (afterSave?: (id: string) => void): Promise<void> => {
      if (!validate()) return;
      if (isSaving) return;
      setIsSaving(true);
      setServerError(null);
      try {
        const result = await onSave(fields);
        if ('message' in result) {
          setServerError(result);
          const diagnostics = (result.diagnostics ?? []).filter(
            (diagnostic) => diagnostic.severity === 'error',
          );
          if (result.code === 'alias_invalid') {
            // 服务端别名校验失败（如授权已撤销）：原文是中文诊断，按错误码本地化并引导到别名面板。
            openSidePanel('aliases');
            toast.error(t('saveFailed'), { description: t('saveErrorCodes.alias_invalid') });
          } else if (diagnostics.length > 0) {
            openSidePanel('problems');
            const first = diagnostics[0];
            toast.error(t('saveFailedWithDiagnostics', {
              count: diagnostics.length,
              line: first.startLine ?? 1,
              message: first.message ?? t('saveDiagnosticFallback'),
            }));
          } else {
            toast.error(t('saveFailed'), {
              description: localizedErrorMessage(result.code, {
                compile_error: t('saveErrorCodes.compile_error'),
                compile_unavailable: t('saveErrorCodes.compile_unavailable'),
                policy_frozen: t('saveErrorCodes.policy_frozen'),
                unauthorized: t('saveErrorCodes.unauthorized'),
                unsupported_locale: t('saveErrorCodes.unsupported_locale'),
              }, result.message),
            });
          }
          return;
        }
        toast.success(t('saveSuccess'));
        clearDraft();
        afterSave?.(result.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : t('saveFailed');
        setServerError({ message });
        toast.error(t('saveFailed'), { description: message });
      } finally {
        setIsSaving(false);
      }
    },
    [validate, isSaving, onSave, fields, clearDraft, t, openSidePanel],
  );

  const onSaveOnly = useCallback(
    () => handleSubmit((id) => router.push(detailHrefFor(id))),
    [handleSubmit, router, detailHrefFor],
  );

  // ⌘Enter — save and view (same nav as create-mode default).
  const onSaveAndView = useCallback(
    () => handleSubmit((id) => router.push(detailHrefFor(id))),
    [handleSubmit, router, detailHrefFor],
  );

  // ---------------------------------------------------------------
  // Shortcuts
  // ---------------------------------------------------------------
  usePolicyShortcuts({
    onSave: onSaveOnly,
    onSaveAndView,
    onTogglePanel: () => setSidePanelOpen((v) => !v),
    onPalette: () => setPaletteOpen(true),
    isPaletteContextActive: () => {
      // Take over ⌘K whenever the editor or any element inside our
      // form is focused — otherwise the dashboard's global ⌘K (route
      // jump) still wins, which is the right call when the user is
      // browsing the dashboard surface.
      if (paletteOpen) return true;
      const ed = editorInstanceRef.current;
      if (ed && ed.hasTextFocus()) return true;
      const active = document.activeElement;
      if (active && active.closest('[data-policy-form-root]')) return true;
      return false;
    },
    onEscape: () => {
      if (paletteOpen) {
        setPaletteOpen(false);
        return;
      }
      if (sidePanelOpen) {
        setSidePanelOpen(false);
        return;
      }
      // Otherwise blur the active editable element so Esc doesn't
      // feel like a no-op.
      const el = document.activeElement;
      if (
        el &&
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
      ) {
        el.blur();
      }
    },
  });

  // ---------------------------------------------------------------
  // Cancel — soft confirm when dirty.
  // ---------------------------------------------------------------
  const handleCancelClick = (e: React.MouseEvent) => {
    if (!isDirty) return;
    e.preventDefault();
    setCancelConfirmOpen(true);
  };

  return (
    // 设计系统宽度权威：dashboard <main> 现为全宽透传，宽度+水平内边距+垂直
    // 节奏由本页 <Container> 负责。编辑器是「编辑器+schema」的全高 flex 布局，
    // 故用 xl(1280px) 给足工作区。水平内边距由 Container 统一提供，内部各分区
    // 不再各自 px-4 sm:px-6（避免双重内边距）。
    //
    // data-policy-form-root 是承载语义：usePolicyShortcuts 的
    // isPaletteContextActive 通过 closest('[data-policy-form-root]') 判定焦点
    // 是否落在本表单内，从而决定是否接管 ⌘K。必须保留在结构根上。
    <Container size="xl" data-policy-form-root className="py-6 sm:py-10">
      <div
        // Natural-flow layout (NOT a forced 100vh shell) so the
        // surrounding dashboard <main> can scroll normally. The editor
        // panel takes a fixed-ish height (clamp between 500 and 720 px
        // based on viewport) instead of trying to stretch into a flex
        // parent — that kept growing without bound when main had no
        // height ceiling, producing the "endless page" symptom.
        className="flex flex-col gap-3"
      >
        {/* ----- Top bar ----- */}
        <PageHeader
          title={title}
          subtitle={subtitle}
          breadcrumbs={<Breadcrumbs items={breadcrumbs} />}
          action={
            <div className="flex items-center gap-2">
              <Link
                href={cancelHref}
                onClick={handleCancelClick}
                className={buttonVariants({ variant: 'secondary', size: 'md' })}
              >
                {tCommon('cancel')}
              </Link>
              {/* Mobile is read-only — hide Save so users don't think
                  their typing (which can't happen) is being persisted. */}
              {!isMobile && (
                <button
                  type="button"
                  onClick={onSaveOnly}
                  // 有解析错误时禁用保存（button disabled 给即时视觉反馈），
                  // validate() 里再兜底拦截 + 跳 problems tab。
                  disabled={isSaving || compileErrorCount > 0}
                  title={
                    compileErrorCount > 0
                      ? t('parseErrorsBeforeSaving')
                      : undefined
                  }
                  className={cn(
                    buttonVariants({ variant: 'primary', size: 'md' }),
                    'gap-2',
                  )}
                >
                  {isSaving
                    ? mode === 'create'
                      ? t('creating')
                      : t('saving')
                    : mode === 'create'
                      ? t('create')
                      : t('save')}
                </button>
              )}
            </div>
          }
        />

        {/* ----- 手机只读提示 ----- */}
        {/* 窄屏下编辑器降级为只读视图、也没有保存与侧栏：明确告诉用户原因与去处，
            否则一个只有「取消」的「编辑策略」页看起来像坏了。 */}
        {isMobile && (
          <div
            role="note"
            data-testid="policy-mobile-readonly-notice"
            className="rounded-lg border border-border bg-bg-muted px-4 py-2 text-sm text-fg-muted"
          >
            {t('mobileReadOnlyNotice')}
          </div>
        )}

        {/* ----- Server error banner ----- */}
        {serverError && (
          <div
            role="alert"
            className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-2 text-sm text-danger"
          >
            {localizedErrorMessage(serverError.code, {
              alias_invalid: t('saveErrorCodes.alias_invalid'),
              compile_error: t('saveErrorCodes.compile_error'),
              compile_unavailable: t('saveErrorCodes.compile_unavailable'),
              policy_frozen: t('saveErrorCodes.policy_frozen'),
              unauthorized: t('saveErrorCodes.unauthorized'),
            }, serverError.message)}
            {serverError.upgrade && CLIENT_CAPABILITIES.billing && (
              <Link
                href={`/${uiLocale}/billing`}
                className="ml-3 underline hover:no-underline"
              >
                {t('viewPlans')}
              </Link>
            )}
          </div>
        )}

        {/* ----- IDE workbench: rail + editor + drawer ----- */}
        <div
          ref={workbenchRef}
          className="flex gap-3"
          // Meta 和别名移入抽屉后，主任务区可以吃到更多垂直空间。
          // 低于 lg 时 rail/抽屉隐藏，编辑器仍自然占满可用宽度。
          // 测量前用 CSS 估算兜底；测量后按实际顶边填满首屏，状态栏也留在视口内。
          style={{ height: workbenchHeight ?? 'clamp(560px, calc(100vh - 12rem), 900px)' }}
        >
          {!isMobile && (
            <EditorRail
              activeTab={requestedTab}
              open={sidePanelOpen}
              errorCount={compileErrorCount}
              onSelect={openSidePanel}
            />
          )}
          <div className="flex min-w-0 flex-1 flex-col rounded-xl border border-border bg-bg shadow-sm overflow-hidden">
            {isMobile ? (
              // Read-only viewer for phones. Pre-formatted text with the
              // same monospace stack Monaco uses, so syntax highlighting's
              // absence is the only visible difference. The empty-state
              // placeholder mirrors the editor's contentPlaceholder text
              // so a brand-new policy doesn't surprise the user with a
              // blank gray box.
              <pre
                className="m-0 h-full overflow-auto p-4 font-mono text-sm text-fg whitespace-pre-wrap break-words"
                aria-label={t('content')}
              >
                {content || t('contentPlaceholder')}
              </pre>
            ) : (
              <MonacoPolicyEditor
                value={content}
                onChange={setContent}
                locale={cnlLocale}
                userVocabulary
                height="100%"
                placeholder={t('contentPlaceholder')}
                aliasSet={fields.aliasSet ?? undefined}
                onEditorReady={(ed) => {
                  editorInstanceRef.current = ed;
                  // Trigger one re-render so palette / side-panel hooks
                  // depending on the editor instance can pick it up.
                  setEditorReady(true);
                }}
                onCompileChange={setCompile}
                // 用户在设置页或状态栏关闭后不再发出任何 AI 补全请求；
                // 读取本地偏好完成前按关闭处理，避免首帧按默认值误发请求。
                enableAICompletion={aiInlineCompletion.value && !aiInlineCompletion.hydrating}
                onToggleAIPanel={() => openSidePanel('ai')}
              />
            )}
          </div>
          {sidePanelOpen && !isMobile && (
            <div className="hidden w-[26rem] shrink-0 lg:flex">
              <SidePanel
                // Monaco 实例经 ref 持有；onEditorReady 里 setEditorReady 强制一次
                // 重渲染，此处正是为读到已挂载的编辑器实例传给 SidePanel（见上方
                // onEditorReady 注释）。属合法 ref 读取。
                // eslint-disable-next-line react-hooks/refs
                editor={editorInstanceRef.current}
                cnlLocale={cnlLocale}
                uiLocale={uiLocale}
                name={name}
                description={description}
                groupId={groupId}
                isPublic={isPublic}
                onNameChange={(v) => {
                  autoTemplateName.current = null;
                  setName(v);
                  if (nameError && v.trim().length > 0) setNameError(null);
                }}
                onDescriptionChange={setDescription}
                onGroupIdChange={setGroupId}
                onIsPublicChange={setIsPublic}
                nameError={nameError}
                aliasSet={aliasSet}
                reservedSets={reservedSets}
                allowStructuralAliases={allowStructuralAliases}
                onAliasSetChange={setAliasSet}
                onApplyContent={(body) => setContent(body)}
                onApplyTemplate={(tpl) => {
                  // 侧栏「模板」tab：整体替换编辑器内容（有内容先弹确认）。
                  // 命令面板的「插入到光标」保持 insertTemplateAtCursor 不变。
                  requestTemplateReplace(tpl);
                }}
                onClose={() => setSidePanelOpen(false)}
                compileState={serverError?.diagnostics?.length ? 'error' : compile.state}
                compileDiagnostics={[
                  ...compile.diagnostics,
                  ...(serverError?.diagnostics ?? []).map((diagnostic) => ({
                    severity: 'error' as const,
                    code: diagnostic.code,
                    message: diagnostic.message ?? t('saveDiagnosticFallback'),
                    startLine: diagnostic.startLine ?? 1,
                    startColumn: diagnostic.startColumn ?? 1,
                    endLine: diagnostic.endLine ?? diagnostic.startLine ?? 1,
                    endColumn: diagnostic.endColumn ?? diagnostic.startColumn ?? 1,
                  })),
                ]}
                compileModule={compile.module}
                onJumpToLine={(line, column) => {
                  const ed = editorInstanceRef.current;
                  if (!ed) return;
                  ed.revealLineInCenter(line);
                  ed.setPosition({ lineNumber: line, column });
                  ed.focus();
                }}
                initialTab={requestedTab}
                policyId={policyId}
                aiWorkspace={aiWorkspace}
              />
            </div>
          )}
        </div>

        {/* ----- Status bar ----- */}
        <StatusBar
          content={content}
          cnlLocale={cnlLocale}
          isDirty={isDirty}
          lastSavedAt={lastSavedAt}
          compileState={compile.state}
          compileDiagnostics={compile.diagnostics}
          compileTransportError={compile.transportError}
          onCompileChipClick={() => openSidePanel('problems')}
          aiCompletion={{
            enabled: aiInlineCompletion.value,
            hydrating: aiInlineCompletion.hydrating,
            onToggle: () => aiInlineCompletion.setValue(!aiInlineCompletion.value),
          }}
        />

        {/* ----- Editor command palette ----- */}
        <EditorPalette
          isOpen={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          uiLocale={uiLocale}
          onAskAI={() => openSidePanel('ai')}
          onInsertTemplate={insertTemplateAtCursor}
          onConvertLocale={() => setConverterOpen(true)}
          onFormat={formatDocument}
          onSave={onSaveOnly}
          onSaveAndView={onSaveAndView}
          onTogglePanel={() => setSidePanelOpen((v) => !v)}
          onShowSyntax={() => openSidePanel('syntax')}
          onShowDecision={() => openSidePanel('problems')}
        />

        {/* ----- CNL locale converter dialog ----- */}
        <CNLSyntaxConverterDialog
          isOpen={converterOpen}
          onClose={() => setConverterOpen(false)}
          content={content}
          currentLocale={cnlLocale}
          uiLocale={uiLocale}
          onApply={(converted) => {
            setContent(converted);
          }}
        />

        {/* ----- Cancel confirmation ----- */}
        <ConfirmDialog
          isOpen={cancelConfirmOpen}
          title={t('unsavedLeaveWarning')}
          description=""
          confirmLabel={tCommon('cancel')}
          cancelLabel={t('keepEditing')}
          variant="warning"
          onCancel={() => setCancelConfirmOpen(false)}
          onConfirm={() => {
            // Wipe draft so we don't re-offer to restore what the
            // user explicitly chose to discard.
            clearDraft();
            router.push(cancelHref);
          }}
        />

        {/* ----- Template overwrite confirmation ----- */}
        {/* 模板覆盖已有内容前先确认，避免误删未保存的编辑。 */}
        <ConfirmDialog
          isOpen={pendingTemplate !== null}
          title={t('templateReplaceTitle')}
          description={t('templateReplaceDescription')}
          confirmLabel={t('replace')}
          cancelLabel={tCommon('cancel')}
          variant="warning"
          onCancel={() => setPendingTemplate(null)}
          onConfirm={() => {
            if (pendingTemplate) applyTemplateReplace(pendingTemplate);
            setPendingTemplate(null);
          }}
        />
      </div>
    </Container>
  );
}
