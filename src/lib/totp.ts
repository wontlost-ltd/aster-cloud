/**
 * TOTP（验证器 App）第二因子 —— issue #400 第二步。
 *
 * <h2>与邮件验证码的分工</h2>
 *
 * 两者**并存而非替代**：已绑定 TOTP 的用户走 TOTP（不发信），未绑定的走邮件码。
 * 这样既不强迫所有人装 App，也让愿意用 App 的人摆脱邮件送达的不确定性
 * （送达延迟、进垃圾箱、域名被拒——本功能上线首日就踩过最后一条）。
 *
 * <h2>三条安全约束</h2>
 *
 * 1. **secret 可逆加密，不是 hash** —— 验证时必须还原 secret 现场算码。
 *    这与 `two-factor.ts` 存 sha256 是相反的取舍，因为需求不同：
 *    邮件码是"我们发出去的值，比对即可"，TOTP 是"用共享密钥各自算"。
 *    用 pgcrypto `pgp_sym_encrypt`，沿用 BYOK 已有的密钥与写法。
 *
 * 2. **必须先确认再启用** —— 生成 secret 只是候选（`confirmedAt IS NULL`）；
 *    用户用 App 输入一次正确的码，才算真的扫上了。少这一步，
 *    二维码没扫上的人会被永久锁在门外。
 *
 * 3. **防重放** —— TOTP 码在 30 秒窗口内恒定，用过的窗口必须记下来。
 *    否则肩窥/中间人拿到一次码后可在窗口剩余时间里重复使用。
 *
 * <h2>为什么 otplib 能在 Workers 跑</h2>
 *
 * otplib 13.x 用 `@noble/hashes`（纯 JS），不依赖 `node:crypto`——
 * 已核对其依赖树。若将来换库，必须重新确认这一点：Workers 没有 Node crypto 内部实现。
 */

import { createHash, randomBytes } from 'node:crypto';

import { generateSecret as otpGenerateSecret, generateURI, verify as otpVerify } from 'otplib';
import { eq, and, isNull, sql } from 'drizzle-orm';

import { db } from '@/lib/prisma';
import { totpCredentials, totpRecoveryCodes } from '@/db/schema';

/**
 * 允许的时间漂移容忍（**秒**，前后各 30 秒 = 各一个时间窗）。
 *
 * ★otplib 13 的 `epochTolerance` 单位是秒，不是窗口数——v12 的 `window: 1`
 * 换算过来是 30。写成 1 只会容忍 1 秒，手机差几秒就登不上。
 */
const TOTP_TOLERANCE_SECONDS = 30;

/** 恢复码数量。 */
export const RECOVERY_CODE_COUNT = 10;

/**
 * 加密密钥。★在函数体内读 env，不在模块顶层。
 *
 * OpenNext 逐请求才把绑定拷进 `process.env`；模块顶层求值会在冷启动时
 * 拿到空值并**永久固化**——这正是 RESEND_FROM_EMAIL 那次线上故障的根因。
 */
function encryptionSecret(): string {
  const s = process.env.AI_KEY_ENCRYPTION_SECRET;
  if (!s || s.length < 16) {
    const err = new Error(
      'AI_KEY_ENCRYPTION_SECRET is not set on the Worker (or < 16 chars).',
    );
    (err as Error & { code?: string }).code = 'ENCRYPTION_SECRET_MISSING';
    throw err;
  }
  return s;
}

/** sha256 小写 hex —— 恢复码的存储形态。 */
export function hashRecoveryCode(raw: string): string {
  return createHash('sha256').update(raw.trim().toUpperCase(), 'utf8').digest('hex');
}

/** 生成一个 base32 TOTP secret。 */
export function generateSecret(): string {
  return otpGenerateSecret();
}

/**
 * 生成恢复码。格式 `XXXX-XXXX`，只用不易混淆的字符集
 * （去掉 0/O/1/I/L），因为用户往往是**手抄**下来的。
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(8);
    let s = '';
    for (let j = 0; j < 8; j++) s += ALPHABET[bytes[j] % ALPHABET.length];
    out.push(`${s.slice(0, 4)}-${s.slice(4)}`);
  }
  return out;
}

/**
 * 构造 `otpauth://` URI —— 验证器 App 扫的二维码内容。
 *
 * <p>★label 用邮箱、issuer 用产品名：用户手机里可能有几十个条目，
 * 只写 issuer 会导致多账号无法区分。
 */
