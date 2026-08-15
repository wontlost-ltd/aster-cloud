/**
 * Auth.js v5 配置
 *
 * Auth.js v5 使用 fetch API 而非 Node.js https 模块，
 * 完全兼容 Cloudflare Workers 边缘运行时。
 */
import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';
import Google from 'next-auth/providers/google';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { getDb, users } from '@/lib/prisma';
import { DrizzleAdapter } from '@/db/adapter';
import { IS_SAAS } from '@/lib/deployment-mode';
import { sendWelcomeEmail } from '@/lib/resend';
import { checkAccountLockout, recordFailedAttempt, resetFailedAttempts } from '@/lib/account-lockout';
import { markDenial } from '@/lib/auth-denial';
import type { NextAuthConfig } from 'next-auth';

// Password utilities
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hashedPassword: string): Promise<boolean> {
  return bcrypt.compare(password, hashedPassword);
}

/**
 * Auth.js v5 配置
 * 在 Cloudflare Workers 中，环境变量在运行时可用
 */
const config: NextAuthConfig = {
  // 使用自定义 Drizzle adapter
  adapter: DrizzleAdapter(getDb),

  // OAuth 和 Credentials providers
  // ★★ 二次验证的覆盖范围（issue #400）——**OAuth 路径不经过第二因子** ★★
  //
  // 邮件 6 位码挂在下面的 Credentials.authorize() 里，而 GitHub/Google
  // **不走 authorize()**：OAuth 回调直接进 jwt/session callback。
  // 所以走 OAuth 登录的用户，本站不施加第二因子，安全性完全取决于
  // 他在 GitHub/Google 上**自己有没有开 2FA**——而多数人没开。
  //
  // 这是**有意的取舍**而非遗漏：给 OAuth 也加一道码会把「一键登录」变成两步，
  // 且 OAuth 提供方本就承担了身份验证职责。但它意味着一句话必须说准：
  //   ✅「密码登录已启用二次验证」
  //   ❌「本站已启用二次验证」——后者对 OAuth 用户不成立
  // 对外材料、合规问卷、安全页面引用时，请勿把它说成全站覆盖。
  //
  // 若将来要求全站强制，需在 signIn callback 里对 OAuth 也插入一次验证，
  // 那是独立改动（涉及 OAuth 回调的中断与恢复），不在 #400 第一步范围内。
  providers: [
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      // OAuth provider 已验证邮箱所有权 → 允许把新 GitHub 账户 link 到
      // 已有同邮箱 user（避免 Auth.js v5 默认抛 OAuthAccountNotLinked）。
      // 风险：若 OAuth provider 允许未验证邮箱，攻击者可借此接管账户。
      // GitHub 默认要求邮箱验证才暴露给应用，故此处可接受。
      allowDangerousEmailAccountLinking: true,
    }),
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      // 同上。Google 始终只返回已验证邮箱。
      allowDangerousEmailAccountLinking: true,
    }),
    Credentials({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
        /**
         * 邮件二次验证码（issue #400）。第一屏不传（触发签发+发信），
         * 第二屏连同 email/password 一起回传——见 authorize 内的说明。
         */
        twoFactorCode: { label: 'Verification code', type: 'text' },
        /** 已有的可信设备 token（来自 httpOnly cookie，由 /api/auth/trusted-device 读出并回传） */
        trustedDeviceToken: { label: 'Trusted device token', type: 'text' },
        /** 用户是否勾选了「记住该设备」——★必须主动勾选，不默认开启 */
        rememberDevice: { label: 'Remember this device', type: 'text' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        // Cold-start safety net: the credentials callback can be the
        // very first server request after a deploy (a brand-new visitor
        // hitting /login). The dashboard layout's bootstrap won't have
        // run yet, so the admin row may not exist + the
        // mustChangePassword column may be missing. Run the bootstrap
        // here too — it's idempotent + advisory-locked, so a parallel
        // call from the dashboard layout is a no-op.
        try {
          const { ensureSchemaApplied, ensureAdminSeeded } = await import(
            '@/lib/db-bootstrap'
          );
          await ensureSchemaApplied();
          // Block on the admin seed too — otherwise the very first
          // login attempt races the in-flight insert and the user
          // lookup below sees no row.
          await ensureAdminSeeded();
        } catch (err) {
          console.warn('[auth] ensureSchemaApplied failed:', err);
        }

        const email = (credentials.email as string).toLowerCase().trim();

        // ★服务端限流（审查发现的 Critical）。
        //
        //   此前 Turnstile / 限流 / 锁定预检**全在 `/api/auth/verify-login`**，
        //   而那条路由是前端**自愿调用**的：攻击者用 curl 直接打
        //   `/api/auth/callback/credentials` 就完全跳过。更糟的是前端在预检
        //   失败时还会「降级处理」继续登录（fail-open）。
        //
        //   限流必须落在**攻击者无法绕过的那一层**，即 authorize() 本身。
        //   这里按邮箱限流（authorize 拿不到 request/IP）；IP 维度的限流
        //   仍由 verify-login 承担，两者互补而非互替。
        try {
          const { checkRateLimitDistributed } = await import('@/lib/rate-limit-distributed');
          const { RateLimitPresets } = await import('@/lib/rate-limit');
          const rl = await checkRateLimitDistributed(
            `authorize:${email}`,
            RateLimitPresets.LOGIN,
          );
          if (!rl.allowed) {
            console.warn(`[auth] 限流拒绝: email=${email}`);
            throw new Error('RATE_LIMITED');
          }
        } catch (err) {
          // ★限流器自身故障时**放行**而非拒绝：限流是防滥用而非鉴权，
          //   让它成为登录的单点故障会把一次 KV 抖动变成全站登录中断。
          //   但 RATE_LIMITED 必须原样抛出，不能被这个 catch 吞掉。
          if (err instanceof Error && err.message === 'RATE_LIMITED') throw err;
          console.error('[auth] 限流检查失败，放行:', err);
        }

        // 检查账户锁定状态
        const lockoutStatus = await checkAccountLockout(email);
        if (lockoutStatus.locked) {
          console.warn(`[Auth] 账户被锁定: ${email}, 解锁时间: ${lockoutStatus.lockedUntil}`);
          throw new Error('ACCOUNT_LOCKED');
        }

        // Find user with password hash
        const db = getDb();
        const user = await db.query.users.findFirst({
          where: eq(users.email, email),
          columns: {
            id: true,
            email: true,
            name: true,
            image: true,
            passwordHash: true,
          },
        });

        // User not found or no password set (OAuth-only user)
        if (!user || !user.passwordHash) {
          // Diagnostic logging — minified worker.js swallows the
          // distinction between "no user" / "no password" / "bad
          // password" and surfaces all three as the generic
          // CredentialsSignin error. Logging lets the operator
          // inspect Worker output to tell them apart.
          console.warn(
            `[auth] credentials reject: email=${email} found=${!!user} hasPasswordHash=${!!user?.passwordHash}`,
          );
          await recordFailedAttempt(email);
          return null;
        }

        // Verify password
        const isValidPassword = await verifyPassword(
          credentials.password as string,
          user.passwordHash
        );

        if (!isValidPassword) {
          console.warn(
            `[auth] credentials reject: email=${email} reason=invalid-password`,
          );
          const failedResult = await recordFailedAttempt(email);
          if (failedResult.nowLocked) {
            console.warn(`[Auth] 账户因多次失败被锁定: ${email}`);
            throw new Error('ACCOUNT_LOCKED');
          }
          return null;
        }

        // ── 第二因子：邮件验证码（issue #400）────────────────────────────
        //
        // ★这一段必须在"密码已验过"之后、"发 session"之前。放前面等于让
        //   未提供密码的人也能触发发信（邮件轰炸放大器）；放后面就没有意义了。
        //
        // ★Auth.js v5 的 authorize() 没有"密码对了但还要第二步"的中间态，
        //   故采用**一次提交收齐三个字段**：前端分两屏，第二屏连同 email+password
        //   一起提交 twoFactorCode。不引入半登录 token——那是新的凭据类型、
        //   泄露即绕过第一因子，需要单独一轮安全审计（见 lib/two-factor.ts 头注释）。
        // 「记住该设备」：用户**主动勾选**过的设备可跳过第二因子。
        //
        // ★存的是随机 token 的 hash，不是设备指纹——指纹是被动采集的跨站
        //   可追踪标识，用户无从察觉也无从清除，且并不更安全（可伪造）。
        //   详见 lib/trusted-device.ts 头注释。
        //
        // ★校验必须带 userId：只按 token 查会让 A 的可信设备 cookie 在 B
        //   登录时也生效——那是跨账户的二次验证绕过。
        const trustToken =
          typeof credentials.trustedDeviceToken === 'string'
            ? credentials.trustedDeviceToken
            : null;
        if (trustToken) {
          const { isTrustedDevice } = await import('@/lib/trusted-device');
          if (await isTrustedDevice(user.id, trustToken)) {
            await resetFailedAttempts(email);
            return {
              id: user.id,
              email: user.email,
              name: user.name,
              image: user.image,
            };
          }
          // token 无效/过期/属于别的账户 → 不放行，照常走验证码流程。
        }

        const submittedCode =
          typeof credentials.twoFactorCode === 'string'
            ? credentials.twoFactorCode.trim()
            : '';

        if (!submittedCode) {
          // 第一屏：密码已通过，签发并发信，然后要求前端进入第二屏。
          // 已有未过期码时不重复发信（节流，避免被当成轰炸放大器）。
          // ★签发与发信分成两段 try：限次超限**不能**被 catch 改写成
          //   TWO_FACTOR_SEND_FAILED——那会让用户看到"发送失败"并不断重试，
          //   而真实原因是"你已经试太多次了"。两者的用户动作完全不同。
          //   （我第一版正是把 throw 写在同一个 try 里，自查时发现。）
          const { issueCode, hasActiveCode, CODE_TTL_MINUTES } = await import(
            '@/lib/two-factor'
          );
          let pendingCode: string | null = null;
          if (!(await hasActiveCode(email))) {
            const issued = await issueCode(email);
            if (!issued.ok) {
              console.warn(`[auth] 2FA window exceeded: email=${email}`);
              throw new Error('TWO_FACTOR_WINDOW_EXCEEDED');
            }
            pendingCode = issued.code;
          }

          if (pendingCode) {
            try {
              const { sendTwoFactorCodeEmail } = await import('@/lib/resend');
              await sendTwoFactorCodeEmail(email, pendingCode, CODE_TTL_MINUTES);
            } catch (err) {
              // 发信失败必须让用户看见：静默失败会让他卡在验证码界面永远等不到信。
              console.error('[auth] 2FA code dispatch failed:', err);
              throw new Error('TWO_FACTOR_SEND_FAILED');
            }
          }
          throw new Error('TWO_FACTOR_REQUIRED');
        }

        const { verifyCode } = await import('@/lib/two-factor');
        const verdict = await verifyCode(email, submittedCode);
        if (!verdict.ok) {
          // ★验证码错**不**计入账户锁定：那条轴锁的是"密码错太多次"。
          //   合并会让攻击者用错误验证码把受害者账户锁死（拒绝服务）——
          //   他只需要知道邮箱，而邮箱不是秘密。
          //   验证码自己的限次在 verifyCode 内部（MAX_ATTEMPTS）。
          console.warn(`[auth] 2FA reject: email=${email} reason=${verdict.reason}`);
          throw new Error(`TWO_FACTOR_${verdict.reason}`);
        }

        // 登录成功，重置失败计数
        await resetFailedAttempts(email);

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
        };
      },
    }),
  ],

  // 使用 JWT session 策略
  session: {
    strategy: 'jwt',
    /**
     * 7 天（issue #400）。此前未设置，用的是 Auth.js 默认的 **30 天**。
     *
     * ★为什么要显式设短：JWT 策略下 session **无法服务端吊销**——
     * 改密码、发现异常登录、甚至删掉用户，已签发的 token 在过期前都仍然有效。
     * 有效期是这条链路上**唯一**的补偿手段，30 天对信贷风控场景偏长。
     *
     * ★它同时决定了二次验证的实际频率：一次 6 位码换来的免验证窗口就是这个数。
     * 调长会同时削弱两件事（吊销延迟 + 验证频率），不是单纯的体验参数。
     */
    maxAge: 7 * 24 * 60 * 60,
  },

  // 自定义页面
  pages: {
    signIn: '/login',
    signOut: '/logout',
    error: '/login',
    newUser: '/onboarding',
  },

  // Callbacks
  callbacks: {
    async jwt({ token, user, trigger }) {
      if (user) {
        token.id = user.id;

        // Fetch user data including plan
        const db = getDb();
        const dbUser = await db.query.users.findFirst({
          where: eq(users.id, user.id!),
          columns: {
            plan: true,
            trialEndsAt: true,
            stripeCustomerId: true,
            isAdmin: true,
          },
        });

        if (dbUser) {
          token.plan = dbUser.plan;
          token.trialEndsAt = dbUser.trialEndsAt?.toISOString();
          token.isAdmin = dbUser.isAdmin === true;
        }
      }

      // Refresh plan data periodically
      if (trigger === 'update' && token.id) {
        const db = getDb();
        const dbUser = await db.query.users.findFirst({
          where: eq(users.id, token.id as string),
          columns: { plan: true, trialEndsAt: true, isAdmin: true },
        });

        if (dbUser) {
          token.plan = dbUser.plan;
          token.trialEndsAt = dbUser.trialEndsAt?.toISOString();
          token.isAdmin = dbUser.isAdmin === true;
        }
      }

      return token;
    },

    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string;
        session.user.plan = token.plan as string;
        session.user.trialEndsAt = token.trialEndsAt as string | undefined;
        session.user.isAdmin = token.isAdmin === true;
      }
      return session;
    },

    async signIn({ user, account, profile: _profile }) {
      const db = getDb();

      // Credentials provider: 已在 authorize() 里查过 user 并验证密码。
      // 这里仅复查"是否处于墓碑"——如是，触发 grace 期内复活。
      if (account?.provider === 'credentials') {
        if (user.id) {
          const row = await db.query.users.findFirst({
            where: (u, { eq }) => eq(u.id, user.id!),
            columns: { id: true, email: true, deletedAt: true, purgePendingUntil: true, emailNormalized: true },
          });
          if (row?.deletedAt) {
            const stillInGrace = row.purgePendingUntil && row.purgePendingUntil > new Date();
            if (stillInGrace && row.email) {
              const { normalizeEmail } = await import('@/lib/email-normalize');
              const { reactivateUser } = await import('@/lib/user-lifecycle');
              await reactivateUser(db, row.id, normalizeEmail(row.email));
              console.warn(`[auth] reactivated tombstoned user via credentials: ${row.id}`);
              return true;
            }
            // 已过 grace 或异常状态 → 拒绝（authorize 应该没让密码通过，但兜底）
            await markDenial('account_deleted', {
              email: row.email ?? user.email,
              provider: 'credentials',
            });
            return false;
          }
        }
        return true;
      }

      if (account?.provider) {
        const existingAccount = await db.query.accounts.findFirst({
          where: (accounts, { and, eq }) => and(
            eq(accounts.provider, account.provider),
            eq(accounts.providerAccountId, account.providerAccountId)
          ),
        });

        if (existingAccount) {
          // 已绑 account 的同时还要查 owning user 是否被软删
          const owner = await db.query.users.findFirst({
            where: (u, { eq }) => eq(u.id, existingAccount.userId),
            columns: { id: true, email: true, deletedAt: true, purgePendingUntil: true },
          });
          if (owner?.deletedAt) {
            const stillInGrace = owner.purgePendingUntil && owner.purgePendingUntil > new Date();
            if (stillInGrace && owner.email) {
              const { normalizeEmail } = await import('@/lib/email-normalize');
              const { reactivateUser } = await import('@/lib/user-lifecycle');
              await reactivateUser(db, owner.id, normalizeEmail(owner.email));
              console.warn(`[auth] reactivated tombstoned user via OAuth: ${owner.id}`);
              return true;
            }
            await markDenial('account_deleted', {
              email: owner.email ?? user.email,
              provider: account.provider,
            });
            return false;
          }
          return true;
        }

        // 反多重注册 + 一次性邮箱 + IP 限流
        if (user.email) {
          const [
            { normalizeEmail },
            { isDisposableEmail },
            { checkSignupRateLimit, recordSignupAttempt },
            { findTombstonedUserByNormalizedEmail, reactivateUser },
          ] = await Promise.all([
            import('@/lib/email-normalize'),
            import('@/lib/email-disposable'),
            import('@/lib/signup-rate-limit'),
            import('@/lib/user-lifecycle'),
          ]);

          // 取请求 IP（仅在 signIn 触发的请求上下文中可用）
          let clientIp: string | null = null;
          try {
            const { headers } = await import('next/headers');
            const h = await headers();
            clientIp =
              h.get('x-forwarded-for')?.split(',')[0]?.trim() ||
              h.get('x-real-ip') ||
              h.get('cf-connecting-ip') ||
              null;
          } catch {
            // headers() 在某些上下文不可用，不影响其他守卫
          }

          if (isDisposableEmail(user.email)) {
            await recordSignupAttempt(clientIp, false);
            await markDenial('disposable_email', {
              email: user.email,
              ip: clientIp,
              provider: account.provider,
            });
            return false;
          }

          const normalized = normalizeEmail(user.email);

          // 1) 优先看 grace 期内的墓碑用户 → 复活（user.id 保持不变，所有
          //    业务数据原路恢复，新 OAuth account 由 adapter 后续 linkAccount）
          const tombstoned = await findTombstonedUserByNormalizedEmail(db, normalized);
          if (tombstoned) {
            await reactivateUser(db, tombstoned.id, normalized);
            console.warn(`[auth] reactivated tombstoned user via OAuth (new provider): ${tombstoned.id}`);
            await recordSignupAttempt(clientIp, true);
            return true;
          }

          // 2) 同 normalized email 的活用户：允许 adapter linkAccount
          //    （getUserByEmail 在 adapter 里已 fallback 到 emailNormalized）
          const dup = await db.query.users.findFirst({
            where: (u, { eq }) => eq(u.emailNormalized, normalized),
            columns: { id: true },
          });
          if (dup) {
            await recordSignupAttempt(clientIp, true);
            return true;
          }

          const allowed = await checkSignupRateLimit(clientIp);
          if (!allowed) {
            await recordSignupAttempt(clientIp, false);
            await markDenial('signup_rate_limit', {
              email: user.email,
              ip: clientIp,
              provider: account.provider,
            });
            return false;
          }

          // 通过所有守卫；signIn 返回 true 后由 createUser event 记录成功
          await recordSignupAttempt(clientIp, true);
        }
      }

      return true;
    },
  },

  // Events
  events: {
    async createUser({ user }) {
      // SaaS-only：trial 期限、欢迎邮件、risk-tier policy 这一整套都是
      // SaaS 计费模型派生的。On-prem 客户用 enterprise license 决定
      // 权限，新用户由 admin 邀请进入；无 trial 概念。
      if (!IS_SAAS) {
        return;
      }

      const db = getDb();

      // 读 adapter 已经计算好的 riskTier，按 policy 给 trial 天数
      // tier ≥ 2 直接 free 计划（无 trial），阻止"注册→自删→重注"白嫖循环
      const row = await db.query.users.findFirst({
        where: eq(users.id, user.id!),
        columns: { riskTier: true },
      });
      const { policyForTier } = await import('@/lib/risk-tier');
      // 默认 trusted（schema default = 0）
      const tier = (row?.riskTier ?? 0) as 0 | 1 | 2 | 3 | 4;
      const policy = policyForTier(tier);

      const envTrialDays = parseInt(process.env.NEXT_PUBLIC_TRIAL_DAYS || '14', 10);
      // policy.trialDays 与 env 取较小值（env 是产品调节，policy 是风控护栏）
      const trialDays = Math.min(envTrialDays, policy.trialDays);

      if (trialDays > 0) {
        const trialEndsAt = new Date();
        trialEndsAt.setDate(trialEndsAt.getDate() + trialDays);
        await db.update(users)
          .set({
            plan: 'trial',
            trialStartedAt: new Date(),
            trialEndsAt,
          })
          .where(eq(users.id, user.id!));
      } else {
        // 无 trial，保持 schema 默认 plan=free
        console.warn(`[auth.createUser] user ${user.id} starts on free plan (riskTier=${tier})`);
      }

      // Send welcome email
      if (user.email && user.name) {
        await sendWelcomeEmail(user.email, user.name);
      }
    },
  },

  trustHost: true,

  // Auth.js v5 strictly reads process.env.AUTH_SECRET; the CF Worker
  // secret is named NEXTAUTH_SECRET (legacy v4 name). Pass it through
  // explicitly so v5 picks up either name. Same for AUTH_URL.
  secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET,
};

// 导出 auth 函数和 handlers
export const { handlers, auth, signIn, signOut } = NextAuth(config);

// 兼容性导出 - getSession 现在使用 auth()
export async function getSession() {
  return auth();
}

// Helper to get current user
export async function getCurrentUser() {
  const session = await auth();
  if (!session?.user?.id) {
    return null;
  }

  const db = getDb();
  const user = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
    with: {
      teamMembers: {
        with: {
          team: true,
        },
      },
    },
  });

  return user;
}

// Helper to require authentication
export async function requireAuth() {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error('Unauthorized');
  }
  return user;
}

// 类型扩展定义在 src/types/next-auth.d.ts
