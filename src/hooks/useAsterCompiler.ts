/**
 * useAsterCompiler Hook
 *
 * Provides local CNL compilation using the aster-lang-ts browser bundle.
 * This is a lightweight alternative to the LSP hook that works in:
 * - Browser environments
 * - Cloudflare Workers/Pages
 * - Edge runtimes
 *
 * Features:
 * - Real-time syntax validation
 * - Local compilation to Core IR
 * - No external server required
 * - Debounced validation for performance
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { editor } from 'monaco-editor';
import { localizeParseMessage } from '@/lib/parse-diagnostic-l10n';
import {
  compileAndTypecheck,
  extractSchema,
  generateInputValues,
  EN_US,
  ZH_CN,
  DE_DE,
  type CompileResult,
  type DomainVocabulary,
  type SchemaResult,
  type Lexicon,
  type TypecheckDiagnostic,
} from '@aster-cloud/aster-lang-ts/browser';

export type CNLLocale = 'en-US' | 'zh-CN' | 'de-DE';

/** Map locale strings to Lexicon objects */
const LEXICON_MAP: Record<CNLLocale, Lexicon> = {
  'en-US': EN_US,
  'zh-CN': ZH_CN,
  'de-DE': DE_DE,
};

export interface UseAsterCompilerOptions {
  /** Monaco editor instance */
  editor: editor.IStandaloneCodeEditor | null;
  /** Monaco instance (from @monaco-editor/react) */
  monaco: typeof import('monaco-editor') | null;
  /** CNL language locale */
  locale?: CNLLocale;
  /** 领域标识符（如 'insurance.auto'），启用领域标识符翻译 */
  domain?: string;
  /**
   * 租户标识符。提供时，领域词汇翻译优先命中该租户经
   * `vocabularyRegistry.registerCustom` 注册的自定义词汇（用户自定义术语），
   * 未命中再回退到内置词汇。
   */
  tenantId?: string;
  /**
   * 作者领域词汇（ADR 0051）：提供时优先于 domain / tenantId，引擎据此构建 VocabularyScopes
   * 按位置解析源码中的本地化名字——与服务端保存/执行使用同一份词汇。
   */
  vocabulary?: DomainVocabulary;
  /** 用户策略层关键词别名，kind → 多词别名。 */
  userAliasSet?: Readonly<Record<string, readonly string[]>> | null;
  /**
   * 外部失效键。当其值变化时强制重新校验当前源码。用于「用户自定义词汇
   * 异步注册完成」这类不改源码但需重编译的场景：注册 hook 每次注册成功递增
   * epoch，传入此处即可在注册后自动刷新 diagnostics（否则要等用户再输入）。
   */
  externalInvalidationKey?: unknown;
  /** Debounce delay for validation in ms */
  debounceDelay?: number;
  /** Enable real-time validation */
  enableValidation?: boolean;
}

export interface UseAsterCompilerResult {
  /** Last compilation result */
  compileResult: CompileResult | null;
  /** Whether currently compiling */
  compiling: boolean;
  /** Validation errors (for display) */
  errors: string[];
  /** Type check diagnostics with position information */
  diagnostics: TypecheckDiagnostic[];
  /** Manually compile the current source */
  compileSource: () => CompileResult | null;
  /** Manually validate the current source (includes type checking) */
  validate: () => TypecheckDiagnostic[];
  /** Clear all errors */
  clearErrors: () => void;
  /** Extract schema from source (for dynamic form generation) */
  getSchema: (functionName?: string) => SchemaResult | null;
  /** Generate sample input values from schema */
  getSampleInputs: (functionName?: string) => Record<string, unknown> | null;
}

type DiagnosticCode = TypecheckDiagnostic['code'];

/**
 * 把一次 compileAndTypecheck 结果里的全部诊断汇总成编辑器可标记的列表。
 *
 * 顺序：解析错误 → 名称解析诊断（ADR 0051 E8xx 错误 / W8xx 警告）→ 降级错误 → 类型诊断。
 * 名称解析失败时引擎不做类型检查（typeErrors 为空），E8xx 只出现在 resolutionDiagnostics，
 * 因此必须单独收集，否则编辑器对「词汇里没有这个名字」之类的错误毫无标记。
 * 引擎诊断消息原样透传，与 typeErrors 一致（服务端 /compile 也原样转发）。
 */