export function buildOtpAuthUri(email: string, secret: string): string {
  return generateURI({ issuer: 'Aster Cloud', label: email, secret });
}

/**
 * 校验一个 TOTP 码（不查库，纯算法）。
 *
 * <p>★otplib 13 的 verify 是 **async** 且返回 `{ valid, delta, timeStep }` 对象，
 * 不是布尔——直接 `if (verify(...))` 会永远为真（对象恒真值）。
 *
 * <p>★**必须把 `timeStep` 一起返回**（独立审查发现的高危缺陷）：
 * 它是「这个码实际匹配的时间窗」，而不是「现在是第几个窗」。
 * 二者因 `epochTolerance` 而不同——容忍前后各一个窗口，意味着
 * 窗口 N 的码在 N+1 仍然有效。若防重放拿**当前墙钟窗口**做比较，
 * 攻击者只要等进入下一个窗口再提交同一个码，`N < N+1` 就成立，
 * CAS 形同虚设。实测：同一个码在 N+1 / N+2 / N+3 **连续三次登录成功**。
 */
export async function verifyToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): Promise<{ valid: false } | { valid: true; timeStep: number }> {
  try {
    const res = await otpVerify({
      token: token.trim(),
      secret,
      // ★必须显式传 epoch：不传则 otplib 用**真实系统时钟**，
      //   与调用方注入的 `now` 脱节——`delta` 就变成相对真实时间的偏移，
      //   而 `currentCounter(now)` 是相对注入时间的，两者相加毫无意义。
      //   实测：不传 epoch 时跨窗重放依然通过，且测试无法注入时间。
      epoch: Math.floor(now.getTime() / 1000),
      epochTolerance: TOTP_TOLERANCE_SECONDS,
    });
    if (res.valid !== true) return { valid: false };
    // ★用 `delta` 把「当前窗口」换算成**这个码实际匹配的窗口**。
    //   delta 是命中窗口相对当前窗口的偏移（-1 / 0 / +1）——必须加上它，
    //   否则记下的仍是"现在是第几个窗"，而不是"这个码属于哪个窗"，
    //   跨窗重放就拦不住（实测同码可连中三次）。
    //
    //   运行时另有 `timeStep` 字段可直接用，但它只声明在联合类型的 HOTP
    //   分支上，TOTP 分支没有——绕过类型去读未声明字段等于赌库的内部实现。
    //   `delta` 是两个分支的公共字段，有类型保证。
    return { valid: true, timeStep: currentCounter(now) + res.delta };
  } catch {
    // 非法 secret / 非数字 token 一律当作不通过，不向上抛。
    return { valid: false };
  }
}

/** 当前时间窗计数器 —— 用于防重放。 */
export function currentCounter(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000 / 30);
}

/**
 * 为用户生成（或重置）一个**未确认**的 TOTP 候选绑定，返回明文 secret 与 URI。
 *
 * <p>★重复调用会覆盖既有的未确认候选——用户反复点"重新生成"是常见操作。
 * 但**已确认**的绑定不会被悄悄顶掉：调用方须先要求验证身份再重置。
 */
export async function startEnrollment(
  userId: string,
  email: string,
): Promise<{ secret: string; otpauthUri: string }> {
  const secret = generateSecret();
  const key = encryptionSecret();

  await db.execute(sql`
    INSERT INTO "TotpCredential" ("id", "userId", "encryptedSecret", "confirmedAt", "createdAt")
    VALUES (
      ${crypto.randomUUID()}, ${userId},
      pgp_sym_encrypt(${secret}::text, ${key}::text)::text,
      NULL, now()
    )
    ON CONFLICT ("userId") DO UPDATE SET
      "encryptedSecret" = pgp_sym_encrypt(${secret}::text, ${key}::text)::text,
      "confirmedAt" = NULL,
      "lastUsedCounter" = NULL
    WHERE "TotpCredential"."confirmedAt" IS NULL
  `);

  // ★WHERE 把「不得顶掉已确认绑定」焊进 SQL（独立审查发现的 Medium）。
  //   原来无条件 DO UPDATE 会把已启用账户的 confirmedAt 置 NULL——
  //   等于**静默关闭第二因子**，与本函数注释声称的不变量矛盾。
  //   路由层虽有 hasTotpEnabled 的 409 门禁（审查者 30 轮并发未能绕过），
  //   但保护不该只依赖调用方：多一个调用方就多一次踩雷机会。
  //
  // ★同时清掉旧恢复码：重新绑定后旧码必须失效，否则它们会在新 secret 下
  //   继续可用（纵深防御，同为审查发现）。
  await db.delete(totpRecoveryCodes).where(eq(totpRecoveryCodes.userId, userId));

  return { secret, otpauthUri: buildOtpAuthUri(email, secret) };
}

