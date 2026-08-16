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

import { CredentialsSignin } from 'next-auth';

import type { VerifyResult } from '@/lib/two-factor';

/**
 * 带 `code` 的登录错误——**这是把信息传给前端的唯一可靠通道**。
 *
 * <h2>踩过的坑（生产事故，必须留档）</h2>
 *
 * 初版直接 `throw new Error('TWO_FACTOR_REQUIRED')`，前端比较
 * `result.error === 'TWO_FACTOR_REQUIRED'`。**这个分支永远不成立**：
 * Auth.js v5 把 `authorize()` 抛出的任何错误都归一化成 `CredentialsSignin`，
 * 只把它的**类型名**写进重定向 URL 的 `error` 查询参数；原始 message
 * 只留在服务端日志里（`next-auth/react.js:174` 读的就是那个 query param）。
 *
 * 后果：密码正确的用户拿到 `error='CredentialsSignin'`，前端匹配不上，
 * 落到「邮箱或密码错误」的兜底文案，**第二屏永远出不来**——
 * 即密码登录整体不可用。线上实测：服务端日志明确显示
 * `Error: TWO_FACTOR_REQUIRED`，而用户看到的是「Invalid email or password」。
 *
 * <h2>为什么用 code</h2>
 *
 * `CredentialsSignin.code` 是 Auth.js **官方支持**的透传字段，会被写进重定向
 * URL 的 `code` 查询参数；`signIn()` 同时读取 `error` 与 `code` 并一起返回
 * （见 `next-auth/react.js`）。故前端必须比较 `result.code`，不是 `result.error`。
 *
 * ⚠ 该值会出现在 URL 里，**不得包含敏感信息**。这里的取值都是流程状态
 * （REQUIRED / MISMATCH / EXPIRED …），不泄露账号是否存在——因为它们只在
 * **密码已验证通过之后**才可能被抛出。
 */
export class TwoFactorSignin extends CredentialsSignin {
  constructor(public readonly reason: string) {
    // ★message 与 code 保持同一个带前缀的值：message 是给**服务端日志**看的
    //   （线上排查全靠它），code 是给**前端**看的。两者一致，排查时
    //   日志里看到什么，前端收到的就是什么，不用心算换算。
    super(`TWO_FACTOR_${reason}`);
    this.code = `TWO_FACTOR_${reason}`;
  }
}

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
  /** 该用户是否已启用 TOTP —— 决定走 App 码还是邮件码。 */
  hasTotpEnabled: (userId: string) => Promise<boolean>;
  /** 校验 TOTP 码或恢复码。 */
  verifyTotp: (
    userId: string,
    token: string,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
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
      throw new TwoFactorSignin('RATE_LIMITED');
    }
  } catch (err) {
    // ★限流器自身故障时**放行**而非拒绝：限流是防滥用而非鉴权，
    //   让它成为登录的单点故障会把一次 KV 抖动变成全站登录中断。
    //   但 RATE_LIMITED 必须原样抛出，不能被这个 catch 吞掉。
    // ★按**类型**而非 message 判定：message 是给日志看的，将来改文案
    //   就会悄悄让限流被这个 catch 吞掉（fail-open 到无限次尝试）。
    if (err instanceof TwoFactorSignin) throw err;
    console.error('[auth] 限流检查失败，放行:', err);
  }

  // 检查账户锁定状态
  const lockoutStatus = await deps.checkAccountLockout(email);
  if (lockoutStatus.locked) {
    console.warn(`[Auth] 账户被锁定: ${email}, 解锁时间: ${lockoutStatus.lockedUntil}`);
    throw new TwoFactorSignin('ACCOUNT_LOCKED');
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
      throw new TwoFactorSignin('ACCOUNT_LOCKED');
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

  // ── TOTP（验证器 App）分支 ─────────────────────────────────────────
  //
  // ★已绑定验证器的用户**完全不走邮件**：不发信、也不接受邮件码。
  //   理由是安全边界——留着邮件作后备，等于把整体强度降回"控制邮箱即可登录"，
  //   而 TOTP 的全部价值就在于不依赖邮箱。代价是手机丢失且没抄恢复码的人
  //   只能联系人工，这是刻意选择的取舍（恢复码就是为此存在）。
  //
  // ★必须在邮件分支**之前**判断：否则第一屏会先发一封没人需要的信。
  if (await deps.hasTotpEnabled(user.id)) {
    if (!submittedCode) {
      // 第二屏：要 App 上的码（或恢复码）。不发任何邮件。
      throw new TwoFactorSignin('TOTP_REQUIRED');
    }
    const totpVerdict = await deps.verifyTotp(user.id, submittedCode);
    if (!totpVerdict.ok) {
      console.warn(`[auth] TOTP reject: userId=${user.id} reason=${totpVerdict.reason}`);
      // ★与邮件码同理：TOTP 错**不**计入账户锁定，否则知道邮箱的人
      //   就能用错误的 TOTP 码把受害者锁死。
      throw new TwoFactorSignin(`TOTP_${totpVerdict.reason}`);
    }
    await deps.resetFailedAttempts(email);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
    };
  }

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
        throw new TwoFactorSignin('WINDOW_EXCEEDED');
      }
      pendingCode = issued.code;
    }

    if (pendingCode) {
      try {
        await deps.sendCodeEmail(email, pendingCode);
      } catch (err) {
        // 发信失败必须让用户看见：静默失败会让他卡在验证码界面永远等不到信。
        console.error('[auth] 2FA code dispatch failed:', err);
        throw new TwoFactorSignin('SEND_FAILED');
      }
    }
    throw new TwoFactorSignin('REQUIRED');
  }

  const verdict = await deps.verifyCode(email, submittedCode);
  if (!verdict.ok) {
    // ★验证码错**不**计入账户锁定：那条轴锁的是"密码错太多次"。
    //   合并会让攻击者用错误验证码把受害者账户锁死（拒绝服务）——
    //   他只需要知道邮箱，而邮箱不是秘密。
    //   验证码自己的限次在 verifyCode 内部（MAX_ATTEMPTS）。
    console.warn(`[auth] 2FA reject: email=${email} reason=${verdict.reason}`);
    throw new TwoFactorSignin(verdict.reason);
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
