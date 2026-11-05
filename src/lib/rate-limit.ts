/**
 * API 速率限制服务
 *
 * 使用滑动窗口算法进行速率限制，防止 API 滥用。
 * 使用内存存储 + 惰性清理，兼容 Cloudflare Workers（无 setInterval）。
 */

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

interface RateLimitEntry {
  timestamps: number[];
  lockedUntil?: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

let lastCleanup = Date.now();
const CLEANUP_INTERVAL_MS = 60_000;

function lazyCleanup() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.timestamps.length === 0 && (!entry.lockedUntil || entry.lockedUntil < now)) {
      rateLimitStore.delete(key);
    }
  }
}

export const RateLimitPresets = {
  LOGIN: { windowMs: 60_000, maxRequests: 5 },
  SIGNUP: { windowMs: 3_600_000, maxRequests: 10 },
  PASSWORD_RESET: { windowMs: 3_600_000, maxRequests: 3 },
  // 找回密码按账号再限一层（#696 / #714）：别名 / 点号 / 换 IP 都绕不开。同一账号 5 分钟内只发 1 封
  // （短窗去重，不会把受害者锁在门外），每天 50 封只作防轰炸兜底。
  PASSWORD_RESET_ACCOUNT_DEDUP: { windowMs: 300_000, maxRequests: 1 },
  PASSWORD_RESET_ACCOUNT_DAILY: { windowMs: 86_400_000, maxRequests: 50 },
  API: { windowMs: 60_000, maxRequests: 60 },
  API_RELAXED: { windowMs: 60_000, maxRequests: 120 },
  EVALUATE_SOURCE: { windowMs: 60_000, maxRequests: 20 },
  // Lexicon bulk imports: 5 sync-or-async uploads per hour per user. The cap
  // is meant to deter mass spam (10k rows × 5 = 50k links/h ≈ plan ceiling)
  // without throttling a power user iterating on one file.
  LEXICON_BULK: { windowMs: 3_600_000, maxRequests: 5 },
  // 落地页试点申请：同一 IP 每小时 5 次足够真人重填 / 同事共用出口，脚本灌表会被挡住。
  PILOT_APPLICATION: { windowMs: 3_600_000, maxRequests: 5 },
} as const;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfterSeconds?: number;
  locked?: boolean;
}

export function checkRateLimit(
  identifier: string,
  config: RateLimitConfig = RateLimitPresets.API
): RateLimitResult {
  lazyCleanup();

  const now = Date.now();
  const windowStart = now - config.windowMs;

  let entry = rateLimitStore.get(identifier);

  if (!entry) {
    entry = { timestamps: [] };
    rateLimitStore.set(identifier, entry);
  }

  if (entry.lockedUntil && entry.lockedUntil > now) {
    const retryAfterSeconds = Math.ceil((entry.lockedUntil - now) / 1000);
    return {
      allowed: false,
      remaining: 0,
      resetAt: entry.lockedUntil,
      retryAfterSeconds,
      locked: true,
    };
  }

  entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);

  if (entry.timestamps.length >= config.maxRequests) {
    const oldestTimestamp = entry.timestamps[0];
    const resetAt = oldestTimestamp + config.windowMs;
    const retryAfterSeconds = Math.ceil((resetAt - now) / 1000);

    return {
      allowed: false,
      remaining: 0,
      resetAt,
      retryAfterSeconds,
    };
  }

  entry.timestamps.push(now);

  const remaining = config.maxRequests - entry.timestamps.length;
  const resetAt = entry.timestamps[0] + config.windowMs;

  return {
    allowed: true,
    remaining,
    resetAt,
  };
}

export function lockIdentifier(identifier: string, lockDurationMs: number): void {
  let entry = rateLimitStore.get(identifier);

  if (!entry) {
    entry = { timestamps: [] };
    rateLimitStore.set(identifier, entry);
  }

  entry.lockedUntil = Date.now() + lockDurationMs;
}

export function unlockIdentifier(identifier: string): void {
  const entry = rateLimitStore.get(identifier);
  if (entry) {
    entry.lockedUntil = undefined;
  }
}

export function resetRateLimit(identifier: string): void {
  rateLimitStore.delete(identifier);
}

export function getClientIp(request: Request): string {
  const cfConnectingIp = request.headers.get('cf-connecting-ip');
  if (cfConnectingIp) return cfConnectingIp;

  const xForwardedFor = request.headers.get('x-forwarded-for');
  if (xForwardedFor) {
    const ips = xForwardedFor.split(',').map((ip) => ip.trim());
    return ips[0];
  }

  const xRealIp = request.headers.get('x-real-ip');
  if (xRealIp) return xRealIp;

  return 'unknown';
}

export function getRateLimitHeaders(result: RateLimitResult, config: RateLimitConfig): HeadersInit {
  return {
    'X-RateLimit-Limit': config.maxRequests.toString(),
    'X-RateLimit-Remaining': result.remaining.toString(),
    'X-RateLimit-Reset': Math.ceil(result.resetAt / 1000).toString(),
    ...(result.retryAfterSeconds ? { 'Retry-After': result.retryAfterSeconds.toString() } : {}),
  };
}