export function collectCompileDiagnostics(
  result: CompileResult & { typeErrors?: readonly TypecheckDiagnostic[] },
  locale?: string,
): TypecheckDiagnostic[] {
  const all: TypecheckDiagnostic[] = [];

  for (const err of result.parseErrors ?? []) {
    const parseError = err as { message: string; span?: TypecheckDiagnostic['span'] };
    all.push({
      severity: 'error',
      code: 'E000' as DiagnosticCode,
      // 解析错误按策略语言译出句子骨架（引擎尚无解析错误 overlay，见 parse-diagnostic-l10n）
      message: localizeParseMessage(parseError.message, locale),
      span: parseError.span,
    });
  }

  all.push(...(result.resolutionDiagnostics ?? []));

  for (const message of result.loweringErrors ?? []) {
    all.push({ severity: 'error', code: 'E000' as DiagnosticCode, message: localizeParseMessage(message, locale) });
  }

  all.push(...(result.typeErrors ?? []));
  return all;
}

/**
 * Hook for local CNL compilation without external LSP server
 *
 * @example
 * ```typescript
 * const { compileResult, errors, compileSource } = useAsterCompiler({
 *   editor: monacoEditor,
 *   locale: 'en-US',
 * });
 *
 * // Compile on demand
 * const result = compileSource();
 * if (result?.success) {
 *   console.log('Core IR:', result.core);
 * }
 * ```
 */
