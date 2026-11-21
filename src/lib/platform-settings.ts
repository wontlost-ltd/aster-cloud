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
import { db, platformSettings, type Database } from '@/lib/prisma';

/** 事务客户端或默认连接，供需要与其他写入同事务的调用方传入。 */
export type SettingsClient = Pick<Database, 'insert' | 'query'>;

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
  // 结构化编写（ADR 0058）：全局开关，默认 OFF，须管理员显式打开。
  STRUCTURED_AUTHORING_ENABLED: 'capability.structured_authoring.enabled',
  // 团队 owner 委派总开关：一键停掉所有团队的委派，默认 ON。
  STRUCTURED_AUTHORING_TEAM_DELEGATION: 'capability.structured_authoring.team_delegation.enabled',
  // 策略包导出（ADR 0059 P2，修订 3 P2-R16）：默认 OFF；aster-api 侧另有 ASTER_EXPORT_PACKAGE_ENABLED，
  //   两边都开且列车与导出密钥就绪后才真正可用。
  POLICY_PACKAGE_EXPORT_ENABLED: 'policy_export.package.enabled',
  // 策略包携带显示排版（ADR 0059 修订 4 D13）：默认 OFF。关时导出不发送排版，包为 1.0，
  //   响应头 X-Aster-Package-Layout-Reason 为 layout_export_disabled。
  POLICY_PACKAGE_LAYOUT_EXPORT_ENABLED: 'policy_export.package.layout.enabled',
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
  [PLATFORM_SETTING_KEYS.STRUCTURED_AUTHORING_ENABLED]: false,
  [PLATFORM_SETTING_KEYS.STRUCTURED_AUTHORING_TEAM_DELEGATION]: true,
  [PLATFORM_SETTING_KEYS.POLICY_PACKAGE_EXPORT_ENABLED]: false,
  [PLATFORM_SETTING_KEYS.POLICY_PACKAGE_LAYOUT_EXPORT_ENABLED]: false,
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
export async function getSettingUncached<T = unknown>(
  key: string,
  client: SettingsClient = db,
): Promise<T> {
  const row = await client.query.platformSettings.findFirst({ where: eq(platformSettings.key, key) });
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
  await writeSetting(db, key, value, updatedBy);
  invalidateSettingCache(key);
}

/**
 * 在调用方给定的客户端（通常是事务）上写入设置，不触碰 isolate 缓存。
 * 调用方必须在事务提交成功后再调用 invalidateSettingCache，避免回滚后缓存已被清空/重填脏值。
 */
export async function setSettingWithClient(
  client: SettingsClient,
  key: string,
  value: unknown,
  updatedBy: string,
): Promise<void> {
  await writeSetting(client, key, value, updatedBy);
}

/** 使本 isolate 内某个键的缓存失效。 */
export function invalidateSettingCache(key: string): void {
  cache.delete(key);
}

async function writeSetting(
  client: SettingsClient,
  key: string,
  value: unknown,
  updatedBy: string,
): Promise<void> {
  const now = new Date();
  // Upsert — pgcrypto-free, uses primary key conflict.
  await client
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
}

/** Type-safe sugar for the policy-sharing flag. */
export async function isPolicySharingEnabled(): Promise<boolean> {
  const v = await getSetting<boolean>(PLATFORM_SETTING_KEYS.POLICY_SHARING_ENABLED);
  return v === true;
}

/** 策略包导出开关：只有布尔 true 才算打开（缺行、读库失败、非布尔值一律关闭）。 */
export async function isPolicyPackageExportEnabled(): Promise<boolean> {
  const v = await getSetting<unknown>(PLATFORM_SETTING_KEYS.POLICY_PACKAGE_EXPORT_ENABLED);
  return v === true;
}

/** 策略包携带显示排版的开关（修订 4 D13）：只有布尔 true 才算打开（缺行、读库失败、非布尔值一律关闭）。 */
export async function isPolicyPackageLayoutExportEnabled(): Promise<boolean> {
  const v = await getSetting<unknown>(PLATFORM_SETTING_KEYS.POLICY_PACKAGE_LAYOUT_EXPORT_ENABLED);
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
