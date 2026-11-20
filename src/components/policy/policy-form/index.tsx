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
import { detectLocaleMismatch, resolveEditorCnlLocale } from './policy-cnl-locale';

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
import type { StructuredAuthoringProps } from '@/lib/capabilities/types';
import { StarterHint } from './starter-hint';
import { CNLSyntaxConverterDialog } from '@/components/policy/cnl-syntax-converter-dialog';
import { type PolicyExample, getExampleSource, hasTemplateExtras } from '@/data/policy-examples';
import { trackProductEvent } from '@/lib/product-events/client';
import { extractReservedAliasSets, getLexicon } from '@/lib/aster-lexicon';
import { validateUserAliases } from '@/lib/policy-alias-shared';
import { useAliasIssueMessage } from '@/components/policy/use-alias-issue-message';
import { localizedErrorMessage } from '@/lib/api/localized-error-message';
import { displayToCanonical, toCanonical, type PolicyLayout } from '@aster-cloud/aster-lang-ts/layout';
import { offsetAt, offsetAtClamped, positionAt, projectCanonicalRange } from '@/lib/policy-layout/edit-ops';
import { LayoutDisplayView, type LayoutDisplayMarker } from '@/components/policy/layout/layout-display-view';
import { LayoutTab, type LayoutDraft } from './layout-tab';
import { isLayoutSaveErrorCode, useLayoutErrorText } from './layout-error-text';
import {
  storedEmbeddedVocabulary,
  type EmbeddedVocabulary,
  type ShadowedTerm as EmbeddedShadowedTerm,
} from '@/lib/policy-embedded-vocabulary';
import { embeddedVocabularyErrorCode } from './embedded-vocabulary-editor';

/** 内嵌词汇保存错误码的前缀（ADR 0060 §6.4，五个码都以它开头）。 */
const EMBEDDED_VOCABULARY_ERROR_PREFIX = 'embedded_vocabulary_';
const isEmbeddedVocabularyErrorCode = (code: string | undefined): code is string =>
  typeof code === 'string' && code.startsWith(EMBEDDED_VOCABULARY_ERROR_PREFIX);

/** 保存时作者词汇非法的错误码（与服务端 policy-compile-response 一致）。 */
const VOCABULARY_SCOPE_INVALID_CODE = 'vocabulary_scope_invalid';

/** 未传 structuredAuthoring 时的默认值：无权，侧栏与接入前一致。 */
const STRUCTURED_AUTHORING_DENIED: StructuredAuthoringProps = { allowed: false, sources: [] };

// 类型-only 导入（不拉入 Monaco 重包；运行时组件仍走下方 dynamic）。
import type { VocabularyTabTerm } from '@/hooks/useUserVocabularyRegistration';
import type { EditorCompileState, EditorLspHandle } from '@/components/policy/monaco-policy-editor';
import type { StructuredAuthoringPaletteActions } from './editor-palette';

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

// 词汇规范预览窗格同样内嵌只读 Monaco，按需加载且不参与 SSR。
const CanonicalPreviewPane = dynamic(
  () => import('./canonical-preview-pane').then((mod) => mod.CanonicalPreviewPane),
  { ssr: false },
);

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type PolicyFormMode = 'create' | 'edit';

export type PolicyFormInitialFields = PolicyDraftFields;

export type { LayoutDraft } from './layout-tab';

export interface PolicySaveResult {
  /** Saved policy id — used to navigate to detail on "save and view". */
  id: string;
  /** 新版本没有沿用上一版本的显示排版（ADR 0058 §7.5）。 */
  layoutDropped?: boolean;
  /** 被本策略内嵌词条遮蔽、在这条策略里不生效的团队 / 个人词条（保存响应 vocabularyShadowed）。 */
  vocabularyShadowed?: EmbeddedShadowedTerm[];
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
  /** vocabulary_scope_invalid：引擎错误码（如 field_parent_required）。 */
  reason?: string;
  /** vocabulary_scope_invalid：出错词条的写法。 */
  term?: string;
  /** vocabulary_scope_invalid：出错词条的种类（field / enum_value / literal）。 */
  kind?: string;
  /** layout 错误码：canonical 源码中的 UTF-16 偏移。 */
  offset?: number;
  /** layout_too_large：超出的上限名。 */
  limit?: string;
}

/** 保存时随字段一起提交的上下文。 */
export interface PolicySaveContext {
  /** 策略的 CNL 语言（规范标签），作为保存请求的 locale 提交，见 policy-cnl-locale。 */
  locale: string;
  /**
   * 显示排版的三态（ADR 0058 §7.5，裁决 R13）：缺省 = 请求体省略 layout（服务端按规则沿用），
   * null = 不带，对象 = 提交该排版。不进 localStorage 草稿。
   */
  layout?: PolicyLayout | null;
  /**
   * 策略内嵌词汇的三态（ADR 0060 §6.5，与 aliasSet 同一路由规则）：缺省 = 请求体省略（PUT 沿用活跃版本），
   * null = 清空，对象 = 提交该词汇。只有内容与活跃版本不同（规范序列化比较）时才出现。
   */
  embeddedVocabulary?: EmbeddedVocabulary | null;
}

