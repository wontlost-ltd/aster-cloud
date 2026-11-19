'use client';

/**
 * 词汇规范预览窗格（ADR 0058 §8.2–8.3，仅在 structured_authoring 为真且 LSP 声明 canonicalPreview 时挂载）。
 *
 * 只读 Monaco，内容是 LSP `aster/canonicalPreview` 的 `text`：经词汇解析的标识符换成规范名、
 * 字面量宏换成展开后的字符串，关键词与其余文字原样。预览只给人看，不保存、不编译、不进 envelope。
 *
 * - 刷新：源码（编辑器 300 ms 防抖编译所用的那份）或 LSP 会话变化时重新请求；
 *   请求失败、超时或服务端返回 null（无法忠实生成时失败闭锁）都显示「预览不可用」，不抛错。
 * - 光标同步：源码光标移动时按 `mappings` 映射到预览；落在被替换 token 内时选中其整个预览区间。
 *   只有编辑器当前内容与生成预览时的内容一致才映射，否则等下一次刷新（偏移已失效）。
 * - 防显示欺骗：预览中的不可见与双向控制字符（\p{Cf}，如 U+202E）替换为等长可见占位并列出码位，
 *   原字符不进 Monaco，不能打乱显示顺序。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { X } from 'lucide-react';
import { asterEditorTheme } from '@/lib/editor/aster-editor-theme';
import {
  HIDDEN_CHAR_PLACEHOLDER,
  mapSourceOffsetToPreview,
  revealHiddenChars,
  type CanonicalPreview,
} from '@/lib/structured-authoring/canonical-preview';

export interface CanonicalPreviewPaneProps {
  /** 源码编辑器（光标同步的来源）。 */
  editor: MonacoEditor.IStandaloneCodeEditor | null;
  /** 最近一次防抖编译所用的源码；变化即刷新预览。 */
  source: string;
  /** 请求当前文档的规范预览（来自编辑器的 LSP 会话）。 */
  request: () => Promise<CanonicalPreview | null>;
  /** 会话变化（如重连成功）时也刷新；取 LSP 状态即可。 */
  refreshKey?: string;
  onClose: () => void;
}

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; preview: CanonicalPreview; requestedText: string | null };

/** 窗格中预览模型的路径：与主文档区分，LSP provider 不会把它当作主文档。 */
const PREVIEW_MODEL_PATH = 'aster-canonical-preview';

export function CanonicalPreviewPane({ editor, source, request, refreshKey, onClose }: CanonicalPreviewPaneProps) {
  const t = useTranslations('policyEditor.canonicalPreview');
  const { resolvedTheme } = useTheme();
  const themeName = resolvedTheme === 'dark' ? 'aster-dark' : 'aster-light';
  const [state, setState] = useState<PreviewState>({ kind: 'loading' });
  const [mountedPreviewEditor, setPreviewEditor] = useState<MonacoEditor.IStandaloneCodeEditor | null>(null);
  // 预览不可用时 Monaco 已卸载，旧实例不能再用；重新可用时 onMount 给出新实例
  const previewEditor = state.kind === 'ready' ? mountedPreviewEditor : null;
  const requestSeq = useRef(0);

  useEffect(() => {
    const seq = ++requestSeq.current;
    // 服务端已收到截至此刻的 didChange，预览即对应此刻的编辑器内容
    const requestedText = editor?.getModel()?.getValue() ?? null;
    request().then(
      (preview) => {
        if (seq !== requestSeq.current) return;
        setState(preview ? { kind: 'ready', preview, requestedText } : { kind: 'unavailable' });
      },
      () => {
        if (seq === requestSeq.current) setState({ kind: 'unavailable' });
      },
    );
  }, [editor, source, request, refreshKey]);

  const revealed = useMemo(() => (state.kind === 'ready' ? revealHiddenChars(state.preview.text) : null), [state]);

  // 不可见字符的装饰：占位已可见，装饰再加底色与码位悬停说明
  useEffect(() => {
    if (!previewEditor || !revealed || revealed.hidden.length === 0) return;
    const model = previewEditor.getModel();
    if (!model) return;
    const collection = previewEditor.createDecorationsCollection(
      revealed.hidden.map((h) => {
        const start = model.getPositionAt(h.offset);
        const end = model.getPositionAt(h.offset + h.length);
        return {
          range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column },
          options: { inlineClassName: 'rounded-sm bg-warning/30 text-warning', hoverMessage: { value: h.codePoint } },
        };
      }),
    );
    return () => collection.clear();
  }, [previewEditor, revealed]);

  // 光标同步：源码光标 → 预览选区
  useEffect(() => {
    if (!editor || !previewEditor || state.kind !== 'ready') return;
    const { preview, requestedText } = state;
    const sync = () => {
      const sourceModel = editor.getModel();
      const previewModel = previewEditor.getModel();
      const position = editor.getPosition();
      if (!sourceModel || !previewModel || !position) return;
      if (requestedText !== null && sourceModel.getValue() !== requestedText) return;
      const [a, b] = mapSourceOffsetToPreview(preview.mappings, sourceModel.getOffsetAt(position));
      const start = previewModel.getPositionAt(a);
      const end = previewModel.getPositionAt(b);
      const range = { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column };
      previewEditor.setSelection(range);
      previewEditor.revealRangeInCenterIfOutsideViewport(range);
    };
    sync();
    const disposable = editor.onDidChangeCursorPosition(sync);
    return () => disposable.dispose();
  }, [editor, previewEditor, state]);

  return (
    <section
      aria-label={t('title')}
      data-testid="canonical-preview-pane"
      className="flex min-h-0 flex-col border-t border-border bg-bg"
    >
      <header className="flex items-start justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-fg">{t('title')}</h2>
          <p className="text-xs text-fg-muted">{t('note')}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('close')}
          className="shrink-0 rounded p-1 text-fg-muted hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:shadow-ring"
        >
          <X aria-hidden className="size-4" />
        </button>
      </header>
      {revealed && revealed.hidden.length > 0 && (
        <p role="note" data-testid="canonical-preview-hidden-chars" className="border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-xs text-fg">
          {t('hiddenChars', {
            count: revealed.hidden.length,
            placeholder: HIDDEN_CHAR_PLACEHOLDER,
            codePoints: [...new Set(revealed.hidden.map((h) => h.codePoint))].join(', '),
          })}
        </p>
      )}
      <div className="relative min-h-0 flex-1">
        {state.kind === 'ready' && revealed ? (
          <Editor
            height="100%"
            path={PREVIEW_MODEL_PATH}
            language="plaintext"
            value={revealed.display}
            theme={themeName}
            beforeMount={(monaco) => monaco.editor.defineTheme(themeName, asterEditorTheme(resolvedTheme === 'dark'))}
            onMount={(ed) => setPreviewEditor(ed)}
            options={{
              readOnly: true,
              domReadOnly: true,
              minimap: { enabled: false },
              fontSize: 14,
              fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Monaco, Consolas, monospace",
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              automaticLayout: true,
              renderControlCharacters: true,
              unicodeHighlight: { invisibleCharacters: true, ambiguousCharacters: false, nonBasicASCII: false },
              padding: { top: 8, bottom: 8 },
            }}
          />
        ) : (
          <p role="status" className="px-3 py-3 text-sm text-fg-muted">
            {state.kind === 'loading' ? t('loading') : t('unavailable')}
          </p>
        )}
      </div>
    </section>
  );
}
