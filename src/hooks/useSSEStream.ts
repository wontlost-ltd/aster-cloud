'use client';

import { useCallback, useRef, useState } from 'react';
import { parseLlmError, type LlmError } from '@/lib/llm-error';
import { parseSSEFrame, type SSEEvent } from '@/lib/sse-frame';

// 帧解析与类型移到 lib（服务端 SSE 代理也要用，而本文件是 'use client'）；此处保留原导出路径
export { parseSSEFrame, type SSEEvent, type SSEEventType } from '@/lib/sse-frame';

export interface UseSSEStreamResult {
  streaming: boolean;
  content: string;
  error: string | null;
  /**
   * 结构化的拒绝原因（仅 HTTP 非 2xx 时有值）。
   *
   * ★与 `error` 并存而非替换：`error` 是既有消费方依赖的展示串，
   * 换类型会波及所有调用点。本字段让 UI 能按**原因码**选本地化文案
   * 与行动入口（如邮箱未验证 → 给「去验证」链接），而不是把
   * `HTTP 403: {"error":"ai_email_unverified",...}` 这行原始 JSON 摔给用户。
   */
  denial: LlmError | null;
  validationError: string | null;
  completed: boolean;
  /** 编译是否通过（final 事件携带） */
  validated: boolean;
  /** 当前修复尝试次数（如 "2/5"） */
  repairProgress: string | null;
  startStream: (url: string, body: object, headers?: Record<string, string>) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

export function useSSEStream(): UseSSEStreamResult {
  const [streaming, setStreaming] = useState(false);
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [denial, setDenial] = useState<LlmError | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const [validated, setValidated] = useState(false);
  const [repairProgress, setRepairProgress] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setContent('');
    setError(null);
    setDenial(null);
    setValidationError(null);
    setCompleted(false);
    setValidated(false);
    setRepairProgress(null);
    setStreaming(false);
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  const startStream = useCallback(async (url: string, body: object, headers?: Record<string, string>) => {
    // 重置状态
    setContent('');
    setError(null);
    setDenial(null);
    setValidationError(null);
    setCompleted(false);
    setValidated(false);
    setRepairProgress(null);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        // ★解析出**结构化原因**再交给 UI。此前这里直接把响应体拼进字符串，
        //   用户看到的是一行原始 JSON（HTTP 403: {"error":"ai_email_unverified",…}），
        //   精确原因就在里面却没人解析——只能去开浏览器控制台看。
        const parsed = parseLlmError(
          response.status,
          errorText,
          response.headers.get('Retry-After'),
        );
        setDenial(parsed);
        // `error` 保留服务端 message 作兜底（UI 优先用 denial.reason 选本地化文案）。
        setError(parsed.serverMessage || `HTTP ${response.status}`);
        setStreaming(false);
        return;
      }

      if (!response.body) {
        setError('Response body is empty');
        setStreaming(false);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const dispatch = (event: SSEEvent) => {
        switch (event.type) {
          case 'delta':
            if (event.data) setContent(prev => prev + event.data);
            break;
          case 'repair_start':
            // 新的修复尝试开始：清空已有内容，显示进度
            setContent('');
            setValidationError(null);
            setRepairProgress(event.data ?? null);
            break;
          case 'final':
            if (event.data) setContent(event.data);
            setValidated(event.validated === true);
            setCompleted(true);
            break;
          case 'validation_error':
            setValidationError(event.error ?? event.data ?? 'Validation failed');
            break;
          case 'error':
            setError(event.error ?? event.data ?? 'Unknown error');
            break;
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        // SSE 帧由空行分隔（LF 或 CRLF）。用 `\r?\n\r?\n` 兼容两种换行，
        // 逐帧 split + 保留最后一个不完整 frame。
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const event = parseSSEFrame(frame);
          if (event) dispatch(event);
        }
      }

      // 处理 buffer 中剩余内容
      if (buffer.trim()) {
        const event = parseSSEFrame(buffer);
        if (event) dispatch(event);
      }

      if (!completed) setCompleted(true);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // 用户取消，不视为错误
      } else {
        setError(err instanceof Error ? err.message : 'Stream failed');
      }
    } finally {
      setStreaming(false);
    }
  }, [completed]);

  return { streaming, content, error, denial, validationError, completed, validated, repairProgress, startStream, cancel, reset };
}
