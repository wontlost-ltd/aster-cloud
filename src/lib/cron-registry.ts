// Central registry for cron jobs that are invokable from more than one
// place: Cloudflare Workers `scheduled()`, GitHub Actions `workflow_run`,
// ops curl, integration test bench. Each job is declared exactly once
// and consumed by every entrypoint, so a schedule change in
// `wrangler.toml` must also flip the corresponding line here — the
// dispatcher refuses to fire a cron expression that has no registry
// entry, which makes that drift a hard error rather than a silent miss.
//
// What the registry buys us:
//   1. Single source of truth — adding a new cron means one entry here,
//      one line in wrangler.toml, and one `runCronOnce` wrapper in the
//      route. No three-way drift between worker.js / wrangler.toml /
//      route logic.
//   2. Dedup correctness — every entrypoint feeds the same `jobName`
//      and `windowStart` into the lease helper. Cloudflare's
//      `scheduled()` provides `event.scheduledTime` (the canonical
//      window boundary); for external callers we compute it from the
//      wall clock using `windowStartFor(now)`.
//   3. Reviewable — adding a job goes through this file, which acts as
//      a checklist (path + auth + window function in one place).
//
// What it does NOT do:
//   - Run the route. The dispatcher in worker.js still has to actually
//     fetch() the route. The registry only describes which route to
//     fetch for which cron expression.
//   - Cover every cron in src/app/api/cron/. We deliberately wire
//     only the cron expressions Cloudflare is already scheduling (see
//     wrangler.toml). The rest stay externally-triggered until ops
//     decides to schedule them; adding them is a one-line append.

export interface CronJob {
  /**
   * Stable identifier — used as the lease key. Never rename without a
   * migration, or in-flight leases for the old name will look like a
   * different job (and both will run).
   */
  jobName: string;
  /**
   * Cron expression Cloudflare uses. Must match exactly one entry in
   * `wrangler.toml` `[triggers].crons`.
   */
  cron: string;
  /**
   * HTTP route the dispatcher POSTs to. Always relative
   * (no scheme/host) — both worker.js (internal fetch via env binding)
   * and external callers (full URL) prepend their own base.
   */
  routePath: string;
  /**
   * Compute the canonical window-start for "now". For daily crons this
   * floors to today's UTC midnight + the hour-of-day; for hourly crons
   * to the start of the current N-hour bucket; for weekly to the start
   * of the matching weekday. Cloudflare's `event.scheduledTime` is
   * already this value — external callers should call this helper.
   *
   * The window function lets us treat two calls 10 minutes apart as
   * "the same run" if they fall in the same bucket. Without it, a
   * Cloudflare retry + an ops curl 30s later would each acquire a
   * distinct lease and both execute.
   */
  windowStartFor(now: Date): Date;
  /**
   * 心跳环境变量名（可选）。当 cron 在 ops 编排（Healthchecks.io）中注册，
   * 把对应 ping URL 的 env 名填这里；runCronOnce 包装器会在执行前后
   * 自动上报。未填写则不上报（适用于 on-prem 或尚未编排的 cron）。
   *
   * 命名约定 `HEALTHCHECKS_<JOB_UPPER>_URL`，对应
   * docs/operations/uptime-monitoring.md 的清单。
   */
  healthcheckEnv?: string;
}

// ───────── Window helpers ─────────

function floorToUtcDayAtHour(now: Date, hour: number, minute = 0): Date {
  // Same-day boundary if we're past `hour:minute`, otherwise yesterday's.
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0),
  );
  if (d.getTime() > now.getTime()) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

function floorToHourBucket(now: Date, bucketHours: number): Date {
  const h = Math.floor(now.getUTCHours() / bucketHours) * bucketHours;
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, 0, 0, 0),
  );
}

function floorToWeekdayAtHour(now: Date, weekday: number, hour: number): Date {
  // weekday: 0=Sun, 1=Mon … Mirrors cron's "DOW" field.
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0, 0),
  );
  // Walk back to the most recent target weekday at or before `now`.
  while (d.getUTCDay() !== weekday || d.getTime() > now.getTime()) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d;
}

// ───────── Registry ─────────

/**
 * Ordered list — preserves the order seen in `wrangler.toml`. Cloudflare's
 * `event.cron` is the literal expression string; we lookup by that.
 */
