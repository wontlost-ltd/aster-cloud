'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { formatDate } from '@/lib/format';
import { Container, PageHeader } from '@/components/ui';
import {
  BillingInterval,
  CurrencyCode,
  formatPrice,
  getPlanPrice,
  getPlanStripePriceId,
  isUnlimited,
  PLANS,
  PlanType,
} from '@/lib/plans';
import FAQSection from './FAQSection';
import { extractErrorMessage } from '@/lib/api/error-envelope';

// PM v1.1：Pricing 页只展示 Free / Pro / Enterprise 三档
const DISPLAY_PLANS: PlanType[] = ['free', 'pro', 'enterprise'];
const AVAILABLE_CURRENCIES: CurrencyCode[] = ['USD', 'CNY', 'EUR'];

interface Usage {
  executions: number;
  executionsLimit: number;
  policies: number;
  policiesLimit: number;
  apiCalls: number;
  apiCallsLimit: number;
}

interface Translations {
  currencies: Record<CurrencyCode, string>;
  title: string;
  subtitle: string;
  subscriptionActivated: string;
  checkoutCanceled: string;
  currentPlan: string;
  trialEndsTemplate: string;
  executionsThisMonth: string;
  apiCallsThisMonth: string;
  savedPolicies: string;
  monthly: string;
  yearly: string;
  save20: string;
  mostPopular: string;
  contactSales: string;
  year: string;
  month: string;
  perUser: string;
  teamUsers: string;
  minUsersTemplate: string;
  currentPlanButton: string;
  loading: string;
  upgradeToTemplate: string;
  freeTier: string;
  plans: {
    names: Record<string, string>;
    features: Record<string, string>;
  };
  faq: {
    title: string;
    productQuestions: string;
    billingQuestions: string;
    items: Record<string, { question: string; answer: string }>;
  };
  nav: {
    dashboard: string;
    billing: string;
  };
}

// 简单模板插值
function formatTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
}

interface BillingContentInnerProps {
  currentPlan: PlanType;
  trialEndsAt: string | null;
  initialUsage: Usage | null;
  defaultCurrency: CurrencyCode;
  translations: Translations;
  locale: string;
}

