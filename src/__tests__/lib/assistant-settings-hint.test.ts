import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { assistantSettingsHintKey } from '@/lib/assistant/settings-hint';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';

/**
 * 设置页助手说明（F21）：管理员开启「助手回答」（默认开启）时，不能再说「不生成 AI 回答」。
 */
describe('assistantSettingsHintKey', () => {
  it('开关缺省 / 开启 → AI 回答说明', () => {
    expect(assistantSettingsHintKey(true)).toBe('settingsHintAiAnswers');
    expect(assistantSettingsHintKey(undefined)).toBe('settingsHintAiAnswers');
  });
  it('只有显式 false 才使用「仅检索」说明（与 /api/llm/assistant 口径一致）', () => {
    expect(assistantSettingsHintKey(false)).toBe('settingsHint');
  });
});

describe('AI 回答说明四语齐全', () => {
  const ROOT = path.resolve(__dirname, '../../..');
  const PKG = {
    en: 'node_modules/@aster-cloud/ui-messages/en-US.json',
    zh: 'node_modules/@aster-cloud/ui-messages/zh-CN.json',
    de: 'node_modules/@aster-cloud/ui-messages/de-DE.json',
    hi: 'node_modules/@aster-cloud/ui-messages-hi/hi-IN.json',
  } as const;
  for (const loc of Object.keys(PKG) as Array<keyof typeof PKG>) {
    it(`[${loc}]`, () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, PKG[loc]), 'utf8'));
      const m = deepMergeMessages(pkg, DEMO_SUPPLEMENT[loc]) as {
        assistant: Record<string, string>;
      };
      expect(m.assistant.settingsHintAiAnswers?.trim()).toBeTruthy();
      expect(m.assistant.settingsHintAiAnswers).not.toBe(m.assistant.settingsHint);
    });
  }
  it('zh 文案不再声称「不生成 AI 回答」', () => {
    expect(DEMO_SUPPLEMENT.zh.assistant).toBeDefined();
    const zh = (DEMO_SUPPLEMENT.zh.assistant as Record<string, string>).settingsHintAiAnswers;
    expect(zh).not.toContain('不生成 AI 回答');
    expect(zh).toContain('AI');
  });
});