/** 读出解密后的 secret；无绑定返回 null。 */
async function decryptSecret(userId: string): Promise<string | null> {
  const key = encryptionSecret();
  try {
    const rows = (await db.execute(sql`
      SELECT pgp_sym_decrypt("encryptedSecret"::bytea, ${key}::text) AS secret
      FROM "TotpCredential" WHERE "userId" = ${userId} LIMIT 1
    `)) as unknown as Array<{ secret: string }>;
    return rows[0]?.secret ?? null;
  } catch (_err) {
    // ★_err **刻意不使用**：它带着完整 SQL 与绑定参数（含主加密密钥）。
    // ★必须吞掉原始错误（独立审查发现的 High）。
    //   DrizzleQueryError 的 message 里带着**完整 SQL 与全部绑定参数**——
    //   其中就有主加密密钥。上游任何 `console.error('...', err)` 都会把它
    //   写进 Worker 日志；而这把密钥同时保护着全部 BYOK API key 与
    //   全部 TOTP secret，泄露一次等于全部沦陷。
    //   实测确认：解密失败时错误体内可见明文密钥。
    //   故只记录**不含参数**的分类信息，向上返回 null（等价于"验不过"）。
    console.error('[totp] secret decrypt failed for user', userId);
    return null;
  }
}

export type ConfirmResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; reason: 'NO_PENDING' | 'MISMATCH' };

/**
 * 确认绑定：用户输入 App 上的码，正确才真正启用，并返回一次性恢复码。
 *
 * <p>★恢复码**只在这一刻明文返回一次**，之后只存 hash。
 * 用户没抄下来就只能重置绑定——这是有意的，不留"再看一次"的后门。
 */
export async function confirmEnrollment(
  userId: string,
  token: string,
  now: Date = new Date(),
): Promise<ConfirmResult> {
  const pending = await db.query.totpCredentials.findFirst({
    where: and(eq(totpCredentials.userId, userId), isNull(totpCredentials.confirmedAt)),
  });
  if (!pending) return { ok: false, reason: 'NO_PENDING' };

  const secret = await decryptSecret(userId);
  if (!secret) return { ok: false, reason: 'MISMATCH' };
  const verdict = await verifyToken(token, secret, now);
  if (!verdict.valid) return { ok: false, reason: 'MISMATCH' };

  // ★**原子占用**再生成恢复码（独立审查发现的 High）。
  //   上面那次 findFirst 只是预检：并发下 5 个请求会全部读到同一个 pending 行，
  //   各自走完全程，最终发出 **5 套各 10 个**恢复码、表里留下 50 行全部有效。
  //   实测确认（5 并发 → 成功 5 次、50 行）。
  //   受害者只知道自己保存的那 10 个，攻击者手里另外 40 个是**永久有效的后门**。
  //   故把「谁能确认」下沉成单条带条件的 UPDATE：只有 returning 非空的那一次
  //   才继续发码。
  //
  //   lastUsedCounter 记的是**确认时用掉的那个窗口**（verdict.timeStep），
  //   不是当前墙钟窗口：写 currentCounter(now) 会让用户绑定后
  //   **第一次登录必被判 REPLAY**——他看着 App 上那个还没跳变的码去登录，
  //   窗口号相等，`<` 不成立。用户会以为自己手滑，实际是系统逻辑错误。
  const codes = generateRecoveryCodes();

  // ★整段放进事务（独立审查发现的 High）。
  //   原本 update / delete / insert 是三条独立语句：中途失败会留下
  //   「confirmedAt 已置、恢复码 0 个」的状态——2FA 已开启却无任何救援手段，
  //   手机一丢就永久失联。实测模拟 insert 抛错即复现该中间态。
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .update(totpCredentials)
      .set({ confirmedAt: now, lastUsedCounter: verdict.timeStep })
      .where(
        and(eq(totpCredentials.userId, userId), isNull(totpCredentials.confirmedAt)),
      )
      .returning({ id: totpCredentials.id });
    if (rows.length === 0) return false;

    // 重置恢复码：重新绑定必须让旧恢复码全部失效。
    await tx.delete(totpRecoveryCodes).where(eq(totpRecoveryCodes.userId, userId));
    await tx.insert(totpRecoveryCodes).values(
      codes.map((c) => ({
        id: crypto.randomUUID(),
        userId,
        codeHash: hashRecoveryCode(c),
        createdAt: now,
      })),
    );
    return true;
  });

  if (!claimed) return { ok: false, reason: 'NO_PENDING' };

  return { ok: true, recoveryCodes: codes };
}