export interface PolicyFormProps {
  mode: PolicyFormMode;
  uiLocale: string;
  /**
   * 已记录的策略 CNL 语言（编辑时由服务端按活跃版本解析）；新建为 null/缺省。
   * 编辑器展示与保存都用策略语言而非界面语言，判定见 policy-cnl-locale。
   */
  policyCnlLocale?: string | null;
  /** Existing policy id when editing; null for create. */
  policyId: string | null;
  /** Seed values for the form. */
  initial: PolicyFormInitialFields;
  /**
   * 新建时 initial.content 是按界面语言预填的入门模板（见 @/config/aster-policy-templates）。
   * 入门模板未改动时显示入门提示条（含「从空白开始」），且 AI 生成不把它当用户源码。
   */
  starter?: boolean;
  /** Mode-specific page title. */
  title: string;
  subtitle: string;
  /** Persist the policy. Must throw / return error on failure. */
  onSave: (
    fields: PolicyDraftFields,
    context: PolicySaveContext,
  ) => Promise<PolicySaveResult | PolicySaveError>;
  /** Where to navigate on Cancel. */
  cancelHref: string;
  /** Detail-page href builder for "save and view" navigation. */
  detailHrefFor: (id: string) => string;
  /** Breadcrumb trail for the top bar. */
  breadcrumbs: Array<{ label: string; href?: string }>;
  /** Whether this user may configure structural keyword aliases. */
  allowStructuralAliases?: boolean;
  /** 结构化编写能力的服务端判定结果；缺省视为无权（编辑器与接入前一致）。 */
  structuredAuthoring?: StructuredAuthoringProps;
  /** 当前用户不能切换公开状态（团队策略只有 owner/admin 可以，ADR 0016）。 */
  visibilityLocked?: boolean;
  /** 团队策略所属团队：编辑器按团队词汇 + 作者词汇编译（ADR 0017）。 */
  teamId?: string | null;
  /** 活跃版本复验通过的显示排版；只在能力为真时由编辑页下发（ADR 0058 §7.4）。 */
  initialLayout?: PolicyLayout | null;
  /** 活跃版本有排版行但复验不一致、未加载。 */
  initialLayoutInconsistent?: boolean;
  /** 活跃版本带显示排版（与能力无关，保存前的丢弃提示要用）。 */
  hasActiveLayout?: boolean;
}

/* ------------------------------------------------------------------ */
/* PolicyForm                                                          */
/* ------------------------------------------------------------------ */