function BillingContentInner({
  currentPlan,
  trialEndsAt,
  initialUsage,
  defaultCurrency,
  translations: t,
  locale,
}: BillingContentInnerProps) {
  const searchParams = useSearchParams();
  const [currency, setCurrency] = useState<CurrencyCode>(defaultCurrency);
  const [interval, setInterval] = useState<BillingInterval>('monthly');
  const [isLoading, setIsLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [usage, _setUsage] = useState<Usage | null>(initialUsage);

  useEffect(() => {
    // Stripe 回跳后按 URL query 同步提示（App Router URL→state 同步），故意在 effect 内 set
    if (searchParams.get('success') === 'true') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMessage({ type: 'success', text: t.subscriptionActivated });
    } else if (searchParams.get('canceled') === 'true') {
      setMessage({ type: 'error', text: t.checkoutCanceled });
    }
  }, [searchParams, t.subscriptionActivated, t.checkoutCanceled]);

  const handleCheckout = async (plan: PlanType) => {
    setIsLoading(plan);

    if (!getPlanStripePriceId(plan, interval, currency)) {
      setMessage({
        type: 'error',
        text: 'Selected plan is not available for checkout. Please contact support.',
      });
      setIsLoading(null);
      return;
    }

    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan,
          interval,
          currency,
          quantity: 1,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(extractErrorMessage(data) || 'Failed to create checkout session');
      }

      // Redirect to Stripe Checkout
      // 页面跳转赋值非 React 状态突变，误报
      // eslint-disable-next-line react-hooks/immutability
      window.location.href = data.url;
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Something went wrong',
      });
    } finally {
      setIsLoading(null);
    }
  };

  // Translation lookup function for FAQSection
  const tFn = (key: string): string => {
    // Handle nested keys like 'faq.title', 'faq.whatIsAster.question'
    const parts = key.split('.');
    if (parts[0] === 'faq') {
      if (parts.length === 2) {
        // faq.title, faq.productQuestions, faq.billingQuestions
        if (parts[1] === 'title') return t.faq.title;
        if (parts[1] === 'productQuestions') return t.faq.productQuestions;
        if (parts[1] === 'billingQuestions') return t.faq.billingQuestions;
      } else if (parts.length === 3) {
        // faq.{faqKey}.question or faq.{faqKey}.answer
        const faqKey = parts[1];
        const field = parts[2] as 'question' | 'answer';
        return t.faq.items[faqKey]?.[field] || key;
      }
    }
    return key;
  };

  return (
    <Container size="xl" className="py-6 sm:py-10">
      {/* 顶层页：sidebar 已高亮 "Billing" + PageHeader h1 显页名 → 不再放 Breadcrumbs（去三重重复）。 */}
      <PageHeader title={t.title} subtitle={t.subtitle} className="mb-6" />

      {message && (
        <div
          className={`mb-6 rounded-md p-4 ${
            message.type === 'success' ? 'bg-green-50' : 'bg-red-50'
          }`}
        >
          <p
            className={`text-sm ${
              message.type === 'success' ? 'text-green-700' : 'text-red-700'
            }`}
          >
            {message.text}
          </p>
        </div>
      )}

      {/* Current Plan */}
      <div className="bg-bg shadow sm:rounded-lg mb-8">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg font-medium text-fg">{t.currentPlan}</h3>
          <div className="mt-3 flex items-center">
            <span className="text-3xl font-bold text-fg">
              {t.plans.names[currentPlan]}
            </span>
            {currentPlan === 'trial' && trialEndsAt && (
              <span className="ml-4 text-sm text-fg-muted">
                {formatTemplate(t.trialEndsTemplate, { date: formatDate(trialEndsAt, locale) })}
              </span>
            )}
          </div>

          {/* Usage */}
          {usage && (
            <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <p className="text-sm text-fg-muted">{t.executionsThisMonth}</p>
                <p className="text-lg font-medium">
                  {usage.executions} / {isUnlimited(usage.executionsLimit) ? '∞' : usage.executionsLimit}
                </p>
                <div className="mt-1 flex items-center gap-1">
                  <div className="h-2 flex-1 bg-bg-muted rounded-full">
                    <div
                      className="h-2 bg-primary rounded-full"
                      style={{
                        width: isUnlimited(usage.executionsLimit)
                          ? '100%'
                          : `${Math.min((usage.executions / usage.executionsLimit) * 100, 100)}%`,
                      }}
                    />
                  </div>
                  {isUnlimited(usage.executionsLimit) && <span className="text-sm">♾️</span>}
                </div>
              </div>
              <div>
                <p className="text-sm text-fg-muted">{t.apiCallsThisMonth}</p>
                <p className="text-lg font-medium">
                  {usage.apiCalls} / {isUnlimited(usage.apiCallsLimit) ? '∞' : (usage.apiCallsLimit === 0 ? '-' : usage.apiCallsLimit)}
                </p>
                <div className="mt-1 flex items-center gap-1">
                  <div className="h-2 flex-1 bg-bg-muted rounded-full">
                    <div
                      className="h-2 bg-primary rounded-full"
                      style={{
                        width: usage.apiCallsLimit === 0
                          ? '0%'
                          : isUnlimited(usage.apiCallsLimit)
                            ? '100%'
                            : `${Math.min((usage.apiCalls / usage.apiCallsLimit) * 100, 100)}%`,
                      }}
                    />
                  </div>
                  {isUnlimited(usage.apiCallsLimit) && <span className="text-sm">♾️</span>}
                </div>
              </div>
              <div>
                <p className="text-sm text-fg-muted">{t.savedPolicies}</p>
                <p className="text-lg font-medium">
                  {usage.policies} / {isUnlimited(usage.policiesLimit) ? '∞' : usage.policiesLimit}
                </p>
                <div className="mt-1 flex items-center gap-1">
                  <div className="h-2 flex-1 bg-bg-muted rounded-full">
                    <div
                      className="h-2 bg-primary rounded-full"
                      style={{
                        width: isUnlimited(usage.policiesLimit)
                          ? '100%'
                          : `${Math.min((usage.policies / usage.policiesLimit) * 100, 100)}%`,
                      }}
                    />
                  </div>
                  {isUnlimited(usage.policiesLimit) && <span className="text-sm">♾️</span>}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Billing Options: Interval Toggle + Currency Selector */}
      <div className="flex flex-col sm:flex-row justify-center items-center gap-4 mb-8">
        {/* Billing Interval Toggle */}
        <div className="relative flex rounded-lg bg-bg-muted p-1">
          <button
            type="button"
            onClick={() => setInterval('monthly')}
            className={`relative px-4 py-2 text-sm font-medium rounded-md ${
              interval === 'monthly'
                ? 'bg-bg text-fg shadow'
                : 'text-fg-muted hover:text-fg'
            }`}
          >
            {t.monthly}
          </button>
          <button
            type="button"
            onClick={() => setInterval('yearly')}
            className={`relative px-4 py-2 text-sm font-medium rounded-md ${
              interval === 'yearly'
                ? 'bg-bg text-fg shadow'
                : 'text-fg-muted hover:text-fg'
            }`}
          >
            {t.yearly}
            <span className="ml-1 text-xs text-green-600 font-semibold">{t.save20}</span>
          </button>
        </div>

        {/* Currency Selector */}
        <div className="relative">
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
            className="appearance-none bg-bg border border-border-strong rounded-lg px-4 py-2 pr-8 text-sm font-medium text-fg hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary cursor-pointer"
          >
            {AVAILABLE_CURRENCIES.map((curr) => (
              <option key={curr} value={curr}>
                {t.currencies[curr]}
              </option>
            ))}
          </select>
          <div className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
            <svg className="h-4 w-4 text-fg-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>
      </div>

      {/* Plans Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {DISPLAY_PLANS.map((planKey) => {
          const plan = PLANS[planKey];
          const isCurrentPlan = currentPlan === planKey;
          const canCheckout = Boolean(getPlanStripePriceId(planKey, interval, currency));
          const isFeatured = planKey === 'pro';
          const priceValue = getPlanPrice(planKey, currency)[interval];
          const showInterval = typeof priceValue === 'number' && priceValue > 0;

          return (
            <div
              key={planKey}
              className={`rounded-2xl bg-bg p-8 flex flex-col ${
                isFeatured ? 'border-2 border-primary shadow-xl relative' : 'border border-border'
              }`}
            >
              {isFeatured && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-white text-xs font-semibold px-3 py-1 rounded-full">
                  {t.mostPopular}
                </span>
              )}
              <h3 className="text-lg font-semibold text-fg">
                {t.plans.names[planKey]}
              </h3>

              <div className="mt-4 flex items-baseline">
                {priceValue === null ? (
                  <span className="text-2xl font-semibold text-fg">{t.contactSales}</span>
                ) : (
                  <>
                    <span className="text-4xl font-bold text-fg">
                      {formatPrice(priceValue, currency)}
                    </span>
                    {showInterval && (
                      <span className="ml-1 text-fg-muted">/{interval === 'yearly' ? t.year : t.month}</span>
                    )}
                  </>
                )}
              </div>

              <ul className="mt-6 space-y-3 flex-1">
                {plan.featureKeys.map((featureKey) => (
                  <li key={featureKey} className="flex items-center text-sm text-fg-muted">
                    <svg className="h-4 w-4 text-green-500 mr-2" viewBox="0 0 20 20" fill="currentColor">
                      <path
                        fillRule="evenodd"
                        d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
                        clipRule="evenodd"
                      />
                    </svg>
                    {t.plans.features[featureKey] ?? featureKey}
                  </li>
                ))}
              </ul>

              <div className="mt-auto pt-8">
                {isCurrentPlan ? (
                  <button
                    disabled
                    className="w-full rounded-md bg-bg-muted px-4 py-2 text-sm font-semibold text-fg-subtle"
                  >
                    {t.currentPlanButton}
                  </button>
                ) : canCheckout ? (
                  <button
                    onClick={() => handleCheckout(planKey)}
                    disabled={isLoading !== null}
                    className={`w-full rounded-md px-4 py-2 text-sm font-semibold shadow-sm ${
                      planKey === 'pro'
                        ? 'bg-primary text-white hover:bg-primary-hover'
                        : 'bg-gray-900 text-white hover:bg-gray-800'
                    } disabled:opacity-50`}
                  >
                    {isLoading === planKey ? t.loading : formatTemplate(t.upgradeToTemplate, { plan: t.plans.names[planKey] })}
                  </button>
                ) : planKey === 'free' ? (
                  <button
                    disabled
                    className="w-full rounded-md bg-bg-muted px-4 py-2 text-sm font-semibold text-fg-muted"
                  >
                    {t.freeTier}
                  </button>
                ) : (
                  <button
                    disabled
                    className="w-full rounded-md bg-bg-muted px-4 py-2 text-sm font-semibold text-fg-muted"
                  >
                    {t.contactSales}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* FAQ */}
      <FAQSection t={tFn} />
    </Container>
  );
}

interface BillingContentProps {
  currentPlan: PlanType;
  trialEndsAt: string | null;
  initialUsage: Usage | null;
  defaultCurrency: CurrencyCode;
  translations: Translations;
  locale: string;
}

export function PlansContent(props: BillingContentProps) {
  return (
    <Suspense fallback={<div className="animate-pulse">Loading billing...</div>}>
      <BillingContentInner {...props} />
    </Suspense>
  );
}
