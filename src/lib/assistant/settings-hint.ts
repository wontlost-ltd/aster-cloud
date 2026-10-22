/**
 * 设置页「Aster 助手」说明文案的选择（F21）。
 *
 * 原文案恒为「仅检索本站内容——不联网、不生成 AI 回答」，而管理员开启「助手回答」
 * （platform setting assistant.enabled，默认开启）后，登录用户实际会拿到基于站内文档的
 * AI 回答，两处说法矛盾。按该开关选文案；判定口径与 /api/llm/assistant、admin 页一致：
 * 只有显式 false 才算关闭。
 */
export function assistantSettingsHintKey(
  answersSetting: unknown,
): 'settingsHintAiAnswers' | 'settingsHint' {
  return answersSetting === false ? 'settingsHint' : 'settingsHintAiAnswers';
}
