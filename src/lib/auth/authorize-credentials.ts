/**
 * Credentials 登录的编排逻辑（issue #400）——从 `auth.ts` 的内联 `authorize()` 抽出。
 *
 * <h2>★为什么必须抽出来</h2>
 *
 * 独立审查（假绿猎手）实测：把 `if (!verdict.ok)` 改成 `if (false && !verdict.ok)`
 * ——即**二次验证结果被完全丢弃、整个功能下线**——32 条测试全绿。
 * 同样，`rememberDevice=true` 绕过 2FA、新加的限流变成空操作，也都无人报红。
 *
 * 根因不是"测试写得不细"，而是**结构上不可测**：`authorize` 是 NextAuth 配置
 * 对象里的内联闭包，没有任何测试能调用它。三份测试只能止步于 `lib/*.ts` 的纯函数，
 * 加上对 `auth.ts` 的**源码文本**断言——而文本断言对"标记全在、行为全没了"
 * 这类变异完全无能。
 *
 * 抽成可注入依赖的纯函数后，编排层的行为才第一次可被断言。
 *
 * <h2>本次抽取是「搬移」不是「重写」</h2>
 *
 * 函数体逐行来自原 `authorize()`，只把直接调用替换为 `deps.*`。
 */

import type { VerifyResult } from '@/lib/two-factor';

/** authorize 返回的用户形状（NextAuth User 的子集）。 */
export interface AuthorizedUser {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
}

type UserRow = {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
  passwordHash: string | null;
};

/** 编排所需的全部外部能力。★全部可注入 = 全部可断言。 */
export interface AuthorizeDeps {
  ensureSchema: () => Promise<void>;
  checkRateLimit: (key: string) => Promise<{ allowed: boolean }>;
  checkAccountLockout: (email: string) => Promise<{ locked: boolean; lockedUntil?: Date | null }>;
  recordFailedAttempt: (email: string) => Promise<{ nowLocked: boolean }>;
  resetFailedAttempts: (email: string) => Promise<void>;
  verifyPassword: (plain: string, hash: string) => Promise<boolean>;
  findUserByEmail: (email: string) => Promise<UserRow | undefined>;
  isTrustedDevice: (userId: string, token: string) => Promise<boolean>;
  hasActiveCode: (email: string) => Promise<boolean>;
  issueCode: (email: string) => Promise<{ ok: true; code: string } | { ok: false; reason: string }>;
  sendCodeEmail: (email: string, code: string) => Promise<void>;
  verifyCode: (email: string, code: string) => Promise<VerifyResult>;
}

export interface AuthorizeCredentials {
  email?: unknown;
  password?: unknown;
  twoFactorCode?: unknown;
  trustedDeviceToken?: unknown;
  rememberDevice?: unknown;
}

export async function authorizeCredentials(
  credentials: AuthorizeCredentials | undefined,
  deps: AuthorizeDeps,
): Promise<AuthorizedUser | null> {
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
    await deps.ensureSchema();
    // Block on the admin seed too — otherwise the very first
    // login attempt races the in-flight insert and the user
    // lookup below sees no row.
    
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
    const rl = await deps.checkRateLimit(`authorize:${email}`);
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
  const lockoutStatus = await deps.checkAccountLockout(email);
  if (lockoutStatus.locked) {
    console.warn(`[Auth] 账户被锁定: ${email}, 解锁时间: ${lockoutStatus.lockedUntil}`);
    throw new Error('ACCOUNT_LOCKED');
  }

  // Find user with password hash
  const user = await deps.findUserByEmail(email);

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
    await deps.recordFailedAttempt(email);
    return null;
  }

  // Verify password
  const isValidPassword = await deps.verifyPassword(
    credentials.password as string,
    user.passwordHash
  );

  if (!isValidPassword) {
    console.warn(
      `[auth] credentials reject: email=${email} reason=invalid-password`,
    );
    const failedResult = await deps.recordFailedAttempt(email);
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
    if (await deps.isTrustedDevice(user.id, trustToken)) {
      await deps.resetFailedAttempts(email);
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
    
    let pendingCode: string | null = null;
    if (!(await deps.hasActiveCode(email))) {
      const issued = await deps.issueCode(email);
      if (!issued.ok) {
        console.warn(`[auth] 2FA window exceeded: email=${email}`);
        throw new Error('TWO_FACTOR_WINDOW_EXCEEDED');
      }
      pendingCode = issued.code;
    }

    if (pendingCode) {
      try {
        await deps.sendCodeEmail(email, pendingCode);
      } catch (err) {
        // 发信失败必须让用户看见：静默失败会让他卡在验证码界面永远等不到信。
        console.error('[auth] 2FA code dispatch failed:', err);
        throw new Error('TWO_FACTOR_SEND_FAILED');
      }
    }
    throw new Error('TWO_FACTOR_REQUIRED');
  }

  const verdict = await deps.verifyCode(email, submittedCode);
  if (!verdict.ok) {
    // ★验证码错**不**计入账户锁定：那条轴锁的是"密码错太多次"。
    //   合并会让攻击者用错误验证码把受害者账户锁死（拒绝服务）——
    //   他只需要知道邮箱，而邮箱不是秘密。
    //   验证码自己的限次在 verifyCode 内部（MAX_ATTEMPTS）。
    console.warn(`[auth] 2FA reject: email=${email} reason=${verdict.reason}`);
    throw new Error(`TWO_FACTOR_${verdict.reason}`);
  }

  // 登录成功，重置失败计数
  await deps.resetFailedAttempts(email);

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
  };
}
