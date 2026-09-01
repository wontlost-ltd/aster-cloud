'use client';

import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import Editor, { OnMount, OnChange } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';
import {
  getLexicon,
  getKeywordsByCategory,
  buildMultiWordRules,
  getVocabulary,
  extractVocabularyTerms,
  initBuiltinVocabularies,
  type Lexicon,
  type DomainVocabulary,
} from '@/lib/aster-lexicon';
import { useSession } from 'next-auth/react';
import { useAsterCompiler, type CNLLocale } from '@/hooks/useAsterCompiler';
import { collectKeywordLabels } from '@/lib/aster-keyword-completions';
import { useAsterModuleCatalog } from '@/hooks/useAsterModuleCatalog';
import { useDomainVocabularyInvalidate } from '@/hooks/useDomainVocabularyInvalidate';
import { useUserVocabularyRegistration } from '@/hooks/useUserVocabularyRegistration';
import type { TypecheckDiagnostic } from '@aster-cloud/aster-lang-ts/browser';
import { violet, sky, emerald, amber, rose, zinc } from '@aster-cloud/tokens';
import { useEntryRuleDecorations } from './use-entry-rule-decorations';
import { extractUseRefs, type UseRef } from '@/lib/aster/modules';
import type { AsterModuleCatalogEntry } from '@/services/policy/policy-api';

// Monaco 语言 ID
const ASTER_LANG_ID = 'aster-cnl';
const MODULE_CATALOG_MARKER_OWNER = 'aster-module-catalog';

// 模块级初始化内置词汇表（幂等，仅执行一次）
initBuiltinVocabularies();

// 语言注册状态
let languageRegistered = false;

interface MonacoPolicyEditorProps {
  value: string;
  onChange: (value: string) => void;
  locale?: string;
  /** 领域标识符（如 'insurance.auto'），启用领域术语补全和高亮 */
  domain?: string;
  /** 用户策略层关键词别名，kind → 多词别名。 */
  aliasSet?: Readonly<Record<string, readonly string[]>>;
  height?: string;
  readOnly?: boolean;
  placeholder?: string;
  /** Debounce delay for validation in ms (default: 300) */
  debounceDelay?: number;
  /** 编辑器挂载回调，暴露 editor 实例供外部使用（如 AI Panel） */
  onEditorReady?: (editor: editor.IStandaloneCodeEditor) => void;
  /** 启用 AI inline 补全（需要后端 /api/v1/ai/complete 端点） */
  enableAICompletion?: boolean;
  /** AI Panel 切换回调（Ctrl+Shift+G 触发） */
  onToggleAIPanel?: () => void;
  /** AI 解释选中代码回调（Ctrl+Shift+E 触发） */
  onExplainSelection?: (selectedText: string) => void;
  /**
   * 编译状态变化回调。把编辑器内部 useAsterCompiler（完整 parse+typecheck，别名感知）的
   * 结果上抛给父层，让 StatusBar/SidePanel 复用同一份诊断——避免父层再跑一遍 parse-only 编译
   * （消除每次按键的双重解析、双份 Problems 面板、双份红波浪线，并根除两条管线的别名不同步）。
   */
  onCompileChange?: (result: EditorCompileState) => void;
}

/** 上抛给父层的编译状态（形状对齐 policy-form 的 StatusBar/SidePanel 消费口径）。 */
export interface EditorCompileState {
  state: 'idle' | 'pending' | 'ok' | 'error';
  diagnostics: EditorCompileDiagnostic[];
  module?: EditorCompileModuleSummary;
}

export interface EditorCompileDiagnostic {
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  code?: string;
}

export interface EditorCompileModuleSummary {
  name: string;
  functions: string[];
  types: string[];
}

// R23-Critical-2: AI complete 直连 aster-api 已停用。改走 server-side proxy
// `/api/llm/complete`（aster-cloud）做 NextAuth 鉴权 + HMAC 转签。

// NOTE: inlineCompletionTimer and inlineProviderDisposable are managed as
// component-scoped refs inside MonacoPolicyEditor to avoid cross-instance leaks.

