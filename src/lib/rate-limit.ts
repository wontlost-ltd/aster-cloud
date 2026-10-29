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
  API: { windowMs: 60_000, maxRequests: 60 },
  API_RELAXED: { windowMs: 60_000, maxRequests: 120 },
  EVALUATE_SOURCE: { windowMs: 60_000, maxRequests: 20 },
  // Lexicon bulk imports: 5 sync-or-async uploads per hour per user. The cap
  // is meant to deter mass spam (10k rows × 5 = 50k links/h ≈ plan ceiling)
  // without throttling a power user iterating on one file.
  LEXICON_BULK: { windowMs: 3_600_000, maxRequests: 5 },
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
