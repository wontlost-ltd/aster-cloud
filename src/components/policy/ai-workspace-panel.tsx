'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { editor as monaco } from 'monaco-editor';
import { aiWorkspaceOrigin } from '@/lib/ai-workspace';
import {
  applyToEditor,
  contextMessage,
  parseBridgeMessage,
  type BridgeIn,
  type EditorLike,
} from '@/lib/ai-workspace-bridge';

export interface AiWorkspacePanelProps {
  /** 已解析的工作台基础地址（resolveAiWorkspaceBase 的结果）。 */
  base: string;
  /** 当前策略 id；未保存的新策略为 'new'。 */
  policyId: string;
  editor: monaco.IStandaloneCodeEditor | null;
  cnlLocale: string;
  uiLocale: string;
  /** 写回成功后把编辑器全文同步回表单状态。 */
  onApplyContent: (content: string) => void;
}

const CONTEXT_DEBOUNCE_MS = 500;

/**
 * 策略编辑器「AI」tab 的工作台 iframe（ADR 0049 Part B）。
 * iframe 先经云端交接路由换取工作台会话，再加载 /panel；双方只通过 v1 postMessage 协议通信，
 * 本端只接受工作台 origin 的消息，也只向该 origin 发送。
 */
export function AiWorkspacePanel({ base, policyId, editor, cnlLocale, uiLocale, onApplyContent }: AiWorkspacePanelProps) {
  const t = useTranslations('dashboardNav');
  const origin = aiWorkspaceOrigin(base) ?? '';
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // reauth 时递增 key 让 React 重建 iframe，从而重新走交接路由。
  const [frameKey, setFrameKey] = useState(0);
  // 已收到 iframe 的 ready：之后编辑器才挂载时需补发上下文，否则直到用户输入前工作台都拿不到源码。
  const readyRef = useRef(false);
  const src = `/api/ai-workspace/handoff?next=${encodeURIComponent(`/panel?policyId=${policyId}`)}&locale=${uiLocale}`;

  const post = useCallback(
    (msg: object) => iframeRef.current?.contentWindow?.postMessage(msg, origin),
    [origin],
  );
  const postContext = useCallback(
    () => post(contextMessage(policyId, editor?.getValue() ?? '', cnlLocale)),
    [post, policyId, editor, cnlLocale],
  );

  useEffect(() => {
    const handle = (msg: BridgeIn) => {
      if (msg.type === 'aster.ai.ready') {
        readyRef.current = true;
        return postContext();
      }
      if (msg.type === 'aster.ai.reauth') return setFrameKey((k) => k + 1);
      // Monaco 的 executeEdits 要求 IRange，比协议层 EditorLike 的 unknown 更严，只能在此收窄。
      const result = applyToEditor(editor as unknown as EditorLike | null, msg, policyId);
      // Monaco 受控于表单 content：写入后以编辑器全文回填，保证保存时拿到最新源码。
      if (result.ok && editor) onApplyContent(editor.getValue());
      post({ type: 'aster.ai.applied', v: 1, requestId: msg.requestId, ...result });
    };
    const onMessage = (ev: MessageEvent) => {
      const msg = parseBridgeMessage(ev, origin);
      if (msg) handle(msg);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [origin, editor, policyId, onApplyContent, post, postContext]);

  // ready 先于 Monaco 挂载时，编辑器可用后补发一次上下文。
  useEffect(() => {
    if (editor && readyRef.current) postContext();
  }, [editor, postContext]);

  // 编辑器内容变化后防抖推送上下文，让工作台始终基于最新源码对话。
  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = editor.onDidChangeModelContent(() => {
      clearTimeout(timer);
      timer = setTimeout(postContext, CONTEXT_DEBOUNCE_MS);
    });
    return () => {
      clearTimeout(timer);
      sub.dispose();
    };
  }, [editor, postContext]);

  return (
    <iframe
      key={frameKey}
      ref={iframeRef}
      title={t('aiWorkspace')}
      src={src}
      // 面板内「复制」按钮需要剪贴板写权限。
      allow="clipboard-write"
      className="h-full w-full border-0"
    />
  );
}
