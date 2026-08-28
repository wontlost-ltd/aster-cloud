'use client';

import { useCallback } from 'react';
import type { LlmError } from '@/lib/llm-error';
import { useSSEStream } from './useSSEStream';

/**
 * AI SSE 端点路由：全部走 aster-cloud 的同源代理，不直连 aster-api。
 *
 * R23-Critical-2 给 aster-api 的 /api/v1/ai/* 加了 HMAC 鉴权，浏览器
 * 拿不到 HMAC key，所以必须经 aster-cloud server-side 代理转签。
 * 同源还顺带省掉 CORS preflight，SSE 也不被 CORS 阻断。
 *
 * tenantId 参数被刻意忽略 —— server 端从 NextAuth session 派生，
 * 不信任 caller-supplied 值（详见 /api/llm/complete 注释）。
 */
const SSE_PROXY = {
  generate: '/api/llm/generate',
  suggest: '/api/llm/suggest',
} as const;

export interface GenerateOptions {
  goal: string;
  locale: string;
  existingSource?: string;
  schema?: unknown;
  model?: string;
}

export interface SuggestOptions {
  source: string;
  locale: string;
  focus?: string;
  model?: string;
}

export interface UseAIAssistantResult {
  streaming: boolean;
  content: string;
  error: string | null;
  /** 结构化拒绝原因（见 useSSEStream.denial）。UI 据此选本地化文案与行动入口。 */
  denial: LlmError | null;
  validationError: string | null;
  completed: boolean;
  /** 编译是否通过（final 事件携带） */
  validated: boolean;
  /** 修复进度（如 "2/5"） */
  repairProgress: string | null;
  generate: (options: GenerateOptions, tenantId?: string) => Promise<void>;
  suggest: (options: SuggestOptions, tenantId?: string) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

export function useAIAssistant(): UseAIAssistantResult {
  const sse = useSSEStream();

  const generate = useCallback(async (options: GenerateOptions, _tenantId?: string) => {
    await sse.startStream(
      SSE_PROXY.generate,
      {
        goal: options.goal,
        locale: options.locale,
        existingSource: options.existingSource,
        schema: options.schema,
        model: options.model,
      },
      {},
    );
  }, [sse]);

  const suggest = useCallback(async (options: SuggestOptions, _tenantId?: string) => {
    await sse.startStream(
      SSE_PROXY.suggest,
      {
        source: options.source,
        locale: options.locale,
        focus: options.focus,
        model: options.model,
      },
      {},
    );
  }, [sse]);

  return {
    streaming: sse.streaming,
    content: sse.content,
    error: sse.error,
    denial: sse.denial,
    validationError: sse.validationError,
    completed: sse.completed,
    validated: sse.validated,
    repairProgress: sse.repairProgress,
    generate,
    suggest,
    cancel: sse.cancel,
    reset: sse.reset,
  };
}
