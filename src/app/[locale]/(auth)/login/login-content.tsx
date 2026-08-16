'use client';

import { useState, Suspense, useCallback } from 'react';
import { signIn, signOut, useSession, getSession } from 'next-auth/react';
import { Eye, EyeOff } from 'lucide-react';
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
  /** 密码可见性切换按钮的无障碍标签（图标按钮必须有可读名称）。 */
  showPassword: string;
  hidePassword: string;
  /** Caps Lock 开启时的提示——要说清后果，不能只说"已开启"。 */
  capsLockOn: string;
  forgotPassword: string;
  signIn: string;
  /** 二次验证（issue #400） */
  twoFactorLabel: string;
  twoFactorHint: string;
  /** TOTP 用户看到的提示（不发邮件，故不能沿用"已发送邮件"那句）。 */
  twoFactorTotpHint: string;
  rememberDevice: string;
  rememberDeviceHint: string;
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
    twoFactorWindowExceeded: string;
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
  /**
   * 本次第二因子是验证器还是邮件码。
   *
   * ★必须区分：邮件用户的提示是「已发送验证码到邮箱」，而 TOTP 用户
   * 根本不会收到邮件——给他看那句话会让他去邮箱里空等。
   */
  const [totpMode, setTotpMode] = useState(false);
  /** 密码是否明文显示。★默认 false——不能让密码在无人预期时可见。 */
  const [passwordVisible, setPasswordVisible] = useState(false);
  /**
   * Caps Lock 是否开启。
   *
   * ★为什么值得单独提示：密码框永远是圆点，用户看不出自己在输大写。
   * 密码大小写敏感，Caps Lock 开着时会反复登录失败却查不出原因——
   * 这是"账户被锁定"类工单里最常见的一种，而它完全可以被一句提示避免。
   */
  const [capsLock, setCapsLock] = useState(false);

  /**
   * 从键盘事件读取 Caps Lock 状态。
   *
   * ★用 `getModifierState` 而不是猜按键：它反映的是**当前真实状态**，
   * 而不是"刚才按了哪个键"。焦点进入时也要探测一次——用户可能在聚焦
   * **之前**就已经开着 Caps Lock，只监听 keydown 会漏掉这种情况
   * （也是最常见的情况）。
   */
  const probeCapsLock = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement> | React.MouseEvent<HTMLInputElement>) => {
      const native = e.nativeEvent as unknown as {
        getModifierState?: (key: string) => boolean;
      };
      // 只有 KeyboardEvent / MouseEvent 实现了 getModifierState；
      // 这里的类型守卫同时兜住"某些 runtime 没实现"的情况。
      if (typeof native.getModifierState === 'function') {
        setCapsLock(native.getModifierState('CapsLock'));
      }
    },
    [],
  );
  /** 「记住该设备」——★必须用户主动勾选，默认 false，不预勾。 */
  const [rememberDevice, setRememberDevice] = useState(false);
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
      // ★此处**不再**降级继续登录（审查发现的 Critical 的一半）。
      //   原本的「验证失败时仍然尝试登录」让被限流的诚实浏览器也 fail-open，
      //   等于把预检变成纯装饰。现在预检异常即中止本次提交。
      //   真正的兜底在服务端：authorize() 自身已有按邮箱的限流，
      //   攻击者绕过本预检也拿不到无限次尝试。
      console.error('Verification error:', verifyError);
      setError(t.errors.verificationFailed);
      setIsLoading(false);
      return;
    }

    // 2. 读出既有可信设备 token（httpOnly cookie，前端读不到，需走 API）。
    //    有效则 authorize 会跳过第二因子。
    let trustedDeviceToken = '';
    try {
      const tdRes = await fetch('/api/auth/trusted-device');
      if (tdRes.ok) trustedDeviceToken = (await tdRes.json()).token ?? '';
    } catch {
      // 读不到就当没有——退化为要验证码，不影响可用性。
    }

    // 3. 执行登录
    const result = await signIn('credentials', {
      email,
      password,
      // 第一屏为空串 → 服务端签发并发信、抛 TWO_FACTOR_REQUIRED；
      // 第二屏带上用户输入的码 → 服务端校验通过才发 session。
      twoFactorCode,
      trustedDeviceToken,
      redirect: false,
      callbackUrl,
    });

    if (result?.error) {
      // ── 二次验证分支（issue #400）──────────────────────────────────
      // ★这些不是「登录失败」，是流程的正常中间态，故不能落到
      //   invalidCredentials 那条文案上——那会让用户以为密码错了、
      //   反复重输密码而永远走不到第二屏。
      //
      // ★★必须读 `result.code` 而不是 `result.error`（线上事故，勿改回）：
      //   Auth.js v5 把 authorize() 抛出的**任何**错误都归一化成
      //   `error='CredentialsSignin'`，原始 message 只进服务端日志。
      //   只有 `CredentialsSignin.code` 会被透传到重定向 URL 的 code 参数，
      //   再由 signIn() 一并返回（见 next-auth/react.js:174-175）。
      //   初版比较 result.error === 'TWO_FACTOR_REQUIRED' 恒为 false →
      //   密码正确的用户看到「邮箱或密码错误」，第二屏永远出不来。
      const code = result.code ?? '';
      // 已绑定验证器的用户：进第二屏，但走 TOTP 口径（不发邮件）。
      if (code === 'TWO_FACTOR_TOTP_REQUIRED') {
        setTotpMode(true);
        setTwoFactorStage(true);
        setError('');
        setIsLoading(false);
        setTurnstileToken(null);
        return;
      }
      if (code.startsWith('TWO_FACTOR_TOTP_')) {
        // TOTP_MISMATCH / TOTP_REPLAY / TOTP_NOT_ENABLED
        setTotpMode(true);
        setTwoFactorStage(true);
        setTwoFactorCode('');
        setError(t.errors.twoFactorMismatch);
        setIsLoading(false);
        setTurnstileToken(null);
        return;
      }
      if (code === 'TWO_FACTOR_REQUIRED') {
        setTwoFactorStage(true);
        setError('');
        setIsLoading(false);
        setTurnstileToken(null);
        return;
      }
      if (code === 'TWO_FACTOR_SEND_FAILED') {
        setError(t.errors.twoFactorSendFailed);
        setIsLoading(false);
        setTurnstileToken(null);
        return;
      }
      if (code.startsWith('TWO_FACTOR_')) {
        // MISMATCH / EXPIRED / NO_CODE / TOO_MANY_ATTEMPTS / WINDOW_EXCEEDED
        const key = code.replace('TWO_FACTOR_', '');
        setTwoFactorStage(true);
        setTwoFactorCode('');
        setError(
          key === 'MISMATCH'
            ? t.errors.twoFactorMismatch
            : key === 'TOO_MANY_ATTEMPTS'
              ? t.errors.twoFactorTooManyAttempts
              : // ★WINDOW_EXCEEDED 必须有独立文案（安全审查发现）：
                //   它此前落到 twoFactorExpired（"验证码已过期"）上，而用户
                //   实际是被限流了。看到"已过期"的人会立刻点重发再试一次——
                //   正是限流想阻止的行为，也正是本分支上方注释所警惕的那种
                //   "文案把用户推向错误动作"。这里明确告知需要等待。
                key === 'WINDOW_EXCEEDED'
                ? t.errors.twoFactorWindowExceeded
                : t.errors.twoFactorExpired,
        );
        setIsLoading(false);
        setTurnstileToken(null);
        return;
      }

      if (code === 'TWO_FACTOR_ACCOUNT_LOCKED') {
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
      // 登录成功且用户勾选了「记住该设备」→ 签发可信设备 token。
      // ★放在这里而非 authorize()：Auth.js 的 authorize 拿不到 Next 的
      //   request/response，写不了 cookie。
      if (rememberDevice) {
        try {
          await fetch('/api/auth/trusted-device', { method: 'POST' });
        } catch {
          // 签发失败不阻断登录——下次照常要验证码而已。
        }
      }

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
                    <div className="relative">
                      <Input
                        id="password"
                        name="password"
                        type={passwordVisible ? 'text' : 'password'}
                        autoComplete="current-password"
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        // ★事件选择是被浏览器 API 逼出来的，不是随意挑的：
                        //   **FocusEvent 没有 getModifierState**（实测
                        //   `typeof new FocusEvent('focus').getModifierState === 'undefined'`），
                        //   只有 KeyboardEvent 与 MouseEvent 有。所以"聚焦即检测"
                        //   在浏览器上根本做不到——我第一版挂了 onFocus，
                        //   守卫静默返回，提示永不出现。
                        //   退而求其次：onMouseDown 覆盖"点击进入输入框"这条最常见路径
                        //   （此时能拿到真实状态），键盘事件覆盖输入过程中的切换。
                        //   若用户用 Tab 键进入且未按任何键，则要等他敲第一个字符才提示。
                        onMouseDown={probeCapsLock}
                        onKeyDown={probeCapsLock}
                        onKeyUp={probeCapsLock}
                        onBlur={() => setCapsLock(false)}
                        // 给右侧图标按钮让出空间，避免长密码被按钮盖住。
                        className="pr-10"
                      />
                      <button
                        type="button"
                        // ★必须是 type="button"：默认的 submit 会让点击"看一眼密码"
                        //   直接提交表单。
                        onClick={() => setPasswordVisible((v) => !v)}
                        // ★图标按钮没有可读文本，必须给 aria-label，
                        //   否则读屏用户只听到"按钮"。
                        aria-label={passwordVisible ? t.hidePassword : t.showPassword}
                        aria-pressed={passwordVisible}
                        // 不进 Tab 序列：键盘用户从密码框应直达"登录"，
                        // 而不是先经过一个装饰性控件。
                        tabIndex={-1}
                        className="absolute inset-y-0 right-0 flex items-center px-3 text-fg-muted transition-colors hover:text-fg"
                      >
                        {/* ★用 lucide 图标而非 emoji：emoji 在不同系统上字形/配色
                            各异，与设计系统不统一；且它是文本，会被读屏念成
                            "捂眼睛的猴子"。仓内既有做法就是 lucide（见 signup 页）。
                            aria-hidden：可读名称由按钮的 aria-label 承担。 */}
                        {passwordVisible ? (
                          <EyeOff className="h-4 w-4" aria-hidden="true" />
                        ) : (
                          <Eye className="h-4 w-4" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                    {capsLock && (
                      // role=status：变化时读屏会播报，但不打断用户当前操作。
                      <p role="status" className="text-xs text-warning">
                        {t.capsLockOn}
                      </p>
                    )}
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
                        pattern={totpMode ? undefined : '[0-9]{6}'}
                        maxLength={totpMode ? 9 : 6}
                        required
                        autoFocus
                        value={twoFactorCode}
                        onChange={(e) =>
                          setTwoFactorCode(
                            totpMode
                              // TOTP 屏还要能输恢复码（XXXX-XXXX），故保留字母与连字符。
                              ? e.target.value.toUpperCase().slice(0, 9)
                              : e.target.value.replace(/\D/g, '').slice(0, 6),
                          )
                        }
                      />
                      <p className="text-xs text-fg-muted">
                        {totpMode ? t.twoFactorTotpHint : t.twoFactorHint}
                      </p>
                      {/*
                        ★必须用户主动勾选，默认不勾。预勾会让"记住设备"变成
                        被动采集——那正是本实现刻意避开设备指纹的理由。
                      */}
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={rememberDevice}
                          onChange={(e) => setRememberDevice(e.target.checked)}
                          className="h-4 w-4 rounded border-border"
                        />
                        <span>{t.rememberDevice}</span>
                      </label>
                      <p className="text-xs text-fg-muted">{t.rememberDeviceHint}</p>
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