/** 用户是否已启用 TOTP（仅**已确认**的算数）。 */
export async function hasTotpEnabled(userId: string): Promise<boolean> {
  const row = await db.query.totpCredentials.findFirst({
    where: eq(totpCredentials.userId, userId),
  });
  return !!row?.confirmedAt;
}

export type TotpVerifyResult =
  | { ok: true; usedRecoveryCode: boolean }
  | { ok: false; reason: 'NOT_ENABLED' | 'MISMATCH' | 'REPLAY' };

/**
 * 登录时校验 TOTP 码或恢复码。
 *
 * <p>★防重放：记录已用过的时间窗计数器，同一窗口的码只接受一次。
 * TOTP 码在 30 秒内恒定，不做这个记录，偷看到一次就能在剩余时间里重复用。
 */
export async function verifyTotpForLogin(
  userId: string,
  token: string,
  now: Date = new Date(),
): Promise<TotpVerifyResult> {
  const row = await db.query.totpCredentials.findFirst({
    where: eq(totpCredentials.userId, userId),
  });
  if (!row?.confirmedAt) return { ok: false, reason: 'NOT_ENABLED' };

  const cleaned = token.trim().toUpperCase();

  // 先试恢复码（形如 XXXX-XXXX，与 6 位数字码不会混淆）。
  if (cleaned.includes('-')) {
    const hash = hashRecoveryCode(cleaned);
    // ★原子消费：把 usedAt 置为非空**且**要求它此前为空，
    //   并发提交同一个恢复码时只有一条 UPDATE 命中。
    const consumed = await db
      .update(totpRecoveryCodes)
      .set({ usedAt: now })
      .where(
        and(
          eq(totpRecoveryCodes.userId, userId),
          eq(totpRecoveryCodes.codeHash, hash),
          isNull(totpRecoveryCodes.usedAt),
        ),
      )
      .returning({ id: totpRecoveryCodes.id });
    if (consumed.length === 0) return { ok: false, reason: 'MISMATCH' };
    return { ok: true, usedRecoveryCode: true };
  }

  const secret = await decryptSecret(userId);
  if (!secret) return { ok: false, reason: 'MISMATCH' };
  const verdict = await verifyToken(cleaned, secret, now);
  if (!verdict.valid) return { ok: false, reason: 'MISMATCH' };

  // ★用**这个码实际匹配的时间窗**（verdict.timeStep），而不是当前墙钟窗口。
  //   容忍窗口让窗口 N 的码在 N+1 依然有效；若拿当前窗口比较，
  //   攻击者等一个窗口再重放就必然通过（实测同码连中三次）。
  //   记下 timeStep 后，同一个码无论何时再来，其 timeStep 恒定，
  //   `<=` 条件即可拒绝。
  const claimed = await db
    .update(totpCredentials)
    .set({ lastUsedCounter: verdict.timeStep })
    .where(
      and(
        eq(totpCredentials.userId, userId),
        sql`("lastUsedCounter" IS NULL OR "lastUsedCounter" < ${verdict.timeStep})`,
      ),
    )
    .returning({ id: totpCredentials.id });
  if (claimed.length === 0) return { ok: false, reason: 'REPLAY' };

  return { ok: true, usedRecoveryCode: false };
}

/** 解绑 TOTP（含恢复码）。调用方必须先验证身份。 */
export async function disableTotp(userId: string): Promise<void> {
  await db.delete(totpRecoveryCodes).where(eq(totpRecoveryCodes.userId, userId));
  await db.delete(totpCredentials).where(eq(totpCredentials.userId, userId));
}

/** 剩余未使用的恢复码数量 —— 设置页展示用。 */
export async function countUnusedRecoveryCodes(userId: string): Promise<number> {
  const rows = await db
    .select({ id: totpRecoveryCodes.id })
    .from(totpRecoveryCodes)
    .where(and(eq(totpRecoveryCodes.userId, userId), isNull(totpRecoveryCodes.usedAt)));
  return rows.length;
}
