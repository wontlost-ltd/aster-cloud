/**
 * LLM 代理错误响应 → 结构化拒绝原因。
 *
 * ★为什么需要：服务端已经给出了精确原因（`{error: 'ai_email_unverified', message: ...}`
 * 且 HTTP 状态码按原因分流：402 配额耗尽 / 429 限流 / 403 封禁或邮箱未验证），
 * 但 useSSEStream 此前把响应体**当作纯文本**拼进错误串：
 *
 *     setError(`HTTP ${response.status}: ${errorText}`)
 *
 * 于是用户看到的是一行原始 JSON——
 *     HTTP 403: {"error":"ai_email_unverified","message":"请先完成邮箱验证…"}
 * ——精确原因就在里面，却没被解析出来，用户只能去开浏览器控制台。
 *
 * ★另一个坑：服务端 message 是**硬编码中文**（src/lib/ai-quota.ts），
 * 直接透传给 en/de/hi 用户就是错误语言。故本模块只解析**原因码**，
 * 文案交给前端 i18n（ai.errorEmailUnverified 等），服务端 message 仅作兜底。
 */

/** 服务端 checkAiQuota 会给出的拒绝原因（src/lib/ai-quota.ts）。 */
export type LlmDenialReason =
  | 'ai_email_unverified'
  | 'ai_banned'
  | 'ai_quota_exhausted'
  | 'ai_rate_limited'
  | 'byok_unavailable'
  | 'cloud_misconfigured'
  | 'unauthorized'
  | 'unknown';

export interface LlmError {
  /** 结构化原因码，用于选 i18n 文案与决定是否展示行动入口。 */
  reason: LlmDenialReason;
  /** 服务端原始 message（可能是中文）。仅在前端无对应文案时兜底。 */
  serverMessage?: string;
  /** HTTP 状态码，保留用于日志/排查。 */
  status: number;
  /** 限流场景的建议重试秒数（来自 Retry-After 头）。 */
  retryAfterSec?: number;
}

/** 已知原因码集合——用于判定服务端返回的 error 字段是否是我们认识的。 */
const KNOWN: ReadonlySet<string> = new Set<LlmDenialReason>([
  'ai_email_unverified',
  'ai_banned',
  'ai_quota_exhausted',
  'ai_rate_limited',
  'byok_unavailable',
  'cloud_misconfigured',
]);

/**
 * 解析代理返回的错误响应体。
 *
 * @param status    HTTP 状态码
 * @param bodyText  响应体原文（可能是 JSON，也可能是上游透传的纯文本）
 * @param retryAfter `Retry-After` 头原值（可空）
 *
 * ★容错要求：body 可能**不是 JSON**——`llm-sse-proxy` 在上游非 2xx 时原样透传
 * 上游响应体（可能是 HTML 错误页或纯文本）。此时不能抛异常，要退化成
 * 按状态码推断，否则解析失败会把「有原因的拒绝」变成「未知错误」。
 */
export function parseLlmError(
  status: number,
  bodyText: string,
  retryAfter?: string | null,
): LlmError {
  const retryAfterSec = toRetryAfterSec(retryAfter);

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // 非 JSON（上游 HTML/纯文本）→ 只能按状态码推断
    return { reason: reasonFromStatus(status), status, retryAfterSec };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { reason: reasonFromStatus(status), status, retryAfterSec };
  }

  const obj = parsed as Record<string, unknown>;
  const rawReason = typeof obj.error === 'string' ? obj.error : undefined;
  const serverMessage = typeof obj.message === 'string' ? obj.message : undefined;

  // 'Unauthorized' 是 401 分支的字面量（非 snake_case），单独归一。
  if (rawReason === 'Unauthorized') {
    return { reason: 'unauthorized', serverMessage, status, retryAfterSec };
  }

  const reason: LlmDenialReason =
    rawReason && KNOWN.has(rawReason)
      ? (rawReason as LlmDenialReason)
      : reasonFromStatus(status);

  return { reason, serverMessage, status, retryAfterSec };
}

/**
 * 无法从响应体拿到原因码时，按状态码推断。
 * ★403 故意映射成 'unknown' 而不是猜 'ai_banned'——403 有三个来源
 * （封禁 / 邮箱未验证 / default 兜底），猜错会给用户**错误的行动指引**
 * （让已验证邮箱的被封用户去验邮箱）。宁可显示通用文案。
 */
function reasonFromStatus(status: number): LlmDenialReason {
  if (status === 401) return 'unauthorized';
  if (status === 402) return 'ai_quota_exhausted';
  if (status === 429) return 'ai_rate_limited';
  return 'unknown';
}

/** Retry-After 只接受非负整数秒；HTTP-date 形式与非法值一律忽略。 */
function toRetryAfterSec(v?: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * 原因码 → i18n key（`ai` 命名空间）。
 *
 * ★返回 null 而非兜底 key 的情形：`unknown`。403 有三个来源
 * （封禁 / 邮箱未验证 / default），拿不到原因码时**不猜**——
 * 猜错会给出错误的行动指引（让被封用户去验邮箱）。此时由调用方
 * 回落到服务端 message 或通用文案。
 */
export function denialMessageKey(reason: LlmDenialReason): string | null {
  switch (reason) {
    case 'ai_email_unverified':
      return 'errorEmailUnverified';
    case 'ai_banned':
      return 'errorBanned';
    case 'ai_quota_exhausted':
      return 'errorQuotaExhausted';
    case 'ai_rate_limited':
      return 'errorRateLimited';
    case 'byok_unavailable':
      return 'errorByokUnavailable';
    case 'cloud_misconfigured':
      return 'errorMisconfigured';
    case 'unauthorized':
      return 'errorUnauthorized';
    case 'unknown':
      return null;
  }
}

/**
 * 取本地化后的拒绝文案。
 * @param denial 结构化原因（可空——流内 error 事件没有它）
 * @param t      next-intl 的 `ai` 命名空间翻译函数
 */
export function denialMessage(
  denial: LlmError | null,
  t: (key: string) => string,
): string | null {
  if (!denial) return null;
  const key = denialMessageKey(denial.reason);
  return key ? t(key) : null;
}
