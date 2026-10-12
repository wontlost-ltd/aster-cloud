/**
 * @module lib/preferences/ai-inline-completion
 *
 * 策略编辑器「AI 行内补全」开关。
 *
 * <p>开启时，编辑器在输入停顿约 500ms 后把光标前最多 10 行发给 /api/llm/complete，
 * 每次停顿都会消耗一次 AI 额度（BYOK 除外）。关闭后编辑器不再发出任何补全请求。
 *
 * <p>默认开启，保持既有行为；按浏览器持久化，设置页与编辑器状态栏共用同一份状态。
 */
'use client';

import { createBooleanPreference, useBooleanPreference } from './boolean-preference';

export const AI_INLINE_COMPLETION_KEY = 'aster.editor.aiInlineCompletion';

export const aiInlineCompletionPreference = createBooleanPreference(AI_INLINE_COMPLETION_KEY, true);

export function useAiInlineCompletion() {
  return useBooleanPreference(aiInlineCompletionPreference);
}
