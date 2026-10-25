import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { OnboardingContent } from './onboarding-content';

export default async function OnboardingPage({ params }: { params: Promise<{ locale: string }> }) {
  // 引导流程只对已登录用户有意义（注册后经 callbackUrl / Auth.js newUser 进入）；未登录直接访问时
  // 先去登录（#589：此前未登录也能看到并提交整个向导，提交时才失败）。
  const { locale } = await params;
  const session = await getSession();
  if (!session?.user?.id) {
    redirect(`/${locale}/login?callbackUrl=${encodeURIComponent(`/${locale}/onboarding`)}`);
  }

  const t = await getTranslations('auth.onboarding');
  const tNav = await getTranslations('nav');

  // 预渲染所有翻译字符串
  const translations = {
    brand: tNav('brand'),
    welcome: t('welcome'),
    industryQuestion: t('industryQuestion'),
    goalsQuestion: t('goalsQuestion'),
    continue: t('continue'),
    back: t('back'),
    starting: t('starting'),
    getStarted: t('getStarted'),
    skipForNow: t('skipForNow'),
    useCases: {
      finance: t('useCases.finance'),
      healthcare: t('useCases.healthcare'),
      ecommerce: t('useCases.ecommerce'),
      insurance: t('useCases.insurance'),
      legal: t('useCases.legal'),
      other: t('useCases.other'),
    },
    goals: {
      pii: t('goals.pii'),
      compliance: t('goals.compliance'),
      automation: t('goals.automation'),
      team: t('goals.team'),
      integration: t('goals.integration'),
    },
  };

  return <OnboardingContent translations={translations} />;
}
