/**
 * 站内助手的**联网应答器实现**（RAG 问答）。
 *
 * <p>把用户问句 + 本地检索命中送到 `/api/llm/assistant`（薄代理 → aster-api
 * `/api/v1/ai/assistant`），流式返回自然语言答复。
 *
 * <p><b>护栏在链路上游，不在这里</b>：auth 与配额在 `llm-sse-proxy`，
 * 内容安全/熔断/BYOK 在 aster-api 侧。本文件只负责发请求与解析 SSE，
 * 不要在这里另加或绕过任何校验。
 *
 * <p><b>失败即降级</b>：抛错交给面板处理——它会保留已收到的部分答复、
 * 显示降级提示，并照常展示检索结果。所以这里**不做**自己的重试或兜底。
 */

import { parseSSEFrame } from '@/hooks/useSSEStream';
import type { AssistantAnswerProvider } from './provider';
import { toGroundingHits } from './retrieval';

export function createDigitalHumanProvider(): AssistantAnswerProvider {
  return {
    id: 'aster-rag-v1',

    async *answer({ query, groundingHits, locale, signal }) {
      const res = await fetch('/api/llm/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          query,
          locale,
          groundingHits: toGroundingHits(groundingHits),
        }),
      });

      if (!res.ok || !res.body) {
        // 交给面板降级——它会保留检索结果并提示"未能连接助手服务"。
        throw new Error(`assistant upstream ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE 以空行分帧；最后一段可能不完整，留在 buffer 里等下一块。
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const delta = frameToDelta(frame);
            if (delta) yield { delta };
          }
        }
        // 收尾：流结束时 buffer 里可能还剩最后一帧（无尾随空行）。
        if (buffer.trim()) {
          const delta = frameToDelta(buffer);
          if (delta) yield { delta };
        }
      } finally {
        // 用户中止/组件卸载时释放底层连接，避免请求悬挂继续烧配额。
        reader.cancel().catch(() => {});
      }
    },
  };
}

/**
 * 一帧 SSE → 文本增量；非 delta 帧返回 null。
 *
 * <p>复用 {@link parseSSEFrame}（与编辑器 AI 流同一套解析），后端发的是
 * JSON delta 而非裸文本——裸文本经 SSE 传输会被行首空格规则吞掉空格与换行。
 *
 * <p>上游 error 帧转成异常，走面板的降级路径，而不是把错误信息当答案显示。
 */
function frameToDelta(frame: string): string | null {
  const event = parseSSEFrame(frame);
  if (!event) return null;
  if (event.type === 'error') {
    throw new Error(event.error ?? event.data ?? 'assistant stream error');
  }
  return event.type === 'delta' && event.data ? event.data : null;
}
