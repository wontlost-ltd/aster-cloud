import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createTranslator } from 'next-intl';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';
import { locales } from '@/i18n/config';
import { PLANS, PLAN_FEATURE_MESSAGE_VALUES } from '@/lib/plans';

/**
 * 套餐卡片文案（F20）：
 * - 「全语言包」列出的语种来自已配置 locales（此前写死 en / zh / de，hi 已启用却不在列）；
 * - 不点名具体模型（此前写 gpt-4o-mini / gpt-5.2，与实际使用的模型不符）；
 * - 账单概览的 "Trial" 卡片标题走 i18n。
 */
const ROOT = path.resolve(__dirname, '../../..');
const PKG = {
  en: 'node_modules/@aster-cloud/ui-messages/en-US.json',
  zh: 'node_modules/@aster-cloud/ui-messages/zh-CN.json',
  de: 'node_modules/@aster-cloud/ui-messages/de-DE.json',
  hi: 'node_modules/@aster-cloud/ui-messages-hi/hi-IN.json',
} as const;

const allFeatureKeys = [
  ...new Set(Object.values(PLANS).flatMap((p) => p.featureKeys as readonly string[])),
];

describe('套餐功能文案', () => {
  it('语言列表由 locales 推导', () => {
    expect(PLAN_FEATURE_MESSAGE_VALUES.languages).toBe(locales.join(' / '));
    expect(PLAN_FEATURE_MESSAGE_VALUES.languages).toContain('hi');
  });

  for (const loc of Object.keys(PKG) as Array<keyof typeof PKG>) {
    it(`[${loc}] 每个套餐功能都能格式化，不含模型名，语言列表完整`, () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, PKG[loc]), 'utf8'));
      const messages = deepMergeMessages(pkg, DEMO_SUPPLEMENT[loc]);
      // messages 是运行时合并的动态树，类型上没有键信息，这里按字符串键调用。
      const t = createTranslator({ locale: loc, messages, namespace: 'billing' }) as unknown as (
        key: string,
        values?: Record<string, string>,
      ) => string;
      for (const key of allFeatureKeys) {
        const text = t(`plans.features.${key}`, PLAN_FEATURE_MESSAGE_VALUES);
        expect(text, key).not.toMatch(/gpt-|claude|gemini/i);
      }
      expect(t('plans.features.allLanguagePacks', PLAN_FEATURE_MESSAGE_VALUES)).toContain(
        locales.join(' / '),
      );
      expect(t('overview.trialCardTitle')).not.toBe('');
    });
  }
});

/**
 * 公开定价页（/pricing）套餐要点（F20 遗留）：pricingPage.tiers.*.features 是包内数组，
 * 由本地补充层整体替换；同样不点名模型，语言列表与已配置 locales 一致（含 hi）。
 */
describe('公开定价页套餐要点', () => {
  for (const loc of Object.keys(PKG) as Array<keyof typeof PKG>) {
    it(`[${loc}] 不含 gpt- 模型名，语言列表包含 hi`, () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, PKG[loc]), 'utf8'));
      const messages = deepMergeMessages(pkg, DEMO_SUPPLEMENT[loc]) as {
        pricingPage: { tiers: Record<string, { features: string[] }> };
      };
      const tiers = messages.pricingPage.tiers;
      const all = Object.values(tiers).flatMap((tier) => tier.features);
      for (const feat of all) expect(feat).not.toMatch(/gpt-/i);
      for (const tier of ['free', 'pro']) {
        // 数组整体替换：条目数与包内一致，避免误删其它要点。
        expect(tiers[tier].features).toHaveLength(pkg.pricingPage.tiers[tier].features.length);
        const langLine = tiers[tier].features.find((f) => f.includes(locales.join(' / ')));
        expect(langLine, tier).toBeDefined();
        expect(langLine).toContain('hi');
      }
    });
  }
});
