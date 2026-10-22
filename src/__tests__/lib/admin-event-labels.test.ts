import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  KNOWN_ADMIN_EVENT_IDS,
  adminEventLabel,
  adminEventLabelKey,
  humanizeEventId,
} from '@/lib/admin-event-labels';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';

/**
 * 管理员概览事件名本地化（F17）：生产上显示的是 "lexicon.term.add" 这类原始 id。
 */
const ROOT = path.resolve(__dirname, '../../..');
const PKG = {
  en: 'node_modules/@aster-cloud/ui-messages/en-US.json',
  zh: 'node_modules/@aster-cloud/ui-messages/zh-CN.json',
  de: 'node_modules/@aster-cloud/ui-messages/de-DE.json',
  hi: 'node_modules/@aster-cloud/ui-messages-hi/hi-IN.json',
} as const;

function eventsFor(loc: keyof typeof PKG): Record<string, unknown> {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, PKG[loc]), 'utf8'));
  const merged = deepMergeMessages(pkg, DEMO_SUPPLEMENT[loc]) as {
    admin?: { pulse?: { audit?: { events?: Record<string, unknown> } } };
  };
  return merged.admin?.pulse?.audit?.events ?? {};
}

describe('adminEventLabelKey', () => {
  it('点分 / 连字符 / 下划线 id 推导为 camelCase', () => {
    expect(adminEventLabelKey('lexicon.term.add')).toBe('lexiconTermAdd');
    expect(adminEventLabelKey('ai-key.reset-quota')).toBe('aiKeyResetQuota');
    expect(adminEventLabelKey('user.risk_tier_overridden')).toBe('userRiskTierOverridden');
  });
});

describe('adminEventLabel', () => {
  it('已登记 id 走翻译', () => {
    expect(adminEventLabel('ai-key.update', (k) => `T:${k}`)).toBe('T:aiKeyUpdate');
  });

  it('未登记 id 回落成可读形式，不调用翻译（避免显示 key 路径）', () => {
    expect(adminEventLabel('foo.bar_baz', () => 'X')).toBe('foo bar baz');
    expect(humanizeEventId('lexicon.term.add')).toBe('lexicon term add');
  });
});

describe('已登记事件在四语文案中都有标签', () => {
  for (const loc of Object.keys(PKG) as Array<keyof typeof PKG>) {
    it(`[${loc}]`, () => {
      const events = eventsFor(loc);
      const missing = KNOWN_ADMIN_EVENT_IDS.map(adminEventLabelKey).filter(
        (k) => typeof events[k] !== 'string' || !(events[k] as string).trim(),
      );
      expect(missing).toEqual([]);
    });
  }
});
