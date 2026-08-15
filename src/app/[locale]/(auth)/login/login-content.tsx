'use client';

import { useState, Suspense, useCallback } from 'react';
import { signIn, signOut, useSession, getSession } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import { useLocale } from 'next-intl';
import { defaultLocale } from '@/i18n/config';
import { CLIENT_CAPABILITIES } from '@/hooks/use-deployment-mode';
import { Turnstile, TurnstilePlaceholder } from '@/components/turnstile';
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardBody,
  Input,
  Label,
  Stack,
  Wordmark,
} from '@/components/ui';

interface Translations {
  brand: string;
  title: string;
  noAccount: string;
  startTrial: string;
  orContinueWith: string;
  email: string;
  password: string;
  forgotPassword: string;
  signIn: string;
  /** 二次验证（issue #400） */
  twoFactorLabel: string;
  twoFactorHint: string;
  errors: {
    generic: string;
    rateLimited: string;
    accountLocked: string;
    accountLockedGeneric: string;
    captchaFailed: string;
    verificationFailed: string;
    invalidCredentials: string;
    invalidCredentialsWithAttempts: string;
    twoFactorMismatch: string;
    twoFactorExpired: string;
    twoFactorTooManyAttempts: string;
    twoFactorSendFailed: string;
  };
}

/**
 * 来自 server 的拒绝信息（由 markDenial → readAndClearDenial cookie 传递）。
 * 优先级高于 ?error= URL 参数：URL 是 NextAuth 自动加的泛化错误，
 * cookie 里才是 signIn callback 的具体拒绝原因 + 排查 ref。
 */
interface DenialInfo {
  /** 已本地化的错误正文 */
  message: string;
  /** 关联 ID（同时打到 server 日志），可空 */
  ref: string | null;
  /** 形如 "Reference: {ref}" 的模板，可空 */
  refTemplate: string | null;
}

interface LoginContentProps {
  translations: Translations;
  turnstileSiteKey?: string;
  denial?: DenialInfo | null;
}

