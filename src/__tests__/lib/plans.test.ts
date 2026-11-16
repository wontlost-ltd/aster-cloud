import { describe, it, expect } from 'vitest';
import {
  PLANS,
  PLAN_PRICES,
  PLAN_FEATURE_KEYS,
  STRIPE_PRICE_IDS,
  canAccessApiKeys,
  formatPrice,
  getCurrencyForLocale,
  getPlanConfig,
  getPlanLimit,
  getPlanPrice,
  getPlanStripePriceId,
  getProPrice,
  hasCapability,
} from '@/lib/plans';

describe('Plans Configuration', () => {
  it('should have all internal plan keys (free/trial/pro/team/enterprise)', () => {
    // PM v1.1：team 档已下线，但 enum/PLANS key 保留以兼容历史数据
    expect(PLANS).toHaveProperty('free');
    expect(PLANS).toHaveProperty('trial');
    expect(PLANS).toHaveProperty('pro');
    expect(PLANS).toHaveProperty('team');
    expect(PLANS).toHaveProperty('enterprise');
  });

  it('should return correct PM v1.1 limits', () => {
    expect(getPlanLimit('free', 'policies')).toBe(5);
    expect(getPlanLimit('pro', 'executions')).toBe(50000);
  });

  it('should correctly identify API key access', () => {
    expect(canAccessApiKeys('free')).toBe(false);
    expect(canAccessApiKeys('pro')).toBe(true);
  });

  it('should expose plan capabilities via getPlanConfig', () => {
    const proConfig = getPlanConfig('pro');
    expect(proConfig.capabilities.apiAccess).toBe(true);
  });

  it('结构化编写：free 关闭，trial / pro / team / enterprise 开启', () => {
    expect(hasCapability('free', 'structuredAuthoring')).toBe(false);
    for (const plan of ['trial', 'pro', 'team', 'enterprise'] as const) {
      expect(hasCapability(plan, 'structuredAuthoring')).toBe(true);
    }
  });

  it('should disable custom domain vocabulary on the free plan', () => {
    expect(PLANS.free.capabilities.customLexicon).toBe(false);
    expect(PLANS.free.capabilities.customLexiconMaxTerms).toBe(0);
    expect(PLANS.free.capabilities.customLexiconBulkUploadAsync).toBe(false);
  });

  it('should enable trial custom domain vocabulary with the compact 500-term quota and no async bulk', () => {
    expect(PLANS.trial.capabilities.customLexicon).toBe(true);
    expect(PLANS.trial.capabilities.customLexiconMaxTerms).toBe(500);
    expect(PLANS.trial.capabilities.customLexiconBulkUploadAsync).toBe(false);
    expect(PLANS.trial.featureKeys).not.toContain(PLAN_FEATURE_KEYS.customDomainVocabulary);
  });

  it('should expose paid-tier custom domain vocabulary quotas and the i18n feature key', () => {
    expect(PLANS.pro.capabilities.customLexicon).toBe(true);
    expect(PLANS.pro.capabilities.customLexiconMaxTerms).toBe(5000);
    expect(PLANS.pro.capabilities.customLexiconBulkUploadAsync).toBe(true);
    expect(PLANS.team.capabilities.customLexiconMaxTerms).toBe(25000);
    expect(PLANS.team.capabilities.customLexiconBulkUploadAsync).toBe(true);
    expect(PLANS.enterprise.capabilities.customLexiconMaxTerms).toBe(-1);
    expect(PLANS.enterprise.capabilities.customLexiconBulkUploadAsync).toBe(true);
    expect(PLANS.pro.featureKeys).toContain(PLAN_FEATURE_KEYS.customDomainVocabulary);
    expect(PLANS.team.featureKeys).toContain(PLAN_FEATURE_KEYS.customDomainVocabulary);
    expect(PLANS.enterprise.featureKeys).toContain(PLAN_FEATURE_KEYS.customDomainVocabulary);
  });
});

describe('Multi-currency pricing', () => {
  describe('getCurrencyForLocale', () => {
    it('should return USD for English locale', () => {
      expect(getCurrencyForLocale('en')).toBe('USD');
    });
    it('should return CNY for Chinese locale', () => {
      expect(getCurrencyForLocale('zh')).toBe('CNY');
    });
    it('should return EUR for German locale', () => {
      expect(getCurrencyForLocale('de')).toBe('EUR');
    });
    it('should default to USD for unknown locale', () => {
      expect(getCurrencyForLocale('unknown')).toBe('USD');
    });
  });

  describe('formatPrice', () => {
    it('should format USD correctly', () => {
      expect(formatPrice(39, 'USD')).toMatch(/\$39/);
    });
    it('should format CNY correctly', () => {
      expect(formatPrice(299, 'CNY')).toMatch(/¥299/);
    });
    it('should format EUR correctly', () => {
      expect(formatPrice(36, 'EUR')).toMatch(/€36|36\s*€/);
    });
  });

  describe('getProPrice — PM v1.1 ¥299 / $39 / €36', () => {
    it('should return correct USD prices', () => {
      expect(getProPrice('USD', 'monthly')).toBe(39);
      expect(getProPrice('USD', 'yearly')).toBe(374);
    });
    it('should return correct CNY prices', () => {
      expect(getProPrice('CNY', 'monthly')).toBe(299);
      expect(getProPrice('CNY', 'yearly')).toBe(2870);
    });
    it('should return correct EUR prices', () => {
      expect(getProPrice('EUR', 'monthly')).toBe(36);
      expect(getProPrice('EUR', 'yearly')).toBe(346);
    });
  });
});

