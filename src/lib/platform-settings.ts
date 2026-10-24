/*
 * Platform settings — generic admin-controlled key-value flags.
 *
 * Reads are cached per Worker isolate (60s TTL) so a feature gate
 * doesn't translate into a DB hit on every request. The cache is
 * intentionally short — a SaaS admin who flips a kill switch from
 * /admin should see it propagate within a minute, even though
 * individual isolates may serve stale-cached "OFF" for up to 60s.
 *
 * Writes go through setSetting() which invalidates the cache for
 * that key. Cross-isolate invalidation isn't free on Workers
 * (there's no shared in-memory cache); the 60s TTL is the
 * propagation budget.
 *
 * Defaults live alongside the key constants below so every read
 * has a safe fallback when the row is missing (cold cluster, first
 * deploy, accidental DELETE). New features should start OFF so a
 * SaaS admin must explicitly opt in.
 */

import { eq } from 'drizzle-orm';
import { db, platformSettings } from '@/lib/prisma';

export const PLATFORM_SETTING_KEYS = {
  POLICY_SHARING_ENABLED: 'policy_sharing.enabled',
  // runner-parity 影子校验触发模式（管理员可配）。off=不跑；sampled=按 sample_pct 概率跑；
  //   every=每次执行都跑；manual=仅显式 verify-parity endpoint 触发。默认 off（fail-OFF，须显式 opt-in）。
  RUNNER_PARITY_MODE: 'runner_parity.mode',
  //   sampled 模式的采样百分比（0-100 整数）。默认 5。
  RUNNER_PARITY_SAMPLE_PCT: 'runner_parity.sample_pct',
  // 站内助手总开关。出问题（答复质量差 / 成本异常）时能立刻关掉联网问答而
  // 不必回滚发版；关掉后助手退回纯站内检索，面板照常可用。
  ASSISTANT_ENABLED: 'assistant.enabled',
  // 管理员附加指令：追加到助手 prompt，用来调语气 / 加免责声明 / 引导某类问题。
  // ★只能追加，不能覆盖"只依据站内条目作答"等硬约束（在 aster-api 侧强制，
  //   见 PromptComposer.buildAssistantContext 与其测试）。
  ASSISTANT_EXTRA_INSTRUCTIONS: 'assistant.extra_instructions',
  AUTH_DB_EPOCH: 'auth.dbEpoch',
} as const;

/** 管理员附加指令长度上限，与 aster-api AssistantRequest 的 @Size 对齐。 */
export const ASSISTANT_INSTRUCTIONS_MAX_LEN = 4096;

/** runner-parity trigger 模式枚举（fail-OFF 默认 'off'）。 */
export const RUNNER_PARITY_MODES = ['off', 'sampled', 'every', 'manual'] as const;
export type RunnerParityMode = (typeof RUNNER_PARITY_MODES)[number];

/**
 * Per-key default when the row is missing. Every key in
 * PLATFORM_SETTING_KEYS needs an entry here so reads have a
 * defined fallback.
 */
const DEFAULTS: Record<string, unknown> = {
  [PLATFORM_SETTING_KEYS.POLICY_SHARING_ENABLED]: false,
  [PLATFORM_SETTING_KEYS.RUNNER_PARITY_MODE]: 'off',
  [PLATFORM_SETTING_KEYS.RUNNER_PARITY_SAMPLE_PCT]: 5,
  // 默认开启：助手已上线，这个开关是**应急关闭**用的，不是 opt-in 开关。
  [PLATFORM_SETTING_KEYS.ASSISTANT_ENABLED]: true,
  // 默认空串 = 不附加任何指令，prompt 与未配置时逐字节一致。
  [PLATFORM_SETTING_KEYS.ASSISTANT_EXTRA_INSTRUCTIONS]: '',
  [PLATFORM_SETTING_KEYS.AUTH_DB_EPOCH]: 0,
};

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function fresh(entry: CacheEntry | undefined): entry is CacheEntry {
  return !!entry && entry.expiresAt > Date.now();
}

/**
 * Read a setting. Returns the default when the row is missing or
 * the DB read fails (fail-OFF for feature flags).
 */
export async function getSetting<T = unknown>(key: string): Promise<T> {
  const cached = cache.get(key);
  if (fresh(cached)) return cached.value as T;
  try {
    const row = await db.query.platformSettings.findFirst({
      where: eq(platformSettings.key, key),
    });
    const value = row ? row.value : (DEFAULTS[key] as T);
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value as T;
  } catch (err) {
    console.error('[platform-settings] read failed', key, err);
    // Fail-OFF — flags should never accidentally enable a feature
    // because the DB hiccupped.
    return DEFAULTS[key] as T;
  }
}

/** 直接读取数据库中的设置，供撤销类判断绕过 isolate 缓存。 */
export async function getSettingUncached<T = unknown>(key: string): Promise<T> {
  const row = await db.query.platformSettings.findFirst({ where: eq(platformSettings.key, key) });
  return (row ? row.value : DEFAULTS[key]) as T;
}

/**
 * Write a setting. Invalidates the per-isolate cache for that
 * key on success so subsequent reads on this isolate get fresh
 * data. Other isolates pick up the change within CACHE_TTL_MS.
 *
 * Caller is responsible for permission gating (admin-only).
 * updatedBy is recorded for audit; pass the admin user id.
 */
export async function setSetting(
  key: string,
  value: unknown,
  updatedBy: string,
): Promise<void> {
  const now = new Date();
  // Upsert — pgcrypto-free, uses primary key conflict.
  await db
    .insert(platformSettings)
    .values({
      key,
      value: value as never,
      updatedAt: now,
      updatedBy,
    })
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: {
        value: value as never,
        updatedAt: now,
        updatedBy,
      },
    });
  cache.delete(key);
}

/** Type-safe sugar for the policy-sharing flag. */
export async function isPolicySharingEnabled(): Promise<boolean> {
  const v = await getSetting<boolean>(PLATFORM_SETTING_KEYS.POLICY_SHARING_ENABLED);
  return v === true;
}

/**
 * runner-parity 触发配置（管理员可配三模式 + 采样率）。★任何非法值 fail-closed 为 { mode: 'off' }
 * （诚实边界：parity 是纯附加影子校验，误开销比误关严重；且 launcher 调用有成本）。
 * sample_pct 越界/非整数 → 夹到 [0,100]，非法 → 0（=off 效果）。
 */
export async function getRunnerParityConfig(): Promise<{ mode: RunnerParityMode; samplePct: number }> {
  const rawMode = await getSetting<unknown>(PLATFORM_SETTING_KEYS.RUNNER_PARITY_MODE);
  const mode: RunnerParityMode =
    typeof rawMode === 'string' && (RUNNER_PARITY_MODES as readonly string[]).includes(rawMode)
      ? (rawMode as RunnerParityMode)
      : 'off';
  const rawPct = await getSetting<unknown>(PLATFORM_SETTING_KEYS.RUNNER_PARITY_SAMPLE_PCT);
  let samplePct = 0;
  if (typeof rawPct === 'number' && Number.isFinite(rawPct)) {
    samplePct = Math.min(100, Math.max(0, Math.floor(rawPct)));
  }
  return { mode, samplePct };
}