export function useAsterCompiler({
  editor,
  monaco,
  locale = 'en-US',
  domain,
  tenantId,
  vocabulary,
  userAliasSet,
  externalInvalidationKey,
  debounceDelay = 300,
  enableValidation = true,
}: UseAsterCompilerOptions): UseAsterCompilerResult {
  const [compileResult, setCompileResult] = useState<CompileResult | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [diagnostics, setDiagnostics] = useState<TypecheckDiagnostic[]>([]);

  const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ref-latch：把最新的 editor/monaco prop 存进 ref，让稳定的 useCallback
  // （getSource/applyDiagnostics 等，deps 为空）始终读到最新实例而无需重建。
  // 属渲染期镜像最新 prop 的惯用写法，不用于本次渲染输出。
  const editorRef = useRef(editor);
  // eslint-disable-next-line react-hooks/refs
  editorRef.current = editor;
  const monacoRef = useRef(monaco);
  // eslint-disable-next-line react-hooks/refs
  monacoRef.current = monaco;

  const baseLexicon = LEXICON_MAP[locale];
  const lexicon = useMemo(
    () => userAliasSet && Object.keys(userAliasSet).length > 0
      ? {
          ...baseLexicon,
          aliases: {
            ...((baseLexicon as { aliases?: Record<string, readonly string[]> }).aliases ?? {}),
            ...userAliasSet,
          },
        }
      : baseLexicon,
    [baseLexicon, userAliasSet],
  );

  /**
   * Get the current source code from the editor
   */
  const getSource = useCallback((): string | null => {
    const currentEditor = editorRef.current;
    if (!currentEditor) return null;
    const model = currentEditor.getModel();
    if (!model) return null;
    return model.getValue();
  }, []);

  /**
   * Apply diagnostics to Monaco editor as markers with proper position info
   */
  const applyDiagnostics = useCallback(
    (typecheckDiagnostics: TypecheckDiagnostic[]) => {
      const currentEditor = editorRef.current;
      const currentMonaco = monacoRef.current;

      if (!currentEditor || !currentMonaco) {
        return;
      }

      const model = currentEditor.getModel();
      if (!model) {
        return;
      }

      if (typecheckDiagnostics.length === 0) {
        // Clear markers
        currentMonaco.editor.setModelMarkers(model, 'aster-compiler', []);
        return;
      }

      // Convert TypecheckDiagnostic to Monaco markers with proper positions
      const markers = typecheckDiagnostics.map((diag) => {
        // Get severity
        const severity =
          diag.severity === 'error'
            ? currentMonaco.MarkerSeverity.Error
            : diag.severity === 'warning'
              ? currentMonaco.MarkerSeverity.Warning
              : currentMonaco.MarkerSeverity.Info;

        // Extract position from span (1-indexed for Monaco)
        // Aster uses 1-indexed positions, which matches Monaco
        const hasSpan = diag.span && diag.span.start && diag.span.end;
        const startLine = hasSpan ? diag.span!.start.line : 1;
        const startCol = hasSpan ? diag.span!.start.col : 1;
        const endLine = hasSpan ? diag.span!.end.line : startLine;
        const endCol = hasSpan ? diag.span!.end.col : model.getLineMaxColumn(startLine);

        return {
          severity,
          message: diag.message,
          startLineNumber: startLine,
          startColumn: startCol,
          endLineNumber: endLine,
          endColumn: endCol,
          code: diag.code,
          source: 'aster-compiler',
        };
      });

      currentMonaco.editor.setModelMarkers(model, 'aster-compiler', markers);
    },
    []
  );

  /**
   * Validate the current source (compile + typecheck)
   */
  const validate = useCallback((): TypecheckDiagnostic[] => {
    const source = getSource();
    if (!source) {
      // 空源码：清空实时编译结果 + 诊断（否则 module 摘要/Problems 会停留在上一次旧值）。
      setCompileResult(null);
      setDiagnostics([]);
      setErrors([]);
      return [];
    }

    try {
      const result = compileAndTypecheck(source, { lexicon, vocabulary, domain, tenantId });
      // 实时校验也保存 compileResult，使消费方（如上抛给父层的 module 摘要）能拿到
      // 最新 Core IR，而不必单独调 compileSource()。二者本质是同一 compileAndTypecheck 调用。
      setCompileResult(result);

      const allDiagnostics = collectCompileDiagnostics(result, locale);

      setDiagnostics(allDiagnostics);
      setErrors(allDiagnostics.map((d) => d.message));
      return allDiagnostics;
    } catch (error) {
      const errorDiag: TypecheckDiagnostic = {
        severity: 'error',
        code: 'E000' as import('@aster-cloud/aster-lang-ts/browser').TypecheckDiagnostic['code'],
        message: error instanceof Error ? error.message : String(error),
      };
      setDiagnostics([errorDiag]);
      setErrors([errorDiag.message]);
      setCompileResult(null); // 解析崩溃 → 无有效 module
      return [errorDiag];
    }
  }, [getSource, lexicon, locale, vocabulary, domain, tenantId]);

  /**
   * Compile the current source
   */
  const compileSource = useCallback((): CompileResult | null => {
    const source = getSource();
    if (!source) return null;

    setCompiling(true);
    try {
      const result = compileAndTypecheck(source, { lexicon, vocabulary, domain, tenantId });
      setCompileResult(result);

      const allDiagnostics = collectCompileDiagnostics(result, locale);

      setDiagnostics(allDiagnostics);
      setErrors(allDiagnostics.map((d) => d.message));

      return result;
    } finally {
      setCompiling(false);
    }
  }, [getSource, lexicon, locale, vocabulary, domain, tenantId]);

  /**
   * Clear all errors
   */
  const clearErrors = useCallback(() => {
    setErrors([]);
    setDiagnostics([]);
    applyDiagnostics([]);
  }, [applyDiagnostics]);

  /**
   * Extract schema from source code for dynamic form generation
   */
  const getSchema = useCallback(
    (functionName?: string): SchemaResult | null => {
      const source = getSource();
      if (!source) return null;

      return extractSchema(source, { lexicon, functionName });
    },
    [getSource, lexicon]
  );

  /**
   * Generate sample input values from schema
   */
  const getSampleInputs = useCallback(
    (functionName?: string): Record<string, unknown> | null => {
      const schema = getSchema(functionName);
      if (!schema?.success || !schema.parameters) return null;

      return generateInputValues(schema.parameters, lexicon);
    },
    [getSchema, lexicon]
  );

  /**
   * Debounced validation on content change
   */
  const debouncedValidate = useCallback(() => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    debounceTimeoutRef.current = setTimeout(() => {
      const validationDiagnostics = validate();
      applyDiagnostics(validationDiagnostics);
    }, debounceDelay);
  }, [validate, applyDiagnostics, debounceDelay]);

  // Set up content change listener for real-time validation
  useEffect(() => {
    if (!editor || !enableValidation) return;

    const model = editor.getModel();
    if (!model) return;

    // Initial validation
    // 挂载/依赖变化时对当前源码做一次初始校验，validate 内部写入 diagnostics/errors。
    // 属正常的编译副作用（非无条件每次渲染的级联 setState）。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    const initialErrors = validate();
    applyDiagnostics(initialErrors);

    // Listen for content changes
    const disposable = model.onDidChangeContent(() => {
      debouncedValidate();
    });

    return () => {
      disposable.dispose();
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
    // externalInvalidationKey 进 deps：用户词异步注册完成后（不改源码）也能
    // 重新校验，清除「词已注册但仍报错」的陈旧 diagnostics。
  }, [editor, enableValidation, validate, applyDiagnostics, debouncedValidate, externalInvalidationKey]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, []);

  return {
    compileResult,
    compiling,
    errors,
    diagnostics,
    compileSource,
    validate,
    clearErrors,
    getSchema,
    getSampleInputs,
  };
}

// Re-export types for convenience
export type { SchemaResult, ParameterInfo } from '@aster-cloud/aster-lang-ts/browser';