describe('Price configuration consistency', () => {
  it('should align PLANS and PLAN_PRICES for Pro plan', () => {
    expect(PLANS.pro.price.monthly).toBe(PLAN_PRICES.pro.USD.monthly);
    expect(PLANS.pro.price.yearly).toBe(PLAN_PRICES.pro.USD.yearly);
  });

  it('PLAN_PRICES should not contain team perUser pricing (PM v1.1)', () => {
    expect((PLAN_PRICES as { team?: unknown }).team).toBeUndefined();
  });
});

describe('getPlanPrice with currency', () => {
  it('should return USD prices by default', () => {
    const price = getPlanPrice('pro');
    expect(price.monthly).toBe(39);
    expect(price.yearly).toBe(374);
  });

  it('should return CNY prices when specified', () => {
    const price = getPlanPrice('pro', 'CNY');
    expect(price.monthly).toBe(299);
    expect(price.yearly).toBe(2870);
  });

  it('should return EUR prices when specified', () => {
    const price = getPlanPrice('pro', 'EUR');
    expect(price.monthly).toBe(36);
    expect(price.yearly).toBe(346);
  });

  it('should map team plan to pro pricing (defensive fallback)', () => {
    expect(getPlanPrice('team', 'USD')).toEqual(getPlanPrice('pro', 'USD'));
  });

  it('should return zero for free/trial plans', () => {
    const freePrice = getPlanPrice('free', 'CNY');
    expect(freePrice.monthly).toBe(0);
    expect(freePrice.yearly).toBe(0);

    const trialPrice = getPlanPrice('trial', 'EUR');
    expect(trialPrice.monthly).toBe(0);
    expect(trialPrice.yearly).toBe(0);
  });

  it('should return null for enterprise plans', () => {
    const price = getPlanPrice('enterprise', 'USD');
    expect(price.monthly).toBeNull();
    expect(price.yearly).toBeNull();
  });
});

describe('getPlanStripePriceId with currency', () => {
  it('should return null for free and trial plans', () => {
    expect(getPlanStripePriceId('free', 'monthly', 'USD')).toBeNull();
    expect(getPlanStripePriceId('trial', 'yearly', 'CNY')).toBeNull();
  });

  it('should return null for enterprise plan', () => {
    expect(getPlanStripePriceId('enterprise', 'monthly', 'USD')).toBeNull();
  });

  it('should use default USD when currency not specified', () => {
    const withoutCurrency = getPlanStripePriceId('pro', 'monthly');
    const withUsd = getPlanStripePriceId('pro', 'monthly', 'USD');
    expect(withoutCurrency).toBe(withUsd);
  });
});

describe('STRIPE_PRICE_IDS structure', () => {
  it('should have pro plan with all currencies', () => {
    expect(STRIPE_PRICE_IDS.pro).toBeDefined();
    expect(STRIPE_PRICE_IDS.pro.USD).toBeDefined();
    expect(STRIPE_PRICE_IDS.pro.CNY).toBeDefined();
    expect(STRIPE_PRICE_IDS.pro.EUR).toBeDefined();
  });

  it('should NOT have team plan (PM v1.1 三档化)', () => {
    expect(STRIPE_PRICE_IDS.team).toBeUndefined();
  });

  it('should have monthly and yearly for each currency on pro', () => {
    const currencies = ['USD', 'CNY', 'EUR'] as const;
    for (const currency of currencies) {
      expect(STRIPE_PRICE_IDS.pro[currency]).toHaveProperty('monthly');
      expect(STRIPE_PRICE_IDS.pro[currency]).toHaveProperty('yearly');
    }
  });
});

describe('Multi-currency integration flow', () => {
  it('should provide consistent pricing from locale to display (zh → ¥299)', () => {
    const locale = 'zh';
    const currency = getCurrencyForLocale(locale);
    expect(currency).toBe('CNY');

    const price = getPlanPrice('pro', currency);
    expect(price.monthly).toBe(299);

    const formatted = formatPrice(price.monthly!, currency);
    expect(formatted).toMatch(/¥299/);
  });

  it('should provide consistent pricing for EUR locale (de → €36)', () => {
    const locale = 'de';
    const currency = getCurrencyForLocale(locale);
    expect(currency).toBe('EUR');

    const price = getPlanPrice('pro', currency);
    expect(price.monthly).toBe(36);

    const formatted = formatPrice(price.monthly!, currency);
    expect(formatted).toMatch(/€36|36\s*€/);
  });
});
