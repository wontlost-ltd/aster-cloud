import { getTranslations } from 'next-intl/server';
import { LoginContent } from './login-content';
import { readDenial, type DenialReason } from '@/lib/auth-denial';

const KNOWN_REASONS: DenialReason[] = [
  'signup_rate_limit',
  'disposable_email',
  'account_deleted',
  'oauth_link_blocked',
  'unknown',
];

export default async function LoginPage() {
  const t = await getTranslations('auth.login');
  const tNav = await getTranslations('nav');

  // 读取 markDenial() 设的 cookie；若存在则把 reason+ref 传给客户端。
  // Server Component 不能 set cookie（参见 readDenial 注释），自然过期即可。
  const denial = await readDenial();
  const denialReason: DenialReason | null =
    denial && KNOWN_REASONS.includes(denial.reason) ? denial.reason : null;
  const denialMessage = denialReason
    ? (t.raw(`errors.accessDenied.${denialReason}`) as string)
    : null;
  const refSupportTemplate = denial?.ref
    ? (t.raw('errors.refSupport') as string)
    : null;

  // 预渲染所有翻译字符串
  const translations = {
    brand: tNav('brand'),
    title: t('title'),
    noAccount: t('noAccount'),
    startTrial: t('startTrial'),
    orContinueWith: t('orContinueWith'),
    email: t('email'),
    password: t('password'),
    forgotPassword: t('forgotPassword'),
    signIn: t('signIn'),
    // 二次验证（issue #400）
    twoFactorLabel: t('twoFactorLabel'),
    twoFactorHint: t('twoFactorHint'),
    rememberDevice: t('rememberDevice'),
    rememberDeviceHint: t('rememberDeviceHint'),
    errors: {
      generic: t('errors.generic'),
      rateLimited: t.raw('errors.rateLimited'),
      accountLocked: t.raw('errors.accountLocked'),
      accountLockedGeneric: t('errors.accountLockedGeneric'),
      captchaFailed: t('errors.captchaFailed'),
      verificationFailed: t('errors.verificationFailed'),
      invalidCredentials: t('errors.invalidCredentials'),
      invalidCredentialsWithAttempts: t.raw('errors.invalidCredentialsWithAttempts'),
      twoFactorMismatch: t('errors.twoFactorMismatch'),
      twoFactorExpired: t('errors.twoFactorExpired'),
      twoFactorTooManyAttempts: t('errors.twoFactorTooManyAttempts'),
      twoFactorWindowExceeded: t('errors.twoFactorWindowExceeded'),
      twoFactorSendFailed: t('errors.twoFactorSendFailed'),
    },
  };

  // 获取 Turnstile Site Key（服务端安全传递）
  const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || '';

  return (
    <LoginContent
      translations={translations}
      turnstileSiteKey={turnstileSiteKey}
      denial={
        denialMessage
          ? {
              message: denialMessage,
              ref: denial?.ref ?? null,
              refTemplate: refSupportTemplate,
            }
          : null
      }
    />
  );
}
