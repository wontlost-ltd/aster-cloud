// /billing/plans — change-subscription flow.
//
// Was /billing pre P1-2. Moved here so /billing can be a real
// account-billing overview (plan / trial / usage / invoices) and
// the plan picker + FAQ + currency switcher live one click deeper.
// The previous direct flow (signed-in admin → /billing → plan
// picker) was a mis-frame: admins need overview first, plan change
// second. See SaaS-admin audit punch list P1-2.

import { getTranslations, getLocale } from 'next-intl/server';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getUsageStats } from '@/lib/usage';
import { CAN_BILLING } from '@/lib/deployment-mode';
import {
  getCurrencyForLocale,
  PLANS,
  PLAN_FEATURE_MESSAGE_VALUES,
  PlanType,
  CurrencyCode,
} from '@/lib/plans';
import { PlansContent } from './plans-content';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('pageTitles', 'billingPlans');

// FAQ item keys organized by category — preserved verbatim from
// the pre-split /billing/page.tsx so existing copy + question order
// remains identical.
const PRODUCT_FAQ_KEYS = [
  'whatIsAster',
  'whatIsPolicy',
  'piiDetection',
  'complianceStandards',
  'integration',
  'selfHosted',
] as const;

const BILLING_FAQ_KEYS = [
  'apiVsExecutions',
  'freeLimits',
  'upgradePlan',
  'downgrade',
  'trialEnds',
  'cancelAnytime',
  'refunds',
  'invoices',
  'dataSecurity',
  'support',
] as const;

export default async function BillingPlansPage() {
  // On-prem 没有 Stripe 订阅模型，整个 plan picker 不可见。
  if (!CAN_BILLING) {
    notFound();
  }

  const session = await getSession();
  if (!session?.user?.id) {
    redirect('/login');
  }

  const t = await getTranslations('billing');
  const tNav = await getTranslations('dashboardNav');
  const locale = await getLocale();
  const defaultCurrency = getCurrencyForLocale(locale) as CurrencyCode;

  const usageStats = await getUsageStats(session.user.id);

  const initialUsage = {
    executions: usageStats.usage.executions,
    executionsLimit: usageStats.usage.executionsLimit,
    policies: usageStats.usage.policies,
    policiesLimit: usageStats.usage.policiesLimit,
    apiCalls: usageStats.usage.apiCalls,
    apiCallsLimit: usageStats.usage.apiCallsLimit,
  };

  const currentPlan = (usageStats.plan || 'free') as PlanType;
  const trialEndsAt = session.user.trialEndsAt
    ? new Date(session.user.trialEndsAt).toISOString()
    : null;

  const planNames: Record<string, string> = {};
  for (const planKey of Object.keys(PLANS)) {
    planNames[planKey] = t(`plans.names.${planKey}`);
  }

  const planFeatures: Record<string, string> = {};
  const allFeatureKeys = new Set<string>();
  for (const planKey of Object.keys(PLANS)) {
    const plan = PLANS[planKey as PlanType];
    for (const featureKey of plan.featureKeys) {
      allFeatureKeys.add(featureKey);
    }
  }
  for (const featureKey of allFeatureKeys) {
    planFeatures[featureKey] = t(`plans.features.${featureKey}`, PLAN_FEATURE_MESSAGE_VALUES);
  }

  const faqItems: Record<string, { question: string; answer: string }> = {};
  const allFaqKeys = [...PRODUCT_FAQ_KEYS, ...BILLING_FAQ_KEYS];
  for (const faqKey of allFaqKeys) {
    faqItems[faqKey] = {
      question: t(`faq.${faqKey}.question`),
      answer: t(`faq.${faqKey}.answer`),
    };
  }

  const translations = {
    title: t('title'),
    subtitle: t('subtitle'),
    subscriptionActivated: t('subscriptionActivated'),
    checkoutCanceled: t('checkoutCanceled'),
    currentPlan: t('currentPlan'),
    trialEndsTemplate: t.raw('trialEnds'),
    executionsThisMonth: t('executionsThisMonth'),
    apiCallsThisMonth: t('restApiCallsThisMonth'),
    savedPolicies: t('savedPolicies'),
    monthly: t('monthly'),
    yearly: t('yearly'),
    save20: t('save20'),
    mostPopular: t('mostPopular'),
    contactSales: t('contactSales'),
    year: t('year'),
    month: t('month'),
    perUser: t('perUser'),
    teamUsers: t('teamUsers'),
    minUsersTemplate: t.raw('minUsers'),
    currentPlanButton: t('currentPlanButton'),
    loading: t('loading'),
    upgradeToTemplate: t.raw('upgradeTo'),
    freeTier: t('freeTier'),
    plans: {
      names: planNames,
      features: planFeatures,
    },
    faq: {
      title: t('faq.title'),
      productQuestions: t('faq.productQuestions'),
      billingQuestions: t('faq.billingQuestions'),
      items: faqItems,
    },
    nav: {
      dashboard: tNav('dashboard'),
      billing: tNav('billing'),
    },
  };

  return (
    <PlansContent
      currentPlan={currentPlan}
      trialEndsAt={trialEndsAt}
      initialUsage={initialUsage}
      defaultCurrency={defaultCurrency}
      translations={translations}
      locale={locale}
    />
  );
}
