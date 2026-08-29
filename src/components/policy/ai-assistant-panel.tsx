'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useAIAssistant } from '@/hooks/useAIAssistant';
import { denialMessage } from '@/lib/llm-error';
import { AIDiffPreview } from './ai-diff-preview';
import { track, Events } from '@/lib/mixpanel';
import {
  classifyProseLine,
  extractAsterCode,
  parseSegments,
} from '@/lib/extract-aster-code';
import type { editor } from 'monaco-editor';

// NSM/WAADR 埋点会话上下文：将 ai_draft_generated 与后续 draft_edited 关联
// 使用全局 window 对象传递，避免穿透多层组件
declare global {
  interface Window {
    __asterAiDraft?: {
      promptId: string;
      content: string;
      generatedAt: number;
      lang: string;
      model: string;
      repairCount: number;
    };
  }
}

const genPromptId = () =>
  `pd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

interface AIAssistantPanelProps {
  editor: editor.IStandaloneCodeEditor | null;
  locale: string;
  tenantId?: string;
  onApply: (source: string) => void;
  onClose: () => void;
}

export function AIAssistantPanel({
  editor: monacoEditor,
  locale,
  tenantId,
  onApply,
  onClose,
}: AIAssistantPanelProps) {
  const t = useTranslations('ai');
  // ★注意：props.locale 是 **cnlLocale**（生成策略用的 CNL 语言），
  //   不是界面语言。设置页链接必须用 UI locale，
  //   否则会把中文界面的用户送到英文设置页。
  const uiLocale = useLocale();
  const [prompt, setPrompt] = useState('');
  const [showDiffPreview, setShowDiffPreview] = useState(false);
  const [originalSource, setOriginalSource] = useState('');
  const [autoApplied, setAutoApplied] = useState(false);
  // 区分本次输出来自 generate（单份完整策略→底部整体应用）还是 suggest
  // （优化建议 markdown 多代码块→靠每块的 拷贝/插入/替换 按钮操作）。
  const [lastAction, setLastAction] = useState<'generate' | 'suggest' | null>(
    null,
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const generationCtxRef = useRef<{ promptId: string; startedAt: number; goal: string } | null>(null);
  const {
    streaming,
    content,
    error,
    denial,
    validationError,
    completed,
    validated,
    repairProgress,
    generate,
    suggest,
    cancel,
    reset,
  } = useAIAssistant();

  // 聚焦输入框
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // R30+ audit P2：原版把 window.__asterAiDraft 写完就再也没清，反复
  // 开关 AI 面板会让旧 draftId 在 NSM 埋点流里继续被识别成"上次的草稿"。
  // 卸载时主动 clean up，让下一次 mount 重新建上下文。
  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && window.__asterAiDraft) {
        delete window.__asterAiDraft;
      }
    };
  }, []);

  // 编译通过时自动填充到编辑器。仅 generate（单份完整策略）自动应用；suggest
  // 优化建议是多代码块 markdown，必须靠每块的 拷贝/插入/替换 按钮由用户选择，
  // 不能整体自动替换编辑器（防御后端 final/validated 语义变化误伤）。
  useEffect(() => {
    if (lastAction === 'generate' && completed && validated && content && !autoApplied) {
      // 流式完成且编译通过时一次性自动填充编辑器；!autoApplied 守卫防止重触发，
      // 从 completed/validated 等外部完成信号派生，非渲染循环。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAutoApplied(true);

      // 只插纯 aster 代码：LLM 可能违反 no-markdown 约定而包 ```aster 围栏
      // 或夹带散文，直接插整段会污染编辑器。extractAsterCode 剥离 markdown。
      // 提前到埋点之前：draft 上下文/char_count 必须记录实际写入编辑器的
      // code（而非 raw markdown），否则下游 aiDraft.content !== fields.content
      // 会把「未编辑」误判成 ai_draft_edited。
      const code = extractAsterCode(content);

      // NSM 埋点：AI 草稿生成完成
      const ctx = generationCtxRef.current;
      if (ctx) {
        const latencyMs = Date.now() - ctx.startedAt;
        track(Events.AI_DRAFT_GENERATED, {
          prompt_id: ctx.promptId,
          lang: locale,
          model: 'gpt-5.2',
          latency_ms: latencyMs,
          char_count: code.length,
          validated: true,
          auto_applied: true,
        });
        // 写入会话上下文，供后续 draft_edited 事件使用
        if (typeof window !== 'undefined') {
          window.__asterAiDraft = {
            promptId: ctx.promptId,
            content: code,
            generatedAt: Date.now(),
            lang: locale,
            model: 'gpt-5.2',
            repairCount: 0,
          };
        }
      }

      if (monacoEditor) {
        const model = monacoEditor.getModel();
        if (model) {
          monacoEditor.executeEdits('ai-assistant', [
            {
              range: model.getFullModelRange(),
              text: code,
            },
          ]);
        }
      }
      onApply(code);
    }
  }, [lastAction, completed, validated, content, autoApplied, monacoEditor, onApply, locale]);

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) return;

    setAutoApplied(false);
    setLastAction('generate');
    const existingSource = monacoEditor?.getValue() || '';
    setOriginalSource(existingSource);

    // NSM 埋点：记录生成会话起点（promptId 关联 draft_edited）
    generationCtxRef.current = {
      promptId: genPromptId(),
      startedAt: Date.now(),
      goal: prompt.trim(),
    };

    await generate(
      {
        goal: prompt.trim(),
        locale,
        existingSource: existingSource || undefined,
      },
      tenantId,
    );

  }, [prompt, monacoEditor, locale, tenantId, generate]);

  const handleSuggest = useCallback(async () => {
    const source = monacoEditor?.getValue();
    if (!source?.trim()) return;

    setAutoApplied(false);
    setLastAction('suggest');
    await suggest(
      { source, locale },
      tenantId,
    );
  }, [monacoEditor, locale, tenantId, suggest]);

  const handleShowDiff = useCallback(() => {
    if (!content) return;
    setShowDiffPreview(true);
  }, [content]);

  const handleApply = useCallback(() => {
    if (!content) return;

    // 同 auto-apply：剥离 markdown，只插纯 aster 代码 snippet。
    const code = extractAsterCode(content);
    if (monacoEditor) {
      const model = monacoEditor.getModel();
      if (model) {
        monacoEditor.executeEdits('ai-assistant', [
          {
            range: model.getFullModelRange(),
            text: code,
          },
        ]);
      }
    }
    onApply(code);
    setShowDiffPreview(false);
    reset();
  }, [content, monacoEditor, onApply, reset]);

  // 代码块级操作（Augment 风格）：每个 AI 输出的代码块可独立拷贝 / 插入到
  // 光标 / 整体替换编辑器，而不必只对整段输出做单一「应用」。
  const copyCodeBlock = useCallback(async (code: string) => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
    try {
      await navigator.clipboard.writeText(code);
      return true;
    } catch {
      return false;
    }
  }, []);

  const insertCodeBlock = useCallback(
    (code: string) => {
      if (!monacoEditor) return;
      const selection = monacoEditor.getSelection();
      const range = selection ?? {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 1,
      };
      monacoEditor.executeEdits('ai-assistant-insert-block', [
        { range, text: code, forceMoveMarkers: true },
      ]);
      monacoEditor.focus();
    },
    [monacoEditor],
  );

  const replaceCodeBlock = useCallback(
    (code: string) => {
      if (monacoEditor) {
        const model = monacoEditor.getModel();
        if (model) {
          monacoEditor.executeEdits('ai-assistant-replace-block', [
            { range: model.getFullModelRange(), text: code },
          ]);
        }
      }
      onApply(code);
    },
    [monacoEditor, onApply],
  );

  const handleRetry = useCallback(() => {
    setAutoApplied(false);
    reset();

    handleGenerate();
  }, [reset, handleGenerate]);

  const handleReject = useCallback(() => {
    setShowDiffPreview(false);
    setAutoApplied(false);
    reset();
  }, [reset]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleGenerate();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [handleGenerate, onClose],
  );

  return (
    // min-w-0 + max-w-full belt-and-suspenders: when this panel
    // lives inside the side-panel's 28rem column on the policy
    // form, child Monaco editors (diff preview, code blocks) can
    // request widths that exceed the parent. The min-w-0 lets the
    // flex parent shrink past content's "intrinsic" min-width,
    // and max-w-full caps absolute overflow from leaking sideways
    // into the main editor pane.
    <aside
      className="flex flex-col border border-border dark:border-gray-700 rounded-xl bg-bg dark:bg-gray-800 shadow-lg overflow-hidden min-w-0 max-w-full"
      role="complementary"
      aria-label={t('panelTitle')}
    >
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border dark:border-gray-700 bg-bg-subtle dark:bg-gray-800/50">
        <div className="flex items-center gap-2">
          <svg className="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
          </svg>
          <h3 className="text-sm font-semibold text-fg dark:text-gray-100">
            {t('panelTitle')}
          </h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-md text-fg-subtle hover:text-fg-muted dark:hover:text-gray-300"
          aria-label={t('close')}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* 输入区域 */}
      <div className="px-4 pt-3 pb-2">
        {/* R30+ audit P1：visually-hidden label 让屏幕阅读器拿到 control 名字，
            键盘 / 触摸用户依然看到 placeholder。比单纯 aria-label 更稳：
            屏幕阅读器的 label 元素 navigation 会包括它。 */}
        <label htmlFor="ai-assistant-prompt" className="sr-only">
          {t('promptPlaceholder')}
        </label>
        <textarea
          id="ai-assistant-prompt"
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('promptPlaceholder')}
          rows={3}
          disabled={streaming}
          aria-describedby="ai-assistant-shortcut-hint"
          className="w-full rounded-lg border border-border-strong dark:border-gray-600 bg-bg dark:bg-gray-900 px-3 py-2 text-sm text-fg dark:text-gray-100 placeholder-gray-400 focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none resize-none disabled:opacity-50"
        />
        <div className="mt-2 flex items-center justify-between">
          <span id="ai-assistant-shortcut-hint" className="text-xs text-fg-subtle">
            {t('shortcutHint')}
          </span>
          <div className="flex gap-2">
            {streaming ? (
              <button
                type="button"
                onClick={cancel}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50"
              >
                <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 16 16">
                  <rect x="3" y="3" width="10" height="10" rx="1" />
                </svg>
                {t('stop')}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleSuggest}
                  disabled={!monacoEditor?.getValue()?.trim()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong dark:border-gray-600 bg-bg dark:bg-gray-800 px-3 py-1.5 text-xs font-medium text-fg dark:text-gray-300 hover:bg-bg-subtle dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
                  </svg>
                  {t('suggest')}
                </button>
                <button
                  type="button"
                  onClick={handleGenerate}
                  disabled={!prompt.trim()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                  </svg>
                  {t('generate')}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 流式输出区域 */}
      {(streaming || content) && (
        <div className="flex-1 px-4 pb-3 overflow-auto">
          <div className="rounded-lg border border-border dark:border-gray-700 bg-bg-subtle dark:bg-gray-900 p-3">
            {/* 状态指示 */}
            {streaming && (
              <div className="flex items-center gap-2 mb-2 text-xs text-primary dark:text-primary">
                <div className="flex gap-0.5">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-bounce [animation-delay:0ms]" />
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-bounce [animation-delay:150ms]" />
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-bounce [animation-delay:300ms]" />
                </div>
                {repairProgress
                  ? `${t('repairing')} (${repairProgress})`
                  : t('generating')
                }
              </div>
            )}

            {/* AI 输出预览：markdown 感知渲染（散文成段、```代码块高亮成盒），
                而非把 markdown 当纯文本平铺。流式时末尾追加光标。 */}
            <div className="max-h-64 overflow-auto">
              <AiOutputView
                content={content}
                streaming={streaming}
                uiLocale={locale}
                onCopyCode={copyCodeBlock}
                onInsertCode={monacoEditor ? insertCodeBlock : undefined}
                onReplaceCode={replaceCodeBlock}
              />
            </div>
          </div>

          {/* 修复中校验错误（流式过程中短暂显示） */}
          {validationError && streaming && (
            <div className="mt-2 flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 p-2 text-xs text-amber-700 dark:text-amber-300">
              <svg className="h-4 w-4 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <span>{t('validationFailed')}</span>
            </div>
          )}

          {/* 编译通过 + 自动填充 */}
          {completed && validated && (
            <div className="mt-2 flex items-center gap-2 rounded-lg bg-green-50 dark:bg-green-900/20 p-2 text-xs text-green-700 dark:text-green-300">
              <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>{t('autoApplied')}</span>
            </div>
          )}

          {/* 编译未通过（修复用尽） */}
          {completed && !validated && !error && validationError && (
            <div className="mt-2 flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 p-2 text-xs text-amber-700 dark:text-amber-300">
              <svg className="h-4 w-4 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <span>{t('validationFailed')}: {validationError}</span>
            </div>
          )}

          {/* 错误 */}
          {error && (
            <div className="mt-2 flex items-start gap-2 rounded-lg bg-red-50 dark:bg-red-900/20 p-2 text-xs text-red-700 dark:text-red-300">
              <svg className="h-4 w-4 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
              {/* ★按**结构化原因码**选本地化文案；denial 为空（如流内 error 事件）
                  才回落到 error 串。此前这里直接渲染 `HTTP 403: {"error":…}`
                  这行原始 JSON，用户只能去开控制台看真实原因。
                  服务端 message 是硬编码中文，故**不能**直接透传给 en/de/hi。 */}
              <span>
                {denialMessage(denial, t) ?? error}
                {denial?.reason === 'ai_email_unverified' && (
                  <>
                    {' '}
                    <a
                      href={`/${uiLocale}/settings`}
                      className="underline font-medium hover:no-underline"
                    >
                      {t('goVerifyEmail')}
                    </a>
                  </>
                )}
              </span>
            </div>
          )}

          {/* 操作按钮组：Retry/Reject 两种模式都保留；底部整体 Apply/Diff 仅
              generate（单份完整策略）显示——suggest 优化建议是多代码块 markdown，
              改用每个代码块 header 上的 拷贝/插入/替换 按钮操作，不再用底部单一
              「应用」。 */}
          {completed && content && !streaming && !showDiffPreview && !autoApplied && (
            <div className="mt-3 flex items-center gap-2">
              {lastAction !== 'suggest' &&
                (originalSource ? (
                  <button
                    type="button"
                    onClick={handleShowDiff}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-hover"
                  >
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
                    </svg>
                    {t('diffPreview')}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleApply}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-hover"
                  >
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                    {t('apply')}
                  </button>
                ))}
              <button
                type="button"
                onClick={handleRetry}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong dark:border-gray-600 bg-bg dark:bg-gray-800 px-3 py-1.5 text-xs font-medium text-fg dark:text-gray-300 hover:bg-bg-subtle dark:hover:bg-gray-700"
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
                </svg>
                {t('retry')}
              </button>
              <button
                type="button"
                onClick={handleReject}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong dark:border-gray-600 bg-bg dark:bg-gray-800 px-3 py-1.5 text-xs font-medium text-fg dark:text-gray-300 hover:bg-bg-subtle dark:hover:bg-gray-700"
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
                {t('reject')}
              </button>
            </div>
          )}

          {/* Diff 预览 */}
          {showDiffPreview && content && (
            <div className="mt-3">
              <AIDiffPreview
                original={originalSource}
                // diff 展示实际会插入的纯代码（与 handleApply 一致），
                // 而非含 markdown 的原始输出，避免预览与结果不符。
                generated={extractAsterCode(content)}
                onAccept={handleApply}
                onReject={handleReject}
              />
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* AI 输出渲染                                                          */
/* ------------------------------------------------------------------ */

/** 极简内联 markdown → React 节点：**加粗** 与 `行内代码`。不引入依赖。 */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // 交替匹配 **bold** 与 `code`，其余为纯文本。
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[2] !== undefined) {
      nodes.push(
        <strong key={`${keyPrefix}-b-${i}`} className="font-semibold text-fg">
          {m[2]}
        </strong>,
      );
    } else if (m[4] !== undefined) {
      nodes.push(
        <code
          key={`${keyPrefix}-c-${i}`}
          className="rounded bg-bg-muted px-1 py-0.5 font-mono text-[0.85em] text-fg"
        >
          {m[4]}
        </code>,
      );
    }
    last = re.lastIndex;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/**
 * 渲染散文段：把段落内的行按 markdown 行级语法分派——标题（#/##/###…）渲染成
 * 对应字号 heading、无序列表（-/* ）渲染成列表项、其余为普通行。行内仍走
 * renderInline（加粗/行内代码）。不引入 markdown 依赖，只覆盖 AI 实际输出的
 * 行级结构（此前 ### 改进片段 直接当字面文本显示的 bug）。
 */
function renderProse(text: string, keyPrefix: string): React.ReactNode {
  const lines = text.split('\n');
  const nodes: React.ReactNode[] = [];
  let listBuf: string[] = [];

  const flushList = (key: string) => {
    if (listBuf.length === 0) return;
    const items = listBuf;
    listBuf = [];
    nodes.push(
      <ul key={key} className="ml-4 list-disc space-y-0.5">
        {items.map((it, i) => (
          <li key={i}>{renderInline(it, `${key}-li${i}`)}</li>
        ))}
      </ul>,
    );
  };

  lines.forEach((line, i) => {
    const key = `${keyPrefix}-l${i}`;
    // 行级分类（标题/列表/文本）由可测纯函数 classifyProseLine 负责。
    const cls_ = classifyProseLine(line);
    if (cls_.kind === 'heading') {
      flushList(`${key}-ul`);
      const inner = renderInline(cls_.text, key);
      // 面板空间有限：h1/h2 稍大加粗，h3+ 用小号加粗，层级靠字号+粗细区分。
      const cls =
        cls_.level <= 1
          ? 'text-sm font-bold text-fg'
          : cls_.level === 2
            ? 'text-[13px] font-bold text-fg'
            : 'text-xs font-semibold text-fg';
      nodes.push(
        <div key={key} className={`mt-1 ${cls}`}>
          {inner}
        </div>,
      );
    } else if (cls_.kind === 'list') {
      listBuf.push(cls_.text);
    } else {
      flushList(`${key}-ul`);
      if (line.trim()) {
        nodes.push(
          <p key={key} className="whitespace-pre-wrap break-words leading-relaxed">
            {renderInline(line, key)}
          </p>,
        );
      }
    }
  });
  flushList(`${keyPrefix}-ul-end`);
  return <div className="space-y-1">{nodes}</div>;
}

/** 三语按钮标签（本仓内联，不走 ui-messages 跨仓发版）。 */
function codeActionLabels(uiLocale: string) {
  const zh = uiLocale.startsWith('zh');
  const de = uiLocale.startsWith('de');
  return {
    copy: zh ? '拷贝' : de ? 'Kopieren' : 'Copy',
    copied: zh ? '已拷贝' : de ? 'Kopiert' : 'Copied',
    insert: zh ? '插入' : de ? 'Einfügen' : 'Insert',
    replace: zh ? '替换' : de ? 'Ersetzen' : 'Replace',
  };
}

/**
 * 单个代码块：顶部 header 栏（左语言标签，右 拷贝/插入/替换 按钮，Augment 风格），
 * 下方 mono 代码体。按钮回调由 AI 面板注入（insert=光标处，replace=整体替换）。
 */
function CodeBlock({
  code,
  lang,
  uiLocale,
  onCopy,
  onInsert,
  onReplace,
}: {
  code: string;
  lang: string;
  uiLocale: string;
  onCopy?: (code: string) => Promise<boolean>;
  onInsert?: (code: string) => void;
  onReplace?: (code: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const labels = codeActionLabels(uiLocale);
  const langLabel = lang || 'aster';

  // 卸载时清掉「已拷贝」计时器，避免卸载后 setState 警告。
  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const handleCopy = async () => {
    if (!onCopy) return;
    const ok = await onCopy(code);
    if (ok) {
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-bg-subtle px-2 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-fg-muted">
          {langLabel}
        </span>
        <div className="flex items-center gap-1">
          {onCopy && (
            <button
              type="button"
              onClick={handleCopy}
              className="rounded px-1.5 py-0.5 text-[10px] font-medium text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg"
            >
              {copied ? labels.copied : labels.copy}
            </button>
          )}
          {onInsert && (
            <button
              type="button"
              onClick={() => onInsert(code)}
              className="rounded px-1.5 py-0.5 text-[10px] font-medium text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg"
            >
              {labels.insert}
            </button>
          )}
          {onReplace && (
            <button
              type="button"
              onClick={() => onReplace(code)}
              className="rounded px-1.5 py-0.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary-subtle"
            >
              {labels.replace}
            </button>
          )}
        </div>
      </div>
      <pre className="overflow-auto bg-bg-muted p-2 font-mono text-[11px] leading-relaxed text-fg dark:text-gray-200">
        {code}
      </pre>
    </div>
  );
}

/**
 * markdown 感知的 AI 输出视图：散文按行渲染（标题/列表/加粗/行内代码），
 * 代码块带 header 操作栏（拷贝/插入/替换）。不引入运行时 markdown/shiki 依赖
 * （流式面板对 bundle 和重渲染敏感），只覆盖 LLM 实际输出的结构。
 */
function AiOutputView({
  content,
  streaming,
  uiLocale,
  onCopyCode,
  onInsertCode,
  onReplaceCode,
}: {
  content: string;
  streaming: boolean;
  uiLocale: string;
  onCopyCode?: (code: string) => Promise<boolean>;
  onInsertCode?: (code: string) => void;
  onReplaceCode?: (code: string) => void;
}) {
  const segments = parseSegments(content);
  return (
    <div className="space-y-2 text-xs text-fg dark:text-gray-200">
      {segments.map((seg, idx) =>
        seg.kind === 'code' ? (
          <CodeBlock
            key={idx}
            code={seg.code}
            lang={seg.lang}
            uiLocale={uiLocale}
            onCopy={onCopyCode}
            onInsert={onInsertCode}
            onReplace={onReplaceCode}
          />
        ) : (
          <div key={idx}>{renderProse(seg.text, `s${idx}`)}</div>
        ),
      )}
      {streaming && (
        <span className="inline-block h-4 w-1.5 animate-pulse bg-primary align-text-bottom" />
      )}
    </div>
  );
}