// 注册 Aster Lang 语言
function registerAsterLanguage(
  monaco: typeof import('monaco-editor'),
  lexicon: Lexicon,
  vocabulary?: DomainVocabulary
) {
  // 只注册一次语言
  if (!languageRegistered) {
    monaco.languages.register({ id: ASTER_LANG_ID });
    languageRegistered = true;
  }

  const keywords = getKeywordsByCategory(lexicon);
  // 多词关键词规则（从词表派生，见 buildMultiWordRules 的说明）。
  const multiWordRules = buildMultiWordRules(lexicon);

  // 提取领域词汇表术语
  const domainTerms = vocabulary ? extractVocabularyTerms(vocabulary) : [];

  // 设置语言的 Token 规则
  monaco.languages.setMonarchTokensProvider(ASTER_LANG_ID, {
    // 关键词分类
    moduleKeywords: keywords.module,
    typeKeywords: keywords.type,
    functionKeywords: keywords.function,
    controlKeywords: keywords.control,
    variableKeywords: keywords.variable,
    booleanKeywords: keywords.boolean,
    operatorKeywords: keywords.operator,
    literalKeywords: keywords.literal,
    primitiveTypeKeywords: keywords.primitiveType,
    workflowKeywords: keywords.workflow,
    asyncKeywords: keywords.async,
    constraintKeywords: keywords.constraint,
    effectKeywords: keywords.effect,
    domainTerms,

    // Token 化规则
    tokenizer: {
      root: [
        // 注释 (// 或 # 开头)
        [/\/\/.*$/, 'comment'],
        [/#.*$/, 'comment'],

        // 字符串 (支持多种引号)
        [/"([^"\\]|\\.)*$/, 'string.invalid'], // 未闭合的字符串
        [/"/, 'string', '@string_double'],
        [/'([^'\\]|\\.)*$/, 'string.invalid'],
        [/'/, 'string', '@string_single'],
        [/「/, 'string', '@string_chinese'],

        // 数字
        [/\d+\.\d*/, 'number.float'],
        [/\.\d+/, 'number.float'],
        [/\d+/, 'number'],

        // ★多词关键词必须排在标识符规则**之前**：Monarch 自上而下首个匹配即用，
        //   标识符规则 [A-Za-z_…]+ 只吃到 "for" 就落 @default=identifier，
        //   排在后面的 /for each/ 永远轮不到（这是「英文/德文多词关键词从不高亮」的根因）。
        //   规则由 buildMultiWordRules 从词表**动态生成**（含长度降序，
        //   使 "integer divided by" 不被 "divided by" 抢先匹配），词表新增自动跟随。
        ...multiWordRules,

        // 标识符和关键词
        [
          /[a-zA-Z_\u4e00-\u9fa5\u0900-\u097f][\w\u4e00-\u9fa5\u0900-\u097f]*/,
          {
            cases: {
              '@moduleKeywords': 'keyword.module',
              '@typeKeywords': 'keyword.type',
              '@functionKeywords': 'keyword.function',
              '@controlKeywords': 'keyword.control',
              '@variableKeywords': 'keyword.variable',
              '@booleanKeywords': 'keyword.boolean',
              '@operatorKeywords': 'keyword.operator',
              '@literalKeywords': 'constant.language',
              '@primitiveTypeKeywords': 'type',
              '@workflowKeywords': 'keyword.workflow',
              '@asyncKeywords': 'keyword.async',
                '@constraintKeywords': 'keyword.constraint',
                '@effectKeywords': 'keyword.effect',
              '@domainTerms': 'variable.domain',
              '@default': 'identifier',
            },
          },
        ],

        // 运算符
        [/[+\-*/<>=!]+/, 'operator'],

        // 标点符号
        [/[{}()\[\]]/, 'delimiter.bracket'],
        [/[;,.:：。，、]/, 'delimiter'],

        // 空白
        [/\s+/, 'white'],
      ],

      // 双引号字符串
      string_double: [
        [/[^\\"]+/, 'string'],
        [/\\./, 'string.escape'],
        [/"/, 'string', '@pop'],
      ],

      // 单引号字符串
      string_single: [
        [/[^\\']+/, 'string'],
        [/\\./, 'string.escape'],
        [/'/, 'string', '@pop'],
      ],

      // 中文引号字符串
      string_chinese: [
        [/[^」]+/, 'string'],
        [/」/, 'string', '@pop'],
      ],
    },
  });

  // 设置语言配置（括号匹配、注释等）
  monaco.languages.setLanguageConfiguration(ASTER_LANG_ID, {
    comments: {
      lineComment: '//',
    },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
      ['【', '】'],
      ['「', '」'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: '【', close: '】' },
      { open: '「', close: '」' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: '【', close: '】' },
      { open: '「', close: '」' },
    ],
    indentationRules: {
      increaseIndentPattern: /:\s*$/,
      decreaseIndentPattern: /^\s*(otherwise|否则|when|当)/,
    },
  });
}

/**
 * Aster Monaco theme.
 *
 * Replaces the default VS Code palette with a brand-aware scheme keyed on
 * @aster-cloud/tokens. The mapping intentionally surfaces *Aster CNL's
 * structural concepts* rather than mimicking JavaScript/TypeScript token
 * colors — `Module` and `Rule` declarations are the most important visual
 * landmarks in a policy, so they get the violet primary; relational
 * keywords (`has`, `given`, `option of`) lean on the sky accent; control
 * flow uses amber as "branching needs attention" affordance.
 *
 * Why hard-coded hex values rather than CSS variables: Monaco's defineTheme
 * API resolves colors at theme-definition time, not at render time. CSS
 * variables would yield literal "var(--aster-…)" strings to Monaco's
 * internal color parser → it would fall back to black. The tokens package
 * exports the same raw hex strings as `tokens.css`, so this stays in sync
 * with the rest of the brand via a single source.
 *
 * Monaco color string conventions:
 *   - `rules[].foreground`: 6-char hex WITHOUT '#' prefix (Monaco quirk)
 *   - `colors[*]`: 6/8-char hex WITH '#' prefix (8-char includes alpha)
 */

/** Strip leading '#' for use in Monaco's token-color rules. */
const hex = (c: string) => c.replace(/^#/, '');

/**
 * Token role → brand-color mapping. Each entry maps the Monaco token type
 * emitted by `setMonarchTokensProvider` (see registerAsterLanguage above)
 * to a light/dark hex pair pulled from the design tokens.
 *
 *   Module / Rule declarations  → violet (primary, strongest landmark)
 *   has / given / type concepts → sky    (accent, relational)
 *   if / otherwise / for each   → amber  (control flow, "branching")
 *   workflow / max attempts     → emerald (action / commit)
 *   wait for / async            → sky lighter (live / streaming)
 *   booleans + literals         → rose   (literals stand out)
 *   strings                     → amber 700 (warm content)
 *   numbers                     → emerald (quantitative "success")
 *   comments                    → muted neutral italic
 *   identifiers                 → fg (neutral)
 *   domain vocabulary           → sky italic (signals "domain word")
 *   brackets                    → violet (subtle scope anchors)
 */
function defineAsterTheme(monaco: typeof import('monaco-editor'), isDark: boolean) {
  const themeName = isDark ? 'aster-dark' : 'aster-light';

  monaco.editor.defineTheme(themeName, {
    base: isDark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      // === Module / Rule declarations — the brand-defining landmarks ===
      { token: 'keyword.module',   foreground: hex(isDark ? violet[400] : violet[700]), fontStyle: 'bold' },
      { token: 'keyword.function', foreground: hex(isDark ? violet[300] : violet[600]), fontStyle: 'bold' },

      // === Type / structural keywords (has, given, as one of, …) ===
      { token: 'keyword.type',     foreground: hex(isDark ? sky[300] : sky[700]), fontStyle: 'bold' },
      { token: 'type',             foreground: hex(isDark ? sky[400] : sky[700]) },
      { token: 'keyword.variable', foreground: hex(isDark ? sky[300] : sky[700]) },

      // === Control flow (if, otherwise, for each) ===
      { token: 'keyword.control',  foreground: hex(isDark ? amber[300] : amber[700]), fontStyle: 'bold' },

      // === Workflow / commit keywords (max attempts, retry) ===
      { token: 'keyword.workflow', foreground: hex(isDark ? emerald[300] : emerald[700]), fontStyle: 'bold' },

      // === Async (wait for, after) — pairs with AI/streaming brand color ===
      { token: 'keyword.async',    foreground: hex(isDark ? sky[200] : sky[600]) },

      // === Effects (input/output, side effect markers) ===
      { token: 'keyword.effect',   foreground: hex(isDark ? emerald[200] : emerald[600]), fontStyle: 'italic' },

      // === Operators (and, or, not, divided by) — quiet neutral ===
      { token: 'keyword.operator', foreground: hex(isDark ? zinc[300] : zinc[700]) },

      // === Booleans + null/none — high-contrast rose so they pop ===
      { token: 'keyword.boolean',     foreground: hex(isDark ? rose[300] : rose[700]) },
      { token: 'constant.language',   foreground: hex(isDark ? rose[300] : rose[700]) },

      // === Strings (warm amber range — "human text") ===
      { token: 'string',          foreground: hex(isDark ? amber[200] : amber[800]) },
      { token: 'string.escape',   foreground: hex(isDark ? amber[400] : amber[600]) },
      { token: 'string.invalid',  foreground: hex(isDark ? rose[400] : rose[700]) },

      // === Numbers (emerald — quantitative truth) ===
      { token: 'number',          foreground: hex(isDark ? emerald[200] : emerald[700]) },
      { token: 'number.float',    foreground: hex(isDark ? emerald[200] : emerald[700]) },

      // === Comments (muted italic) ===
      { token: 'comment',         foreground: hex(isDark ? zinc[500] : zinc[500]), fontStyle: 'italic' },

      // === Identifiers (default neutral text) ===
      { token: 'identifier',      foreground: hex(isDark ? zinc[50] : zinc[900]) },

      // === Domain vocabulary terms — sky italic flags them as "your vocabulary" ===
      { token: 'variable.domain', foreground: hex(isDark ? sky[300] : sky[700]), fontStyle: 'italic' },

      // === Operators / delimiters (quiet so structure breathes) ===
      { token: 'operator',         foreground: hex(isDark ? zinc[300] : zinc[700]) },
      { token: 'delimiter',        foreground: hex(isDark ? zinc[400] : zinc[600]) },
      // Brackets carry subtle violet so scope is glanceable
      { token: 'delimiter.bracket', foreground: hex(isDark ? violet[300] : violet[600]) },
    ],
    colors: {
      // P1-R19: editor chrome now reads from imported token scales (violet, zinc)
      // instead of raw hex literals. Token updates propagate automatically.
      // Hex8 (RGBA) alpha suffixes kept inline — Monaco accepts standard CSS
      // hex8 syntax and design tokens are emitted as base hex6, so we append
      // the alpha here (no token escape).
      'editor.background':                     isDark ? zinc[950] : '#ffffff',
      'editor.foreground':                     isDark ? zinc[50]  : zinc[900],
      'editorLineNumber.foreground':           isDark ? zinc[600] : zinc[400],
      'editorLineNumber.activeForeground':     isDark ? violet[400] : violet[600],
      'editorCursor.foreground':               isDark ? violet[400] : violet[600],
      // Selection — primary subtle so the text remains legible underneath.
      'editor.selectionBackground':            (isDark ? violet[600] : violet[600]) + (isDark ? '40' : '30'),
      'editor.inactiveSelectionBackground':    (isDark ? violet[600] : violet[600]) + (isDark ? '20' : '18'),
      'editor.lineHighlightBackground':        isDark ? zinc[800] + '80' : zinc[50],
      // Bracket-pair highlight follows the brand
      'editorBracketMatch.background':         (isDark ? violet[600] : violet[600]) + (isDark ? '30' : '15'),
      'editorBracketMatch.border':             isDark ? violet[400] : violet[600],
      // Indent guides — quiet
      'editorIndentGuide.background':          isDark ? zinc[800] : zinc[200],
      'editorIndentGuide.activeBackground':    isDark ? zinc[700] : zinc[300],
      // Find / replace UI
      'editor.findMatchBackground':            (isDark ? violet[600] : violet[600]) + (isDark ? '50' : '30'),
      'editor.findMatchHighlightBackground':   (isDark ? violet[600] : violet[600]) + (isDark ? '30' : '18'),
    },
  });

  return themeName;
}

function isCommentLine(line: string): boolean {
  return /^\s*(?:\/\/|#)/.test(line);
}

function rangeContainsPosition(range: UseRef['moduleRange'], position: import('monaco-editor').Position): boolean {
  return (
    position.lineNumber === range.startLineNumber &&
    position.column >= range.startColumn &&
    position.column <= range.endColumn
  );
}

function versionsLabel(moduleEntry: AsterModuleCatalogEntry): string {
  return moduleEntry.versions.map((item) => item.version).join(', ');
}

function formatPublishedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

export function MonacoPolicyEditor({
  value,
  onChange,
  locale = 'en',
  domain,
  aliasSet,
  height = '400px',
  readOnly = false,
  placeholder,
  debounceDelay = 300,
  onEditorReady,
  enableAICompletion = false,
  onToggleAIPanel,
  onExplainSelection,
  onCompileChange,
}: MonacoPolicyEditorProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null);
  const inlineProviderDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const moduleCompletionProviderDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const moduleHoverProviderDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const inlineCompletionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { resolvedTheme } = useTheme();
  const t = useTranslations('diagnostics');
  const tEntry = useTranslations('policies.ruleSelector');
  const tModules = useTranslations('policies.modules');
  const [isEditorReady, setIsEditorReady] = useState(false);
  const [showProblems, setShowProblems] = useState(false);

  const isDark = resolvedTheme === 'dark';
  const baseLexicon = getLexicon(locale);
  const lexicon = useMemo<Lexicon>(() => {
    if (!aliasSet || Object.keys(aliasSet).length === 0) return baseLexicon;
    return {
      ...baseLexicon,
      aliases: {
        ...((baseLexicon as { aliases?: Record<string, readonly string[]> }).aliases ?? {}),
        ...aliasSet,
      },
    } as Lexicon;
  }, [baseLexicon, aliasSet]);

  // Map locale string to CNLLocale type for compiler
  // Handle both short ('zh', 'de') and full ('zh-CN', 'de-DE') locale formats
  const compilerLocale: CNLLocale = locale.startsWith('zh') ? 'zh-CN' : locale.startsWith('de') ? 'de-DE' : 'en-US';

  // 租户标识符 = 当前会话用户 id（cloud tenantId === userId）。仅作为引擎
  // registry 的自定义词汇分区键；服务端 API 已用 session.user.id 鉴权，
  // 此处不构成安全边界。
  const { data: session } = useSession();
  const tenantId = session?.user?.id;
  const moduleCatalog = useAsterModuleCatalog(Boolean(tenantId));
  const moduleCatalogRef = useRef<AsterModuleCatalogEntry[]>([]);
  /* ★补全 provider 注册一次即长期存活，闭包会捕获注册当时的 lexicon。
   *   locale/别名切换后若不经 ref 读取，补全会一直给旧语言的词——
   *   这类"注册时快照"是 Monaco provider 最常见的陈旧源。 */
  const lexiconRef = useRef<Lexicon>(lexicon);
  lexiconRef.current = lexicon;
  const moduleMessagesRef = useRef({
    moduleNotFound: (moduleName: string) => tModules('moduleNotFound', { moduleName }),
    versionNotFound: (moduleName: string, version: number, versions: string) =>
      tModules('versionNotFound', { moduleName, version, versions }),
    moduleVersionRequired: (moduleName: string) => tModules('moduleVersionRequired', { moduleName }),
    moduleCatalogLoadFailed: () => tModules('moduleCatalogLoadFailed'),
    moduleHoverSource: (functionName: string, versions: string) =>
      tModules('moduleHoverSource', { functionName, versions }),
    moduleHoverVersion: (version: number, publishedAt: string) =>
      tModules('moduleHoverVersion', { version, publishedAt }),
    moduleCompletionDetail: (functionName: string) =>
      tModules('moduleCompletionDetail', { functionName }),
    versionCompletionDetail: (moduleName: string) =>
      tModules('versionCompletionDetail', { moduleName }),
  });

  useEffect(() => {
    moduleCatalogRef.current = moduleCatalog.modules;
  }, [moduleCatalog.modules]);

  useEffect(() => {
    moduleMessagesRef.current = {
      moduleNotFound: (moduleName: string) => tModules('moduleNotFound', { moduleName }),
      versionNotFound: (moduleName: string, version: number, versions: string) =>
        tModules('versionNotFound', { moduleName, version, versions }),
      moduleVersionRequired: (moduleName: string) => tModules('moduleVersionRequired', { moduleName }),
      moduleCatalogLoadFailed: () => tModules('moduleCatalogLoadFailed'),
      moduleHoverSource: (functionName: string, versions: string) =>
        tModules('moduleHoverSource', { functionName, versions }),
      moduleHoverVersion: (version: number, publishedAt: string) =>
        tModules('moduleHoverVersion', { version, publishedAt }),
      moduleCompletionDetail: (functionName: string) =>
        tModules('moduleCompletionDetail', { functionName }),
      versionCompletionDetail: (moduleName: string) =>
        tModules('versionCompletionDetail', { moduleName }),
    };
  }, [tModules]);

  // ADR 0014 线B：把用户自定义领域词汇 registerCustom 进引擎，让编译/翻译层
  // 也能识别用户术语（而非仅高亮）。内部订阅 SSE 失效自动重新注册，返回组装
  // 后的用户词汇 + 随注册递增的 epoch。
  const { vocabulary: userVocabulary, epoch: userVocabEpoch } = useUserVocabularyRegistration({
    tenantId,
    domain,
    locale: compilerLocale,
  });

  // F10: subscribe to user-vocabulary SSE invalidates so a user adding /
  // removing a term in another tab triggers a re-fetch + Monaco
  // re-registration. The tick is folded into the vocabulary memo's deps so
  // every invalidate re-runs `getVocabulary` and downstream effects.
  const vocabTick = useDomainVocabularyInvalidate({
    enabled: Boolean(domain),
    match: domain ? { domain, locale: compilerLocale } : undefined,
  });
  // 高亮词汇：优先用户自定义词汇（已 registerCustom，含用户术语），缺省回退
  // 内置。userVocabEpoch 进 deps 保证用户增删词后高亮同步刷新。
  const vocabulary = useMemo(
    () => userVocabulary ?? (domain ? getVocabulary(domain, compilerLocale) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [domain, compilerLocale, vocabTick, userVocabulary, userVocabEpoch],
  );

  // Local compiler for real-time validation with accurate error positions
  // Monaco 实例句柄经 ref 持有；isEditorReady state 变化才重跑，读取的是编辑器
  // 就绪后的当前实例（非渲染派生值），传给 hook 属合法用法。
  /* eslint-disable react-hooks/refs */
  const { diagnostics, compileResult } = useAsterCompiler({
    editor: isEditorReady ? editorRef.current : null,
    monaco: isEditorReady ? monacoRef.current : null,
    locale: compilerLocale,
    domain,
    tenantId,
    userAliasSet: aliasSet,
    // 用户词异步注册成功后 epoch 递增，触发重新校验（否则 diagnostics 会
    // 停留在「未识别用户词」的旧结果直到用户再次输入）。
    externalInvalidationKey: `${userVocabEpoch}:${JSON.stringify(aliasSet ?? {})}`,
    debounceDelay,
    enableValidation: true,
  });
  /* eslint-enable react-hooks/refs */

  // 把编译结果上抛父层（StatusBar/SidePanel 复用，取代父层冗余 useCompile）。
  // 映射 TypecheckDiagnostic → 父层 CompileDiagnostic。★Aster span 的 line/col 均为 **1-based**
  // （与 Monaco 一致，见 useAsterCompiler.applyDiagnostics 直接透传不 +1）——故这里也不 +1，
  // 只 clamp≥1，保证父层 SidePanel 的列号与编辑器内部 Problems/marker 完全对齐（无 off-by-one）。
  useEffect(() => {
    if (!onCompileChange) return;
    const mapped: EditorCompileDiagnostic[] = diagnostics.map((d) => ({
      severity: d.severity,
      message: d.message,
      startLine: Math.max(1, d.span?.start.line ?? 1),
      startColumn: Math.max(1, d.span?.start.col ?? 1),
      endLine: Math.max(1, d.span?.end.line ?? d.span?.start.line ?? 1),
      endColumn: Math.max(1, d.span?.end.col ?? d.span?.start.col ?? 1),
      code: typeof d.code === 'string' ? d.code : d.code != null ? String(d.code) : undefined,
    }));
    // module 摘要：仅当编译成功产出 Core IR 时可得（父层 Decision 面板据此渲染）。
    // Core Module = { kind:'Module', name, decls:[{kind:'Func'|'Data'|'Enum'|'Import', name}] }。
    let moduleSummary: EditorCompileModuleSummary | undefined;
    const core = compileResult?.core as
      | { name?: string | null; decls?: ReadonlyArray<{ kind?: string; name?: string }> }
      | undefined;
    if (compileResult?.success && core?.name) {
      const decls = core.decls ?? [];
      moduleSummary = {
        name: core.name,
        functions: decls.filter((d) => d.kind === 'Func').map((d) => d.name ?? '').filter(Boolean),
        types: decls
          .filter((d) => d.kind === 'Data' || d.kind === 'Enum')
          .map((d) => d.name ?? '')
          .filter(Boolean),
      };
    }
    // state：空源码 idle，否则 ok。不用 'pending'——实时 validate() 是同步 debounce，
    // compiling 标志仅 compileSource()（手动全量编译）用，realtime 路径不置位，硬套会造成
    // 假 pending + 短暂 stale 诊断。'error' 态（parser crash）也归 ok：错误已作为 diagnostic
    // 呈现，StatusBar 的 error 态专用于 transportError（网络编译，此本地路径无）。
    const state: EditorCompileState['state'] =
      value.trim().length === 0 ? 'idle' : 'ok';
    onCompileChange({ state, diagnostics: mapped, module: moduleSummary });
  }, [diagnostics, compileResult, value, onCompileChange]);

  const { errorCount, warningCount } = useMemo(() => {
    let errors = 0;
    let warnings = 0;
    for (const d of diagnostics) {
      if (d.severity === 'error') errors++;
      else if (d.severity === 'warning') warnings++;
    }
    return { errorCount: errors, warningCount: warnings };
  }, [diagnostics]);

  // 同上：Monaco 实例经 ref 持有，isEditorReady 就绪后读取当前实例传给装饰 hook。
  /* eslint-disable react-hooks/refs */
  useEntryRuleDecorations(
    isEditorReady ? editorRef.current : null,
    isEditorReady ? monacoRef.current : null,
    value,
    tEntry('entryHover'),
  );
  /* eslint-enable react-hooks/refs */

  useEffect(() => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    const model = ed?.getModel();
    if (!isEditorReady || !monaco || !model) {
      return;
    }

    if (moduleCatalog.error) {
      monaco.editor.setModelMarkers(model, MODULE_CATALOG_MARKER_OWNER, [{
        severity: monaco.MarkerSeverity.Warning,
        message: moduleMessagesRef.current.moduleCatalogLoadFailed(),
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: Math.max(1, model.getLineMaxColumn(1)),
        source: MODULE_CATALOG_MARKER_OWNER,
      }]);
      return;
    }

    if (moduleCatalog.loading) {
      monaco.editor.setModelMarkers(model, MODULE_CATALOG_MARKER_OWNER, []);
      return;
    }

    const modulesByName = new Map(moduleCatalog.modules.map((item) => [item.moduleName, item]));
    const markers = extractUseRefs(value).flatMap((ref) => {
      const moduleEntry = modulesByName.get(ref.moduleName);
      if (!moduleEntry) {
        return [{
          severity: monaco.MarkerSeverity.Error,
          message: moduleMessagesRef.current.moduleNotFound(ref.moduleName),
          ...ref.moduleRange,
          source: MODULE_CATALOG_MARKER_OWNER,
        }];
      }

      if (ref.version === null) {
        return [{
          severity: monaco.MarkerSeverity.Warning,
          message: moduleMessagesRef.current.moduleVersionRequired(ref.moduleName),
          ...ref.moduleRange,
          source: MODULE_CATALOG_MARKER_OWNER,
        }];
      }

      if (!moduleEntry.versions.some((item) => item.version === ref.version)) {
        return [{
          severity: monaco.MarkerSeverity.Error,
          message: moduleMessagesRef.current.versionNotFound(ref.moduleName, ref.version, versionsLabel(moduleEntry)),
          ...(ref.versionRange ?? ref.moduleRange),
          source: MODULE_CATALOG_MARKER_OWNER,
        }];
      }

      return [];
    });

    monaco.editor.setModelMarkers(model, MODULE_CATALOG_MARKER_OWNER, markers);
  }, [isEditorReady, moduleCatalog.error, moduleCatalog.loading, moduleCatalog.modules, value]);

  const revealDiagnostic = useCallback((diag: TypecheckDiagnostic) => {
    const ed = editorRef.current;
    if (!ed) return;
    const line = diag.span?.start?.line ?? 1;
    const col = diag.span?.start?.col ?? 1;
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: col });
    ed.focus();
  }, []);

  // 编辑器挂载回调
  const handleEditorMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;

      // 注册 Aster Lang 语言
      registerAsterLanguage(monaco, lexicon, vocabulary);

      // 定义并应用主题
      const themeName = defineAsterTheme(monaco, isDark);
      monaco.editor.setTheme(themeName);

      // 注册快捷键：Ctrl+Shift+G / Cmd+Shift+G → 切换 AI Panel
      if (onToggleAIPanel) {
        editor.addAction({
          id: 'ai-toggle-panel',
          label: 'Toggle AI Assistant Panel',
          keybindings: [
            monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyG,
          ],
          run: () => onToggleAIPanel(),
        });
      }

      // 注册快捷键：Ctrl+Shift+E / Cmd+Shift+E → 解释选中代码
      if (onExplainSelection) {
        editor.addAction({
          id: 'ai-explain-selection',
          label: 'AI Explain Selected Code',
          keybindings: [
            monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyE,
          ],
          precondition: 'editorHasSelection',
          run: (ed) => {
            const selection = ed.getSelection();
            if (selection) {
              const selectedText = ed.getModel()?.getValueInRange(selection) ?? '';
              if (selectedText.trim()) {
                onExplainSelection(selectedText);
              }
            }
          },
        });
      }

      // 注册 AI inline 补全 provider
      if (enableAICompletion) {
        inlineProviderDisposableRef.current?.dispose();
        inlineProviderDisposableRef.current = monaco.languages.registerInlineCompletionsProvider(ASTER_LANG_ID, {
          provideInlineCompletions: async (model: editor.ITextModel, position: import('monaco-editor').Position, _context: import('monaco-editor').languages.InlineCompletionContext, token: import('monaco-editor').CancellationToken) => {
            // 取消前一个 debounce
            if (inlineCompletionTimerRef.current) clearTimeout(inlineCompletionTimerRef.current);

            // 仅在输入暂停 500ms 后触发
            return new Promise((resolve) => {
              inlineCompletionTimerRef.current = setTimeout(async () => {
                if (token.isCancellationRequested) {
                  resolve({ items: [] });
                  return;
                }

                const prefix = model.getValueInRange({
                  startLineNumber: Math.max(1, position.lineNumber - 10),
                  startColumn: 1,
                  endLineNumber: position.lineNumber,
                  endColumn: position.column,
                });

                if (!prefix.trim()) {
                  resolve({ items: [] });
                  return;
                }

                try {
                  // R23-Critical-2: 不再直连 aster-api，改走 server-side proxy
                  // /api/llm/complete。proxy 端做 NextAuth 鉴权 + HMAC 转签，
                  // 让 aster-api 的 InternalCallerFilter 能区分"已登录用户调用" vs
                  // "匿名公网调用"。caller-supplied X-Tenant-Id 不再被信任 ——
                  // server 端从 session 取真实 tenantId。
                  const headers: Record<string, string> = {
                    'Content-Type': 'application/json',
                  };

                  const abortCtrl = new AbortController();
                  token.onCancellationRequested(() => abortCtrl.abort());

                  const resp = await fetch(`/api/llm/complete`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ prefix, locale }),
                    signal: abortCtrl.signal,
                  });

                  if (!resp.ok || token.isCancellationRequested) {
                    resolve({ items: [] });
                    return;
                  }

                  const data = await resp.json();
                  const completion = data.completion;
                  if (!completion) {
                    resolve({ items: [] });
                    return;
                  }

                  resolve({
                    items: [{
                      insertText: completion,
                      range: {
                        startLineNumber: position.lineNumber,
                        startColumn: position.column,
                        endLineNumber: position.lineNumber,
                        endColumn: position.column,
                      },
                    }],
                  });
                } catch {
                  resolve({ items: [] });
                }
              }, 500);
            });
          },
          // Monaco 0.55+ 把旧 `freeInlineCompletions` 重命名为 `disposeInlineCompletions`，
          // 并改成 *必填*。缺它时编辑器 dispose 时报
          // "this.provider.disposeInlineCompletions is not a function" 然后整个 inline
          // completion 子系统崩。两个方法都放上保持向后兼容（旧版用 free，新版用 dispose）。
          freeInlineCompletions: () => {},
          disposeInlineCompletions: () => {},
        });
      }

      moduleCompletionProviderDisposableRef.current?.dispose();
      moduleCompletionProviderDisposableRef.current = monaco.languages.registerCompletionItemProvider(ASTER_LANG_ID, {
        triggerCharacters: [' ', '.'],
        provideCompletionItems: (model: editor.ITextModel, position: import('monaco-editor').Position) => {
          const lineUntilPosition = model.getValueInRange({
            startLineNumber: position.lineNumber,
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          });
          if (isCommentLine(lineUntilPosition)) {
            return { suggestions: [] };
          }

          const word = model.getWordUntilPosition(position);
          const wordRange = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };
          const modules = moduleCatalogRef.current;

          if (/^\s*(?:Use|\u5f15\u7528|verwende)\s+[\w\u4e00-\u9fff.]*$/i.test(lineUntilPosition)) {
            return {
              suggestions: modules.map((moduleEntry) => ({
                label: moduleEntry.moduleName,
                kind: monaco.languages.CompletionItemKind.Module,
                insertText: moduleEntry.moduleName,
                detail: moduleMessagesRef.current.moduleCompletionDetail(moduleEntry.functionName),
                documentation: moduleMessagesRef.current.moduleHoverSource(moduleEntry.functionName, versionsLabel(moduleEntry)),
                range: wordRange,
              })),
            };
          }

          const versionMatch = /^\s*(?:Use|\u5f15\u7528|verwende)\s+([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff]*(?:\.[A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff]*)*)\s+(?:(?:version|\u7248\u672c)\s+\d*)?$/i.exec(lineUntilPosition);
          if (!versionMatch) {
            /* ★关键词补全（浏览器内，不依赖 LSP）。
             *
             *   此前这里直接 `return { suggestions: [] }` —— 即只有 `Use` 行才有补全，
             *   其余位置**完全没有**关键词提示。而写 CNL 时绝大多数时间都不在 Use 行上。
             *
             *   ★关键词必须取自**当前 locale 的 lexicon**，不能硬编码英文：
             *   写 zh 的用户要敲的是「模块/规则/返回」，给他 `module/rule/return`
             *   等于每一条都是错的（选中即解析失败）。这与 aster-lang-ts#160 修的
             *   LSP 侧是同一类缺陷 —— 那边是 `Object.values(KW)` 硬编码英文。
             *
             *   别名一并纳入：识别侧本就多对一接受别名（ADR 0022），
             *   补全只给规范拼写的话，用户发现不了可以写更自然的别名。
             */
            const keywordLabels = collectKeywordLabels(lexiconRef.current);
            if (keywordLabels.length === 0) return { suggestions: [] };
            return {
              suggestions: keywordLabels.map((keyword) => ({
                label: keyword,
                kind: monaco.languages.CompletionItemKind.Keyword,
                insertText: keyword,
                range: wordRange,
              })),
            };
          }

          const moduleEntry = modules.find((item) => item.moduleName === versionMatch[1]);
          if (!moduleEntry) {
            return { suggestions: [] };
          }

          const completingNumber = /(?:\bversion|版本)\s+\d*$/i.test(lineUntilPosition);
          const range = completingNumber
            ? wordRange
            : {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: position.column,
                endColumn: position.column,
              };

          return {
            suggestions: moduleEntry.versions.map((version) => ({
              label: completingNumber ? String(version.version) : `version ${version.version}`,
              kind: monaco.languages.CompletionItemKind.Value,
              insertText: completingNumber ? String(version.version) : `version ${version.version}`,
              detail: moduleMessagesRef.current.versionCompletionDetail(moduleEntry.moduleName),
              documentation: formatPublishedAt(version.publishedAt),
              range,
            })),
          };
        },
      });

      moduleHoverProviderDisposableRef.current?.dispose();
      moduleHoverProviderDisposableRef.current = monaco.languages.registerHoverProvider(ASTER_LANG_ID, {
        provideHover: (model: editor.ITextModel, position: import('monaco-editor').Position) => {
          const ref = extractUseRefs(model.getValue()).find((item) => rangeContainsPosition(item.moduleRange, position));
          if (!ref) {
            return null;
          }

          const moduleEntry = moduleCatalogRef.current.find((item) => item.moduleName === ref.moduleName);
          if (!moduleEntry) {
            return null;
          }

          return {
            range: ref.moduleRange,
            contents: [
              { value: `**${moduleEntry.moduleName}**` },
              { value: moduleMessagesRef.current.moduleHoverSource(moduleEntry.functionName, versionsLabel(moduleEntry)) },
              ...moduleEntry.versions.map((version) => ({
                value: moduleMessagesRef.current.moduleHoverVersion(version.version, formatPublishedAt(version.publishedAt)),
              })),
            ],
          };
        },
      });

      setIsEditorReady(true);
      // Expose the monaco namespace on globalThis so sibling client code
      // can reach the single window-scoped monaco instance without each
      // remounting their own loader (@monaco-editor/react keeps one
      // instance per window). Diagnostics markers themselves are painted
      // by this editor's own useAsterCompiler.applyDiagnostics.
      (globalThis as { monaco?: typeof import('monaco-editor') }).monaco = monaco;
      onEditorReady?.(editor);
    },
    // tenantId 在 callback body 内已不再被引用（R23 之后 server-side
    // proxy 从 session 取 tenantId，不再依赖 caller-supplied X-Tenant-Id），
    // 故从 deps 移除，避免不必要的 callback 重建。
    [lexicon, isDark, vocabulary, onEditorReady, enableAICompletion, locale, onToggleAIPanel, onExplainSelection]
  );

  // 主题切换时更新
  useEffect(() => {
    if (monacoRef.current && isEditorReady) {
      const themeName = defineAsterTheme(monacoRef.current, isDark);
      monacoRef.current.editor.setTheme(themeName);
    }
  }, [isDark, isEditorReady]);

  // 语言或领域切换时更新词法
  useEffect(() => {
    if (monacoRef.current && isEditorReady) {
      registerAsterLanguage(monacoRef.current, lexicon, vocabulary);
    }
  }, [locale, lexicon, domain, vocabulary, isEditorReady]);

  // 组件卸载时释放 inline 补全 provider 及 timer，防止内存泄漏
  useEffect(() => {
    return () => {
      if (inlineCompletionTimerRef.current) clearTimeout(inlineCompletionTimerRef.current);
      inlineProviderDisposableRef.current?.dispose();
      moduleCompletionProviderDisposableRef.current?.dispose();
      moduleHoverProviderDisposableRef.current?.dispose();
      const model = editorRef.current?.getModel();
      if (model && monacoRef.current) {
        monacoRef.current.editor.setModelMarkers(model, MODULE_CATALOG_MARKER_OWNER, []);
      }
    };
  }, []);

  // 内容变更回调
  const handleChange: OnChange = useCallback(
    (value) => {
      onChange(value || '');
    },
    [onChange]
  );

  // When height is "100%" (set by policy-form/index.tsx so Monaco
  // fills the clamp-sized editor row), the wrapping <div> needs to be
  // a fixed-height flex column so Monaco's container has a concrete
  // height to measure. Without this, the wrapper's auto height resolves
  // to "whatever Monaco itself reports", which Monaco resolves to its
  // parent's offset height — a 0-height circular dependency. The
  // symptom: editor renders one screen of code, but its internal
  // scroller never activates and lines past the visible viewport
  // become unreachable.
  //
  // Layout chain inside the wrapper:
  //   - `editor-shell` (flex-1 min-h-0): claims remaining column space
  //     so Editor (height="100%" relative to it) gets a real number.
  //   - status row + optional diagnostics list: auto-height siblings
  //     stacked below.
  //
  // min-h-0 on the inner shell is the standard flex-shrink fix — its
  // default min-content is "everything Monaco reports it wants", which
  // pushes the column taller than its parent and re-introduces the
  // overflow loss.
  const fillsParent = height === '100%';
  const wrapperClass = fillsParent ? 'h-full flex flex-col' : '';
  return (
    <div
      className={`relative rounded-lg border border-border-strong dark:border-gray-600 [&_.monaco-editor]:rounded-lg ${wrapperClass}`}
    >
      <div className={fillsParent ? 'relative min-h-0 flex-1' : 'relative'}>
      <Editor
        height={height}
        language={ASTER_LANG_ID}
        value={value}
        onChange={handleChange}
        onMount={handleEditorMount}
        options={{
          readOnly,
          minimap: { enabled: false },
          fontSize: 14,
          fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Monaco, Consolas, monospace",
          lineNumbers: 'on',
          glyphMargin: true,
          renderLineHighlight: 'line',
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          tabSize: 2,
          insertSpaces: true,
          automaticLayout: true,
          bracketPairColorization: { enabled: true },
          padding: { top: 12, bottom: 12 },
          scrollbar: {
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10,
          },
          suggest: {
            showKeywords: true,
            showSnippets: true,
          },
          // 修复 hover tooltip 超出边界被裁剪的问题
          fixedOverflowWidgets: true,
        }}
        loading={
          <div className="flex items-center justify-center h-full bg-bg dark:bg-gray-900 text-fg-muted dark:text-fg-subtle">
            Loading editor...
          </div>
        }
      />
      {!value && placeholder && (
        <div aria-hidden="true" className="absolute top-3 left-14 text-fg-muted pointer-events-none text-sm font-mono">
          {placeholder}
        </div>
      )}
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-fg-muted">
        <div className="flex items-center gap-2" role="status" aria-live="polite">
          {errorCount > 0 && (
            <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-200">
              {t('errors', { count: errorCount })}
            </span>
          )}
          {warningCount > 0 && (
            <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-200">
              {t('warnings', { count: warningCount })}
            </span>
          )}
          {errorCount === 0 && warningCount === 0 && (
            <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/40 dark:text-green-200">
              {t('noIssues')}
            </span>
          )}
        </div>
        {(errorCount > 0 || warningCount > 0) && (
          <button
            type="button"
            onClick={() => setShowProblems(prev => !prev)}
            aria-expanded={showProblems}
            className="text-xs font-medium text-primary hover:text-primary"
          >
            {showProblems ? t('hideProblems') : t('viewProblems')}
          </button>
        )}
      </div>
      {showProblems && diagnostics.length > 0 && (
        <ul role="list" className="mt-2 rounded-lg border border-border bg-bg divide-y divide-border dark:border-gray-700 dark:bg-gray-900 dark:divide-gray-800">
          {diagnostics
            .filter(d => d.severity === 'error' || d.severity === 'warning')
            .map((diag, i) => (
              <li key={`${diag.message}-${i}`}>
                <button
                  type="button"
                  onClick={() => revealDiagnostic(diag)}
                  className="flex w-full items-start gap-2 px-3 py-2 text-left text-xs text-fg hover:bg-bg-subtle dark:text-gray-200 dark:hover:bg-gray-800"
                >
                  <span
                    className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${diag.severity === 'error' ? 'bg-red-500' : 'bg-amber-500'}`}
                    aria-hidden="true"
                  />
                  <span className="flex-1">{diag.message}</span>
                  <span className="shrink-0 text-fg-subtle">
                    L{diag.span?.start?.line ?? 1}:{diag.span?.start?.col ?? 1}
                  </span>
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

// 注意：示例策略模板已迁移至 @/config/aster-policy-templates.ts
// 以避免静态导入导致 Monaco 编辑器动态加载失效