function LoginForm({ translations: t, turnstileSiteKey, denial }: LoginContentProps) {
  const locale = useLocale();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [remainingAttempts, setRemainingAttempts] = useState<number | null>(null);
  /**
   * 二次验证（issue #400）。
   *
   * ★`twoFactorStage` 为 true 时进入第二屏——但 email/password 仍保留在 state 里，
   * 因为 Auth.js 的 authorize() 是一次性的：第二屏必须**连同三个字段一起**提交。
   * 不引入半登录 token（那是新的凭据类型，泄露即绕过第一因子）。
   */
  const [twoFactorStage, setTwoFactorStage] = useState(false);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const { data: session } = useSession();
  const searchParams = useSearchParams();

  // Build locale-aware default callback URL
  const localePrefix = locale === defaultLocale ? '' : `/${locale}`;
  const defaultCallbackUrl = `${localePrefix}/dashboard`;
  const explicitCallback = searchParams.get('callbackUrl');
  const callbackUrl = explicitCallback || defaultCallbackUrl;
  const errorParam = searchParams.get('error');

  /**
   * Pick the post-login landing route based on the just-authenticated
   * session. Honour an explicit `?callbackUrl=` (deep link from a
   * protected page) verbatim — admins clicking a policy link want to
   * land on that policy, not be hijacked to /admin. Only override the
   * default destination.
   */
  function resolvePostLoginUrl(
    explicit: string | null,
    isAdmin: boolean,
  ): string {
    if (explicit) return explicit;
    return isAdmin ? `${localePrefix}/admin` : defaultCallbackUrl;
  }

  const handleTurnstileVerify = useCallback((token: string) => {
    setTurnstileToken(token);
  }, []);

  const handleTurnstileExpire = useCallback(() => {
    setTurnstileToken(null);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    // 1. 预验证（Turnstile + 速率限制 + 账户锁定）
    try {
      const verifyRes = await fetch('/api/auth/verify-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, turnstileToken }),
      });

      const verifyData = await verifyRes.json();

      if (!verifyRes.ok) {
        if (verifyData.code === 'RATE_LIMITED') {
          setError(t.errors.rateLimited.replace('{seconds}', verifyData.retryAfter));
        } else if (verifyData.code === 'ACCOUNT_LOCKED') {
          setError(t.errors.accountLocked.replace('{minutes}', String(Math.ceil(verifyData.retryAfter / 60))));
        } else if (verifyData.code === 'CAPTCHA_FAILED') {
          setError(t.errors.captchaFailed);
          setTurnstileToken(null);
        } else {
          setError(verifyData.error || t.errors.verificationFailed);
        }
        setIsLoading(false);
        return;
      }

      if (verifyData.remainingAttempts !== undefined) {
        setRemainingAttempts(verifyData.remainingAttempts);
      }
    } catch (verifyError) {
      console.error('Verification error:', verifyError);
      // 验证失败时仍然尝试登录（降级处理）
    }

    // 2. 执行登录
    const result = await signIn('credentials', {
      email,
      password,
      // 第一屏为空串 → 服务端签发并发信、抛 TWO_FACTOR_REQUIRED；
      // 第二屏带上用户输入的码 → 服务端校验通过才发 session。
      twoFactorCode,
      redirect: false,
      callbackUrl,
    });

    if (result?.error) {
      // ── 二次验证分支（issue #400）──────────────────────────────────
      // ★这些不是「登录失败」，是流程的正常中间态，故不能落到
      //   invalidCredentials 那条文案上——那会让用户以为密码错了、
      //   反复重输密码而永远走不到第二屏。
      if (result.error === 'TWO_FACTOR_REQUIRED') {
        setTwoFactorStage(true);
        setError('');
        setIsLoading(false);
        setTurnstileToken(null);
        return;
      }
      if (result.error === 'TWO_FACTOR_SEND_FAILED') {
        setError(t.errors.twoFactorSendFailed);
        setIsLoading(false);
        setTurnstileToken(null);
        return;
      }
      if (result.error.startsWith('TWO_FACTOR_')) {
        // MISMATCH / EXPIRED / NO_CODE / TOO_MANY_ATTEMPTS
        const key = result.error.replace('TWO_FACTOR_', '');
        setTwoFactorStage(true);
        setTwoFactorCode('');
        setError(
          key === 'MISMATCH'
            ? t.errors.twoFactorMismatch
            : key === 'TOO_MANY_ATTEMPTS'
              ? t.errors.twoFactorTooManyAttempts
              : t.errors.twoFactorExpired,
        );
        setIsLoading(false);
        setTurnstileToken(null);
        return;
      }

      if (result.error === 'ACCOUNT_LOCKED') {
        setError(t.errors.accountLockedGeneric);
      } else {
        setError(t.errors.invalidCredentials);
        if (remainingAttempts !== null && remainingAttempts > 0) {
          setError(t.errors.invalidCredentialsWithAttempts.replace('{attempts}', String(remainingAttempts - 1)));
        }
      }
      setIsLoading(false);
      // 重置 Turnstile
      setTurnstileToken(null);
    } else if (result?.url) {
      // Signal any open /docs tab to revalidate its session probe so
      // anonymous chrome flips to authenticated. We can't synthesize
      // the authenticated state locally (we lack subjectHash and
      // capabilities); the docs tab listens for the auth-tick and
      // calls /api/docs/session-state to pick up the truth. Lazy
      // import keeps the login page off the docs hook's module graph.
      try {
        const { signalDocsSessionRefresh } = await import('@/lib/docs/use-docs-session');
        signalDocsSessionRefresh();
      } catch {
        // Best-effort; the docs tab will revalidate on next mount.
      }

      // Role-aware destination: re-read the session that NextAuth just
      // minted so we can branch on isAdmin. getSession() hits the
      // /api/auth/session endpoint, which serializes the JWT we just
      // populated in auth.ts (token.isAdmin). If the lookup fails we
      // fall back to whatever NextAuth's signIn() returned — the user
      // still lands somewhere sane.
      try {
        const session = await getSession();
        const target = resolvePostLoginUrl(
          explicitCallback,
          session?.user?.isAdmin === true,
        );
        window.location.href = target;
      } catch {
        window.location.href = result.url;
      }
    }
  };

  const handleOAuthSignIn = async (provider: string) => {
    setIsLoading(true);
    // If user is already signed in, sign out first to prevent account linking
    if (session) {
      // Clear the docs cache before the silent signOut so any open
      // docs tab flips to anonymous chrome immediately; the dashboard
      // landing after the new OAuth session will then re-emit the
      // `in` tick via DocsSessionSignal.
      try {
        const { clearDocsSessionCache } = await import('@/lib/docs/use-docs-session');
        clearDocsSessionCache();
      } catch {
        // Best-effort.
      }
      await signOut({ redirect: false });
    }
    signIn(provider, { callbackUrl });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-subtle px-4 py-12 sm:px-6">
      {/* 登录卡片宽度锚定在 max-w-md (28rem / 448px)，匹配业界主流登录页
          （Stripe / Linear / Vercel）。Container "narrow"=640px 对纯表单
          太宽，OAuth 按钮 + 输入框被拉得过开，视觉上像设置页面而非登录。 */}
      <div className="mx-auto w-full max-w-md">
        <Stack gap={8}>
          {/* Wordmark + page title */}
          <Stack gap={6} align="center" className="text-center">
            <Link href="/" aria-label={t.brand}>
              <Wordmark variant="product" size="lg" />
            </Link>
            <Stack gap={2}>
              <h1 className="font-display text-3xl font-semibold tracking-tight text-fg">
                {t.title}
              </h1>
              {/* On-prem 部署不开放自助注册（账号由 admin 邀请）；隐藏
                  "没账号？注册" 链接避免点了 404。 */}
              {CLIENT_CAPABILITIES.signup && (
                <p className="text-sm text-fg-muted">
                  {t.noAccount}{' '}
                  <Link
                    href="/signup"
                    className="font-medium text-primary hover:text-primary-hover"
                  >
                    {t.startTrial}
                  </Link>
                </p>
              )}
            </Stack>
          </Stack>

          {/* Error / denial banner */}
          {(error || denial || errorParam) && (
            <Alert variant="danger">
              <AlertDescription>
                {error || denial?.message || t.errors.generic}
              </AlertDescription>
              {denial?.ref && denial?.refTemplate && (
                <p className="mt-1 font-mono text-xs text-fg-muted">
                  {denial.refTemplate.replace('{ref}', denial.ref)}
                </p>
              )}
            </Alert>
          )}

          {/* Sign-in card */}
          <Card>
            <CardBody className="space-y-6 pt-6">
              {/* OAuth providers */}
              <div className="grid grid-cols-2 gap-3">
                <OAuthButton
                  provider="github"
                  label="GitHub"
                  disabled={isLoading}
                  onClick={() => handleOAuthSignIn('github')}
                />
                <OAuthButton
                  provider="google"
                  label="Google"
                  disabled={isLoading}
                  onClick={() => handleOAuthSignIn('google')}
                />
              </div>

              {/* Separator with label */}
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-bg px-3 text-fg-subtle">
                    {t.orContinueWith}
                  </span>
                </div>
              </div>

              {/* Email/password */}
              <form onSubmit={handleSubmit}>
                <Stack gap={4}>
                  <Stack gap={2}>
                    <Label htmlFor="email">{t.email}</Label>
                    <Input
                      id="email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </Stack>
                  <Stack gap={2}>
                    <div className="flex items-center justify-between">
                      <Label htmlFor="password">{t.password}</Label>
                      <Link
                        href="/forgot-password"
                        className="text-xs font-medium text-primary hover:text-primary-hover"
                      >
                        {t.forgotPassword}
                      </Link>
                    </div>
                    <Input
                      id="password"
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </Stack>

                  {/*
                    二次验证码（issue #400）——只在第二屏出现。

                    ★email/password 两个输入框**保留可见且可改**：Auth.js 的
                    authorize() 是一次性的，第二屏必须连同三个字段一起提交。
                    藏掉它们会让用户以为已经"过了密码关"，而实际上每次提交
                    都在重验密码。

                    inputMode/autoComplete 给移动端与密码管理器提示，
                    让邮箱里的码能被系统自动填充。
                  */}
                  {twoFactorStage && (
                    <Stack gap={2}>
                      <Label htmlFor="twoFactorCode">{t.twoFactorLabel}</Label>
                      <Input
                        id="twoFactorCode"
                        name="twoFactorCode"
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9]{6}"
                        maxLength={6}
                        required
                        autoFocus
                        value={twoFactorCode}
                        onChange={(e) =>
                          setTwoFactorCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                        }
                      />
                      <p className="text-xs text-fg-muted">{t.twoFactorHint}</p>
                    </Stack>
                  )}

                  {/* Turnstile */}
                  {turnstileSiteKey ? (
                    <div className="flex justify-center">
                      <Turnstile
                        siteKey={turnstileSiteKey}
                        onVerify={handleTurnstileVerify}
                        onExpire={handleTurnstileExpire}
                        theme="auto"
                        language={locale}
                      />
                    </div>
                  ) : process.env.NODE_ENV === 'development' ? (
                    <TurnstilePlaceholder onVerify={handleTurnstileVerify} />
                  ) : null}

                  <Button
                    type="submit"
                    disabled={isLoading || (!!turnstileSiteKey && !turnstileToken)}
                    className="w-full"
                  >
                    {isLoading ? '…' : t.signIn}
                  </Button>
                </Stack>
              </form>
            </CardBody>
          </Card>
        </Stack>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* OAuth provider button — keeps the SVG marks local so we don't pull   */
/* in @react-icons/*. Both icons render inside our Button's secondary   */
/* variant which gives them the right surface + hover treatment.        */
/* ------------------------------------------------------------------ */

function OAuthButton({
  provider, label, disabled, onClick,
}: { provider: 'github' | 'google'; label: string; disabled?: boolean; onClick: () => void }) {
  const Icon = provider === 'github' ? GitHubIcon : GoogleIcon;
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={onClick}
      disabled={disabled}
      className="w-full"
    >
      <Icon className="size-4" aria-hidden />
      <span>{label}</span>
    </Button>
  );
}

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path
        fillRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function GoogleIcon({ className }: { className?: string }) {
  // Google brand requires the original four-color mark; keep the hex as-is.
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

export function LoginContent({ translations, turnstileSiteKey, denial }: LoginContentProps) {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">Loading...</div>}>
      <LoginForm translations={translations} turnstileSiteKey={turnstileSiteKey} denial={denial} />
    </Suspense>
  );
}