export const CRON_REGISTRY: ReadonlyArray<CronJob> = [
  {
    jobName: 'user-purge',
    cron: '30 4 * * *',
    routePath: '/api/cron/user-purge',
    windowStartFor: (now) => floorToUtcDayAtHour(now, 4, 30),
    healthcheckEnv: 'HEALTHCHECKS_USER_PURGE_URL',
  },
  {
    jobName: 'risk-tier-decay',
    cron: '0 5 * * *',
    routePath: '/api/cron/risk-tier-decay',
    windowStartFor: (now) => floorToUtcDayAtHour(now, 5, 0),
    healthcheckEnv: 'HEALTHCHECKS_RISK_TIER_DECAY_URL',
  },
  {
    jobName: 'license-revocation-refresh',
    cron: '0 */6 * * *',
    routePath: '/api/cron/license-revocation-refresh',
    windowStartFor: (now) => floorToHourBucket(now, 6),
    healthcheckEnv: 'HEALTHCHECKS_LICENSE_REVOCATION_URL',
  },
  {
    jobName: 'license-renewal-warning',
    cron: '0 8 * * 1',
    routePath: '/api/cron/license-renewal-warning',
    // Mondays at 08:00 UTC.
    windowStartFor: (now) => floorToWeekdayAtHour(now, 1, 8),
    healthcheckEnv: 'HEALTHCHECKS_LICENSE_RENEWAL_WARNING_URL',
  },
  {
    jobName: 'telemetry-retention-gc',
    cron: '15 3 * * *',
    routePath: '/api/cron/telemetry-retention-gc',
    // 03:15 UTC daily — purposely offset from other crons to spread load.
    windowStartFor: (now) => floorToUtcDayAtHour(now, 3, 15),
    healthcheckEnv: 'HEALTHCHECKS_TELEMETRY_GC_URL',
  },
  {
    jobName: 'execution-retention-gc',
    cron: '0 4 * * *',
    routePath: '/api/cron/execution-retention-gc',
    // 04:00 UTC daily —— 与 03:15 telemetry / 03:45 domain-vocabulary 两条留存
    // cron 错开，沿用本表「分散负载」的既有约定。
    // 让 plans.ts 的 audit7days/audit90days 真正自执行（issue #396）——
    // 此前那两个 featureKey 只是定价页标签，无任何清理代码。
    windowStartFor: (now) => floorToUtcDayAtHour(now, 4, 0),
    healthcheckEnv: 'HEALTHCHECKS_EXECUTION_RETENTION_GC_URL',
  },
  {
    jobName: 'two-factor-code-gc',
    cron: '15 4 * * *',
    routePath: '/api/cron/two-factor-code-gc',
    // 04:15 UTC daily —— 04:30 已被 user-purge 占用，故取 04:15；与
    // 03:15/03:45/04:00 三条留存 cron 错开，沿用本表
    // 「分散负载」的既有约定。让 purgeExpiredCodes 真正有调用方（issue #400）：
    // 此前它零调用方，「过期即清理」只是注释里的承诺，与 #396 里
    // cleanupOldExecutionLogs 的情形完全同构。
    windowStartFor: (now) => floorToUtcDayAtHour(now, 4, 15),
    healthcheckEnv: 'HEALTHCHECKS_TWO_FACTOR_CODE_GC_URL',
  },
  {
    jobName: 'domain-vocabulary-retention',
    cron: '45 3 * * *',
    routePath: '/api/cron/domain-vocabulary-retention',
    // 03:45 UTC daily, offset from other retention crons. Archives free-plan
    // users' active vocab once they cross the 90-day downgrade retention.
    windowStartFor: (now) => floorToUtcDayAtHour(now, 3, 45),
    healthcheckEnv: 'HEALTHCHECKS_DOMAIN_VOCAB_RETENTION_URL',
  },
] as const;

const byJobName = new Map(CRON_REGISTRY.map((c) => [c.jobName, c]));
const byCron = new Map(CRON_REGISTRY.map((c) => [c.cron, c]));

export function getCronByJobName(jobName: string): CronJob | undefined {
  return byJobName.get(jobName);
}

export function getCronByExpression(cron: string): CronJob | undefined {
  return byCron.get(cron);
}

/**
 * Returns the canonical window-start for `(jobName, now)`. Throws if
 * the job isn't registered — callers should fail loudly when a route
 * pretends to be a registered cron but isn't.
 */
export function currentWindowStart(jobName: string, now: Date = new Date()): Date {
  const job = byJobName.get(jobName);
  if (!job) {
    throw new Error(`[cron-registry] unknown jobName: ${jobName}`);
  }
  return job.windowStartFor(now);
}