export function PolicyForm({
  mode,
  uiLocale,
  policyCnlLocale = null,
  policyId,
  initial,
  starter = false,
  title,
  subtitle,
  onSave,
  cancelHref,
  detailHrefFor,
  breadcrumbs,
  allowStructuralAliases = false,
  structuredAuthoring = STRUCTURED_AUTHORING_DENIED,
  visibilityLocked = false,
  teamId = null,
  initialLayout = null,
  initialLayoutInconsistent = false,
  hasActiveLayout = false,
}: PolicyFormProps) {
  const router = useRouter();
  const t = useTranslations('policies.form');
  const tCommon = useTranslations('common');
  const tEditor = useTranslations('policyEditor');
  const tTerms = useTranslations('policyEditor.embeddedTerms');
  const layoutErrorText = useLayoutErrorText();
  const aliasIssueMessage = useAliasIssueMessage();
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
  // 策略内嵌词汇（ADR 0060）：embedded 是表单当前值，savedEmbedded 是活跃版本的值（保存成功后更新）。
  // 二者规范序列化相同即「未改动」，保存时省略字段；只有结构化编写能力的作者能改动它。
  const [embedded, setEmbedded] = useState<EmbeddedVocabulary | null>(initial.embeddedVocabulary ?? null);
  const [savedEmbedded, setSavedEmbedded] = useState<EmbeddedVocabulary | null>(initial.embeddedVocabulary ?? null);
  // 策略的 CNL 语言（#627）：状态栏、别名规范拼写、编辑器词法与保存 locale 共用，不跟随界面语言，
  // 且与执行端同一判定（见 policy-cnl-locale）。chosenCnlLocale 是用户显式切换或语言转换后的选择。
  // 模板与语法参考只有 en/zh/de 三套，按 exampleLocale 取。
  const [chosenCnlLocale, setChosenCnlLocale] = useState<string | null>(null);
  const cnlLocale = useMemo(
    () => resolveEditorCnlLocale({ chosen: chosenCnlLocale, resolved: policyCnlLocale, content, uiLocale }),
    [chosenCnlLocale, policyCnlLocale, content, uiLocale],
  );
  const exampleLocale = normalizeLocale(cnlLocale);
  // 源码看起来是另一种语言：只提示、由用户决定是否切换，不静默改变编译/执行所用的语言。
  const mismatchedLocale = useMemo(() => detectLocaleMismatch(cnlLocale, content), [cnlLocale, content]);
  const fields: PolicyDraftFields = useMemo(
    () => ({
      name,
      description,
      content,
      isPublic,
      groupId,
      aliasSet: Object.keys(aliasSet).length > 0 ? aliasSet : null,
      embeddedVocabulary: embedded && embedded.terms.length > 0 ? embedded : null,
    }),
    [name, description, content, isPublic, groupId, aliasSet, embedded],
  );
  // 内嵌词汇在保存请求里的三态：与活跃版本相同 → 省略；改空 → null；否则提交对象
  const embeddedSaveField = useMemo((): EmbeddedVocabulary | null | undefined => {
    // 无结构化编写能力的作者从不提交该字段（服务端沿用活跃版本），无论表单状态从何而来
    if (!structuredAuthoring.allowed) return undefined;
    const current = storedEmbeddedVocabulary(fields.embeddedVocabulary);
    if (current === storedEmbeddedVocabulary(savedEmbedded)) return undefined;
    return current === null ? null : fields.embeddedVocabulary;
  }, [fields.embeddedVocabulary, savedEmbedded, structuredAuthoring.allowed]);

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

  // 入门模板：「未改动」= 内容仍等于初始内容。任何写入（手动编辑、AI、模板替换、恢复草稿）
  // 都会让它自然失效，无需在各写入口逐个清标记；入门模板也只作初值，不会再写回编辑器。
  const starterSource = mode === 'create' && starter && content === initial.content ? initial.content : null;
  const [starterHintDismissed, setStarterHintDismissed] = useState(false);
  // 「从空白开始」后以空白为基线：空编辑器不算未保存修改，不自动保存、不触发离开确认。
  const [startedBlank, setStartedBlank] = useState(false);
  const baseline = useMemo(
    () => (startedBlank ? { ...initial, content: '' } : initial),
    [startedBlank, initial],
  );
  const startBlank = useCallback(() => {
    setContent('');
    setStartedBlank(true);
  }, []);

  // Editor instance is captured imperatively. We also hold a state
  // boolean so child hooks (markers, jump-to-line) re-run after
  // monaco's async onMount — refs alone won't trigger a re-render.
  const editorInstanceRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  // 保留 ready 布尔：onMount 是异步的，翻转它触发一次 re-render，让依赖 editor 实例的
  // 子组件（SidePanel / palette）在挂载后拿到实例（ref 变化本身不触发 re-render）。
  const [editorReady, setEditorReady] = useState(false);

  // 词汇标签页的术语：由编辑器内的词汇 hook 上抛，不另发请求。
  const [vocabularyTerms, setVocabularyTerms] = useState<ReadonlyArray<VocabularyTabTerm>>([]);
  // 词汇规范预览（ADR 0058 §8.3）：编辑器 LSP 会话上抛能力与请求函数；只在能力为真时接收。
  const [lsp, setLsp] = useState<EditorLspHandle | null>(null);
  const [canonicalPreviewOpen, setCanonicalPreviewOpen] = useState(false);
  // 命令面板「新建结构体」：模型标签页打开新建表单后清除
  const [newStructRequested, setNewStructRequested] = useState(false);
  const canonicalPreviewAvailable = structuredAuthoring.allowed && lsp?.features?.canonicalPreview === true;
  const toggleCanonicalPreview = useCallback(() => setCanonicalPreviewOpen((v) => !v), []);
  const handleNewStructRequestHandled = useCallback(() => setNewStructRequested(false), []);

  // ---------------------------------------------------------------
  // 显示排版（ADR 0058 §7.4–7.8，裁决 R11–R13）
  // ---------------------------------------------------------------
  // savedLayout / activeHasLayout / savedContent 是「上一次落库」的基线：加载时来自编辑页，保存成功后更新。
  const [savedLayout, setSavedLayout] = useState<PolicyLayout | null>(initialLayout);
  const [activeHasLayout, setActiveHasLayout] = useState(hasActiveLayout);
  const [savedContent, setSavedContent] = useState(initial.content);
  const [layoutDraft, setLayoutDraft] = useState<LayoutDraft>({ kind: 'untouched' });
  const [sideBySide, setSideBySide] = useState(false);
  // Monaco 选区的 canonical 偏移（只在并排视图打开时跟踪）
  const [canonicalSelection, setCanonicalSelection] = useState<{ start: number; end: number } | null>(null);
  // 保存前的「此版本将不再带显示排版」确认：记下确认后要继续的保存
  const [pendingDropSave, setPendingDropSave] = useState<{ afterSave?: (id: string) => void } | null>(null);
  const currentLayout =
    layoutDraft.kind === 'edited' ? layoutDraft.layout : layoutDraft.kind === 'removed' ? null : savedLayout;
  // 并排窗格只显示与当前源码逐字对应的排版；源码改了即失效（R12），窗格随之收起
  const paneLayout =
    structuredAuthoring.allowed && sideBySide && !isMobile && currentLayout && toCanonical(currentLayout) === content
      ? currentLayout
      : null;
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
  // 内嵌 field / enum_value 的所属类型候选（规范名）：本策略与作用域内词汇里的类型，以及源码声明的类型
  const embeddedParentOptions = useMemo(() => {
    const names = new Set<string>(compile.module?.types ?? []);
    for (const term of vocabularyTerms) if (term.kind === 'struct') names.add(term.canonical);
    for (const term of embedded?.terms ?? []) if (term.kind === 'struct') names.add(term.canonical);
    return [...names].sort();
  }, [compile.module?.types, vocabularyTerms, embedded]);
  const compileErrorCount = useMemo(
    () => compile.diagnostics.filter((d) => d.severity === 'error').length,
    [compile.diagnostics],
  );

  // 并排视图的同步：Monaco 光标 / 选区 → display 高亮；编译诊断 → display 标记（都经 projectCanonicalRange）
  useEffect(() => {
    const ed = editorInstanceRef.current;
    if (!paneLayout || !ed) return;
    const subscription = ed.onDidChangeCursorSelection(({ selection }) => {
      const text = ed.getModel()?.getValue() ?? '';
      try {
        setCanonicalSelection({
          start: offsetAt(text, selection.startLineNumber, selection.startColumn),
          end: offsetAt(text, selection.endLineNumber, selection.endColumn),
        });
      } catch {
        setCanonicalSelection(null);
      }
    });
    return () => subscription.dispose();
  }, [paneLayout, editorReady]);
  const paneHighlight = useMemo(() => {
    if (!paneLayout || !canonicalSelection) return null;
    let { start, end } = canonicalSelection;
    // 光标没有选区时高亮光标后的一个字符（码点；行末 / 文末取前一个），否则零宽区间在 display 里看不见。
    // 光标若落在代理对中间先退到码点起点，不高亮半个字符。
    if (start === end) {
      const high = content.charCodeAt(start - 1);
      const low = content.charCodeAt(start);
      if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) start = end = start - 1;
      if (start < content.length) end = start + (content.codePointAt(start)! > 0xffff ? 2 : 1);
      else if (start > 0) start = end - (start >= 2 && content.codePointAt(start - 2)! > 0xffff ? 2 : 1);
    }
    try {
      return projectCanonicalRange(paneLayout, start, end);
    } catch {
      return null;
    }
  }, [paneLayout, canonicalSelection, content]);
  const paneMarkers = useMemo<LayoutDisplayMarker[]>(() => {
    // 诊断只对它所编译的那份源码有效；防抖编译尚未追上时不投影
    if (!paneLayout || (compile.source ?? content) !== content) return [];
    return compile.diagnostics.flatMap((d) => {
      if (d.severity !== 'error' && d.severity !== 'warning') return [];
      const a = offsetAtClamped(content, d.startLine, d.startColumn);
      const b = offsetAtClamped(content, d.endLine, d.endColumn);
      return [{ range: projectCanonicalRange(paneLayout, Math.min(a, b), Math.max(a, b)), severity: d.severity }];
    });
  }, [paneLayout, compile.source, compile.diagnostics, content]);
  const jumpFromDisplay = useCallback(
    (displayOffset: number) => {
      const ed = editorInstanceRef.current;
      if (!ed || !paneLayout) return;
      const { line, column } = positionAt(content, displayToCanonical(paneLayout, displayOffset).start);
      ed.setPosition({ lineNumber: line, column });
      ed.revealLineInCenter(line);
      ed.focus();
    },
    [paneLayout, content],
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

  const structuredAuthoringPalette = useMemo<StructuredAuthoringPaletteActions | null>(
    () =>
      structuredAuthoring.allowed
        ? {
            onOpenModelTab: () => openSidePanel('model'),
            onOpenVocabularyTab: () => openSidePanel('vocabulary'),
            onNewStruct: () => {
              setNewStructRequested(true);
              openSidePanel('model');
            },
            onToggleCanonicalPreview: canonicalPreviewAvailable ? toggleCanonicalPreview : null,
          }
        : null,
    [structuredAuthoring.allowed, canonicalPreviewAvailable, openSidePanel, toggleCanonicalPreview],
  );

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
      const body = getExampleSource(tpl, exampleLocale);
      insertAtCursor(body);
      setName((prev) => prev || tpl.id);
      toast.success(t('templateInsertedAtCursor'));
      if (mode === 'create') trackProductEvent('template_selected', { templateId: tpl.id, source: 'palette' });
    },
    [exampleLocale, insertAtCursor, t, mode],
  );

  /** 用模板内容整体替换编辑器（清空后写入），非插入到光标。设默认名称仅在
   *  名称为空时，避免覆盖用户已填内容。侧栏「模板」tab 走此路径。 */
  const applyTemplateReplace = useCallback(
    (tpl: PolicyExample) => {
      const body = getExampleSource(tpl, exampleLocale);
      // setContent 是编辑器内容的唯一真相源（Monaco 受控于 value），直接整体
      // 替换即清空并写入模板；无需先手动清空。
      setContent(body);
      if (hasTemplateExtras(tpl)) {
        // 带别名 / 排版 / 内嵌词汇的模板（#791、ADR 0060）：源码依赖别名与内嵌词条，二者整体替换；排版与内嵌词汇
        // 只在有结构化编写能力时写入（无能力时模板本就锁定，这里是兜底；内嵌词汇也只有该能力才会随保存提交）。
        // 固定语言的模板同时切换策略 CNL 语言。模板从不写个人 / 团队词汇。
        setAliasSet(Object.fromEntries(Object.entries(tpl.aliasSet ?? {}).map(([kind, words]) => [kind, [...words]])));
        if (structuredAuthoring.allowed) {
          setEmbedded(
            tpl.embeddedVocabulary ? { v: 1, terms: tpl.embeddedVocabulary.terms.map((term) => ({ ...term })) } : null,
          );
          if (tpl.layout) {
            setLayoutDraft({ kind: 'edited', layout: tpl.layout });
            setSideBySide(true);
          }
        }
      } else {
        // 普通模板只换源码；但之前编辑过的排版已对不上新源码，保存时必被拒（往返不符），退回「未动」。
        setLayoutDraft((draft) =>
          draft.kind === 'edited' && toCanonical(draft.layout) !== body ? { kind: 'untouched' } : draft,
        );
      }
      if (tpl.cnlLocale) setChosenCnlLocale(tpl.cnlLocale);
      const previousAutoName = autoTemplateName.current;
      setName((prev) => nextTemplateName(prev, previousAutoName, tpl.id));
      autoTemplateName.current = tpl.id;
      toast.success(t('templateReplaced'));
      if (mode === 'create') trackProductEvent('template_selected', { templateId: tpl.id, source: 'picker' });
    },
    [exampleLocale, t, mode, structuredAuthoring.allowed],
  );

  /** 侧栏「模板」tab 点击入口：编辑器有内容先弹确认（防误抹未保存草稿），
   *  为空则直接替换。 */
  const requestTemplateReplace = useCallback(
    (tpl: PolicyExample) => {
      // 带别名 / 排版 / 内嵌词汇的模板还会覆盖已有别名、已编辑的排版与本策略词条：编辑器为空但这些不为空时也先确认。
      const overwritesExtras =
        hasTemplateExtras(tpl) &&
        (Object.keys(aliasSet).length > 0 || layoutDraft.kind === 'edited' || (embedded?.terms.length ?? 0) > 0);
      if (content.trim().length > 0 || overwritesExtras) {
        setPendingTemplate(tpl);
      } else {
        applyTemplateReplace(tpl);
      }
    },
    [content, aliasSet, layoutDraft.kind, embedded, applyTemplateReplace],
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
    baseline,
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
          // 只有能改动内嵌词条的作者才恢复草稿里的值；能力已被收回时保留活跃版本的值（只读作者不改词条）
          if (structuredAuthoring.allowed) setEmbedded(pendingDraft.embeddedVocabulary ?? null);
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
  }, [pendingDraft, t, acceptPendingDraft, discardPendingDraft, structuredAuthoring.allowed]);

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
      locale: cnlLocale,
    });
    if (!aliasValidation.valid) {
      // 跨 kind 重复等整体问题不能静默拦截：打开别名面板并给出首条问题的本地化说明。
      openSidePanel('aliases');
      toast.error(t('aliasesInvalidBeforeSaving'), {
        description: aliasIssueMessage(aliasValidation.issues[0]),
      });
      return false;
    }
    // 内嵌词条与服务端同一份校验（含与本策略别名的碰撞）：不合法时引导到「本策略」所在的标签
    const embeddedError = embeddedVocabularyErrorCode(fields.embeddedVocabulary?.terms ?? [], {
      locale: cnlLocale,
      aliasSet: fields.aliasSet,
    });
    if (embeddedError) {
      openSidePanel(structuredAuthoring.allowed ? 'vocabulary' : 'aliases');
      toast.error(tTerms('invalidBeforeSaving'), { description: tTerms(`errors.${embeddedError}`) });
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
    cnlLocale,
    aliasIssueMessage,
    fields.embeddedVocabulary,
    fields.aliasSet,
    cnlLocale,
    structuredAuthoring.allowed,
    tTerms,
    compileErrorCount,
    compile.state,
    content,
    openSidePanel,
  ]);

  /**
   * 保存失败的本地化说明：按错误码给文案，不展示服务端原文；词汇非法且已知出错词条时点名该词条。
   */
  const saveErrorText = useCallback(
    (error: PolicySaveError): string => {
      if (isLayoutSaveErrorCode(error.code)) {
        return layoutErrorText({ code: error.code, offset: error.offset, limit: error.limit }, content);
      }
      if (isEmbeddedVocabularyErrorCode(error.code)) return tTerms(`errors.${error.code}`);
      if (error.code === VOCABULARY_SCOPE_INVALID_CODE) {
        // 按引擎原因分文案：缺 parent（字段 / 枚举成员）与字面量冲突的修法不同；未知原因用通用说明
        const term = error.term;
        switch (error.reason) {
          case 'field_parent_required':
          case 'member_parent_required':
            return term
              ? t('saveErrorCodes.vocabulary_scope_parent_required_term', { term })
              : t('saveErrorCodes.vocabulary_scope_parent_required');
          case 'literal_conflict':
            return term
              ? t('saveErrorCodes.vocabulary_scope_literal_conflict_term', { term })
              : t('saveErrorCodes.vocabulary_scope_literal_conflict');
        }
        if (term) return t('saveErrorCodes.vocabulary_scope_invalid_term', { term });
      }
      return localizedErrorMessage(error.code, {
        alias_invalid: t('saveErrorCodes.alias_invalid'),
        compile_error: t('saveErrorCodes.compile_error'),
        compile_unavailable: t('saveErrorCodes.compile_unavailable'),
        policy_frozen: t('saveErrorCodes.policy_frozen'),
        unauthorized: t('saveErrorCodes.unauthorized'),
        unsupported_locale: t('saveErrorCodes.unsupported_locale'),
        vocabulary_scope_invalid: t('saveErrorCodes.vocabulary_scope_invalid'),
        vocabulary_unavailable: t('saveErrorCodes.vocabulary_unavailable'),
      }, error.message);
    },
    [t, tTerms, layoutErrorText, content],
  );

  // 这次保存会让新版本失去显示排版：活跃版本有排版、源码改了，且无权保存排版或排版未动而已对不上源码
  const willDropLayout =
    activeHasLayout &&
    content !== savedContent &&
    (!structuredAuthoring.allowed ||
      (layoutDraft.kind === 'untouched' && (savedLayout === null || toCanonical(savedLayout) !== content)));

  /** 已通过校验后真正提交（丢弃确认之后也从这里继续）。 */
  const submit = useCallback(
    async (afterSave?: (id: string) => void): Promise<void> => {
      setIsSaving(true);
      setServerError(null);
      // 草稿 → 三态：未动 = 省略，edited = 对象，removed = null（R13）
      const layout = layoutDraft.kind === 'edited' ? layoutDraft.layout : layoutDraft.kind === 'removed' ? null : undefined;
      const context: PolicySaveContext = {
        locale: cnlLocale,
        ...(layout !== undefined ? { layout } : {}),
        ...(embeddedSaveField !== undefined ? { embeddedVocabulary: embeddedSaveField } : {}),
      };
      try {
        const result = await onSave(fields, context);
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
            // layout 错误码引导到排版标签页（能力为假时没有该标签）
            if (isLayoutSaveErrorCode(result.code) && structuredAuthoring.allowed) openSidePanel('layout');
            // 内嵌词汇错误码引导到「本策略」所在的标签（有能力为词汇标签，否则为只读列表所在的别名标签）
            if (isEmbeddedVocabularyErrorCode(result.code)) openSidePanel(structuredAuthoring.allowed ? 'vocabulary' : 'aliases');
            toast.error(t('saveFailed'), { description: saveErrorText(result) });
          }
          return;
        }
        toast.success(t('saveSuccess'));
        if (result.layoutDropped) toast.warning(tEditor('layoutDrop.dropped'));
        const shadowed = result.vocabularyShadowed ?? [];
        if (shadowed.length > 0) {
          toast.info(
            tTerms('shadowedAfterSave', {
              count: shadowed.length,
              terms: shadowed
                .map((term) => `${term.localized} (${term.source === 'team' ? tTerms('sourceTeam') : tTerms('sourceAuthor')})`)
                .join(', '),
            }),
          );
        }
        setSavedEmbedded(fields.embeddedVocabulary ?? null);
        // 刚保存的版本成为新的基线：提交的排版即活跃排版；省略且被丢弃则活跃版本不再带排版
        if (layout !== undefined || result.layoutDropped) {
          setSavedLayout(layout ?? null);
          setActiveHasLayout(layout != null);
        }
        setLayoutDraft({ kind: 'untouched' });
        setSavedContent(fields.content);
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
    [layoutDraft, embeddedSaveField, onSave, fields, cnlLocale, clearDraft, t, tEditor, tTerms, openSidePanel, saveErrorText, structuredAuthoring.allowed],
  );

  /** Submit. Optional callback to fire on success (e.g. navigate). */
  const handleSubmit = useCallback(
    async (afterSave?: (id: string) => void): Promise<void> => {
      if (!validate()) return;
      if (isSaving) return;
      if (willDropLayout) {
        setPendingDropSave({ afterSave });
        return;
      }
      await submit(afterSave);
    },
    [validate, isSaving, willDropLayout, submit],
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

  const monacoEditor = (
    <MonacoPolicyEditor
      value={content}
      onChange={setContent}
      locale={cnlLocale}
      userVocabulary
      vocabularyTeamId={teamId}
      embeddedVocabulary={fields.embeddedVocabulary}
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
      // 仅在结构化创作可用时同步词条，能力关闭时不产生额外渲染
      onVocabularyTermsChange={structuredAuthoring.allowed ? setVocabularyTerms : undefined}
      onLspChange={structuredAuthoring.allowed ? setLsp : undefined}
      // 用户在设置页或状态栏关闭后不再发出任何 AI 补全请求；
      // 读取本地偏好完成前按关闭处理，避免首帧按默认值误发请求。
      enableAICompletion={aiInlineCompletion.value && !aiInlineCompletion.hydrating}
      onToggleAIPanel={() => openSidePanel('ai')}
    />  );

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

        {/* ----- 入门模板提示（新建且入门模板未改动） ----- */}
        {starterSource !== null && !starterHintDismissed && (
          <StarterHint
            uiLocale={uiLocale}
            cnlLocale={cnlLocale}
            onStartBlank={isMobile ? undefined : startBlank}
            onDismiss={() => setStarterHintDismissed(true)}
          />
        )}

        {/* ----- 策略语言与源码不一致提示（#627） ----- */}
        {mismatchedLocale && (
          <div
            role="status"
            data-testid="policy-locale-mismatch"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-2 text-sm text-fg"
          >
            <span>
              {t('localeMismatch', {
                current: cnlLocale.toUpperCase(),
                detected: mismatchedLocale.toUpperCase(),
              })}
            </span>
            <button
              type="button"
              onClick={() => setChosenCnlLocale(mismatchedLocale)}
              className="rounded border border-border bg-bg px-2 py-0.5 text-xs font-medium hover:bg-bg-muted focus-visible:outline-none focus-visible:shadow-ring"
            >
              {t('localeMismatchSwitch', { locale: mismatchedLocale.toUpperCase() })}
            </button>
          </div>
        )}

        {/* ----- Server error banner ----- */}
        {serverError && (
          <div
            role="alert"
            className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-2 text-sm text-danger"
          >
            {saveErrorText(serverError)}
            {serverError.code === VOCABULARY_SCOPE_INVALID_CODE && (
              <Link
                href={`/${uiLocale}/domain-vocabularies`}
                className="ml-3 underline hover:no-underline"
              >
                {t('openVocabulary')}
              </Link>
            )}
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
              structuredAuthoring={structuredAuthoring}
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
              <pre tabIndex={0}
                className="m-0 h-full overflow-auto p-4 font-mono text-sm text-fg whitespace-pre-wrap break-words"
                aria-label={t('content')}
              >
                {content || t('contentPlaceholder')}
              </pre>
            ) : (
              structuredAuthoring.allowed ? (
                // 结构化编写可用时编辑器放进可收缩的一格，下方才能分出词汇规范预览、左侧才能并排显示排版；
                // 能力为假时 DOM 不变。显示排版是只读窗格，Monaco 仍是唯一的 canonical 编辑器（R11）。
                <div className="flex min-h-0 flex-1">
                  {paneLayout && (
                    <section
                      data-testid="layout-display-pane"
                      aria-label={tEditor('layoutTab.paneTitle')}
                      className="hidden min-h-0 w-1/2 shrink-0 flex-col border-r border-border lg:flex"
                    >
                      <h2 className="border-b border-border px-3 py-1.5 text-xs font-medium text-fg-muted">
                        {tEditor('layoutTab.paneTitle')}
                      </h2>
                      <div className="min-h-0 flex-1 overflow-auto p-2">
                        <LayoutDisplayView
                          layout={paneLayout}
                          highlight={paneHighlight}
                          markers={paneMarkers}
                          onDisplayOffsetClick={jumpFromDisplay}
                        />
                      </div>
                    </section>
                  )}
                  <div className="flex min-h-0 flex-1 flex-col min-w-0">{monacoEditor}</div>
                </div>
              ) : (
                monacoEditor
              )
            )}
            {canonicalPreviewAvailable && canonicalPreviewOpen && !isMobile && lsp && (
              <div className="flex h-[40%] min-h-0 shrink-0 flex-col">
                <CanonicalPreviewPane
                  // 同 SidePanel：编辑器实例经 ref 持有，onEditorReady 触发的重渲染后可读到
                  // eslint-disable-next-line react-hooks/refs
                  editor={editorInstanceRef.current}
                  source={compile.source ?? content}
                  request={lsp.requestCanonicalPreview}
                  refreshKey={lsp.status}
                  onClose={() => setCanonicalPreviewOpen(false)}
                />
              </div>
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
                visibilityLocked={visibilityLocked}
                nameError={nameError}
                aliasSet={aliasSet}
                reservedSets={reservedSets}
                allowStructuralAliases={allowStructuralAliases}
                structuredAuthoring={structuredAuthoring}
                onAliasSetChange={setAliasSet}
                onApplyContent={(body) => setContent(body)}
                starterSource={starterSource}
                onApplyTemplate={(tpl) => {
                  // 侧栏「模板」tab：整体替换编辑器内容（有内容先弹确认）。
                  // 命令面板的「插入到光标」保持 insertTemplateAtCursor 不变。
                  requestTemplateReplace(tpl);
                }}
                onClose={() => setSidePanelOpen(false)}
                compileState={serverError?.diagnostics?.length ? 'error' : compile.state}
                compileSource={compile.source}
                vocabularyTerms={vocabularyTerms}
                embeddedVocabulary={fields.embeddedVocabulary ?? null}
                onEmbeddedVocabularyChange={setEmbedded}
                embeddedParentOptions={embeddedParentOptions}
                teamId={teamId}
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
                canonicalPreview={
                  canonicalPreviewAvailable ? { open: canonicalPreviewOpen, onToggle: toggleCanonicalPreview } : null
                }
                newStructRequested={newStructRequested}
                onNewStructRequestHandled={handleNewStructRequestHandled}
                layoutPanel={
                  structuredAuthoring.allowed ? (
                    <LayoutTab
                      // 同上：编辑器实例经 ref 持有
                      // eslint-disable-next-line react-hooks/refs
                      editor={editorInstanceRef.current}
                      source={content}
                      cnlLocale={cnlLocale}
                      aliasSet={fields.aliasSet}
                      layout={currentLayout}
                      inconsistent={initialLayoutInconsistent && layoutDraft.kind === 'untouched'}
                      sideBySide={sideBySide}
                      onSideBySideChange={setSideBySide}
                      onChange={setLayoutDraft}
                    />
                  ) : null
                }
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
          structuredAuthoring={structuredAuthoringPalette}
        />

        {/* ----- CNL locale converter dialog ----- */}
        <CNLSyntaxConverterDialog
          isOpen={converterOpen}
          onClose={() => setConverterOpen(false)}
          content={content}
          currentLocale={exampleLocale}
          uiLocale={uiLocale}
          onApply={(converted, newLocale) => {
            setContent(converted);
            setChosenCnlLocale(newLocale);
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

        {/* ----- 显示排版丢弃确认（ADR 0058 §6 第 3 行、§7.5）：只在需要时挂载，无排版的编辑器 DOM 不变 ----- */}
        {pendingDropSave && (
          <ConfirmDialog
            isOpen
            title={tEditor('layoutDrop.confirmTitle')}
            description={tEditor('layoutDrop.confirmBody')}
            confirmLabel={tEditor('layoutDrop.confirm')}
            cancelLabel={tCommon('cancel')}
            variant="warning"
            onCancel={() => setPendingDropSave(null)}
            onConfirm={() => {
              const { afterSave } = pendingDropSave;
              setPendingDropSave(null);
              void submit(afterSave);
            }}
          />
        )}

        {/* ----- Template overwrite confirmation ----- */}
        {/* 模板覆盖已有内容前先确认，避免误删未保存的编辑。 */}
        <ConfirmDialog
          isOpen={pendingTemplate !== null}
          title={t('templateReplaceTitle')}
          description={
            pendingTemplate && hasTemplateExtras(pendingTemplate)
              ? t('templateReplaceDescriptionExtras')
              : t('templateReplaceDescription')
          }
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
