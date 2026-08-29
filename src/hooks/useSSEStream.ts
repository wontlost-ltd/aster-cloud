'use client';

import { useCallback, useRef, useState } from 'react';
import { parseLlmError, type LlmError } from '@/lib/llm-error';

export type SSEEventType = 'delta' | 'validation_error' | 'repair_start' | 'final' | 'error';

export interface SSEEvent {
  type: SSEEventType;
  data?: string;
  error?: string;
  validated?: boolean;
}

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

/**
 * 解析 SSE text/event-stream 帧到结构化 event。
 *
 * aster-api 同时使用两种格式：
 *   1) 双行 W3C 标准：
 *        event: error
 *        data: {"error":"out_of_scope","message":"...","rule_id":"..."}
 *      解析需按"帧"（两个 \n 分隔）而非按"行"。
 *   2) 单行 Quarkus JSON：
 *        data: {"type":"delta","data":"..."}
 *      此时 type 由 payload 自身携带。
 *
 * 兼容做法：从一段文本中提取 `event:` 行（如有）作为 type override，
 * 把所有 `data:` 行的内容拼接为 payload，再尝试 JSON.parse。
 */
export function parseSSEFrame(frame: string): SSEEvent | null {
  // 只去掉帧首尾的换行/回车用于「空帧」判断，不能用 trim()——data 值里的
  // 前导/尾随空格是有意义的（LLM 逐 token 流式，token 常带前导空格如 " is"，
  // trim 掉会把 "Rule is" 拼成 "Ruleis"）。
  if (!frame.replace(/[\r\n]/g, '').trim()) return null;

  let eventType: SSEEventType | null = null;
  const dataParts: string[] = [];

  // SSE 行以 \n 分隔，可能带 \r（CRLF）。逐行按字段解析，遵循 SSE 规范：
  // 字段名后的冒号，其后「一个」可选前导空格被移除，其余空格保留。
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.replace(/\r$/, ''); // 去掉行尾 \r，保留内部空格
    if (!line || line.startsWith(':')) continue; // 空行 / SSE 注释
    const colon = line.indexOf(':');
    if (colon === -1) continue; // 无冒号的字段行按 SSE 规范整行为字段名、值空，忽略
    const field = line.slice(0, colon);
    // 值 = 冒号后内容，移除「恰好一个」前导空格（SSE 规范），保留其余空格。
    let value = line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      const v = value.trim(); // 事件类型是枚举 token，可安全 trim
      if (v === 'delta' || v === 'validation_error' || v === 'repair_start' || v === 'final' || v === 'error') {
        eventType = v;
      }
    } else if (field === 'data') {
      dataParts.push(value); // ★ 不 trim：保留 token 前后有意义的空格
    }
  }

  const frameTrimmedForFallback = frame.trim();

  if (dataParts.length === 0) {
    // 既没 event: 也没 data:（或全空），按纯文本 delta 处理。此回退分支是
    // 非标准整帧兜底，用 trim 后的帧文本即可（不涉及逐 token 拼接）。
    return eventType
      ? { type: eventType }
      : { type: 'delta', data: frameTrimmedForFallback };
  }

  const payload = dataParts.join('\n');

  // 尝试 JSON.parse 拿结构化字段
  try {
    const parsed = JSON.parse(payload) as Partial<SSEEvent> & {
      error?: string;
      message?: string;
      rule_id?: string;
    };
    // PromptScopeFilter 返回 { error: "out_of_scope", message: "...", rule_id: "..." }
    // 用 message 作为 user-facing 文案，error 仅作为机器可读的 code
    const userMessage = parsed.message ?? parsed.error;
    return {
      type: eventType ?? parsed.type ?? 'delta',
      data: parsed.data,
      error: userMessage,
      validated: parsed.validated,
    };
  } catch {
    // 非 JSON：当 type 提示是 delta 时拼回 content；否则带 event type 抛错
    if (eventType && eventType !== 'delta') {
      return { type: eventType, error: payload };
    }
    return { type: 'delta', data: payload };
  }
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
