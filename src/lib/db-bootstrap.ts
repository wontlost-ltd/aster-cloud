/**
 * Boot-time schema patcher + admin seeder.
 *
 * Why this exists:
 *   We can't reach the production Postgres from the operator's laptop
 *   to run `pnpm db:push` or the seed-admin script — Hyperdrive is the
 *   only thing on the network with credentials. So we run the same
 *   work from inside the Worker on every cold start, guarded by:
 *
 *     1. Per-phase Promise caches so we only attempt each piece of
 *        work once per Worker instance, but admin seed and schema
 *        patch are cached independently (see below).
 *     2. `IF NOT EXISTS` on every DDL so re-applying a patch that
 *        already landed is a no-op even across concurrent isolates.
 *     3. Idempotent admin upsert: re-running for an existing email
 *        rotates the temp password + re-arms `mustChangePassword`,
 *        which is fine — the operator can re-seed if they forget the
 *        temp. Concurrent inserts race-protect via the User_email
 *        unique constraint; the loser treats 23505 as success.
 *
 * Why no Postgres advisory lock (despite the obvious appeal):
 *   pg_(try_)advisory_lock is session-scoped. Under Hyperdrive's
 *   connection pool the lock-acquire statement and the DDL may run
 *   on different pooled connections — the lock isn't held on the
 *   session that does the work. Worse, a Worker isolate that dies
 *   mid-bootstrap can leave the lock held on an orphaned pooled
 *   session indefinitely, permanently blocking every later isolate.
 *   `IF NOT EXISTS` + unique-constraint races give us idempotency
 *   without the foot-gun.
 *
 * What it does:
 *   - Adds User.mustChangePassword (migration 0009) if missing
 *   - If ADMIN_EMAIL + ADMIN_INITIAL_PASSWORD env vars are set, seeds
 *     or refreshes the admin user with isAdmin=true +
 *     mustChangePassword=true
 *
 * Why the two phases are cached separately:
 *   Schema patch is immutable — once the column exists, it exists
 *   forever, so the Promise can be cached for the life of the Worker
 *   isolate.
 *
 *   Admin seed is NOT immutable: the operator may set ADMIN_EMAIL /
 *   ADMIN_INITIAL_PASSWORD *after* the first request lands. With a
 *   single shared cache, the first request resolves the "env not set
 *   — skipping" branch successfully, caches the resolved Promise, and
 *   every later request short-circuits without re-attempting the
 *   seed even after the secrets are populated. We split the caches so
 *   the seed phase can retry on every cold start until it finds a
 *   provisioned admin (then it self-no-ops).
 *
 * It does NOT run on every request — only on the first request that
 * triggers `ensureSchemaApplied()`. Subsequent requests short-circuit
 * via the cached Promises rather than re-running.
 *
 * Failure mode: bootstrap errors are logged but don't throw — we'd
 * rather let the request continue and surface the underlying SQL
 * error at the actual call site than blanket-fail every request on
 * a transient connection blip.
 */

import { sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { getDb, hasDbBinding } from '@/db';
import { randomUUID } from 'node:crypto';

/** Schema patch is immutable: once the column lands, no later request
 *  needs to retry. Safe to cache for the life of the isolate. */
let schemaPatchDone: Promise<void> | null = null;

/** One-time build-phase skip log guard: avoids repeating the same
 *  "no DB binding" line for every prerendered route/locale. */
let noBindingLogged = false;

/**
 * Build 期（`next build` / opennext 预渲染）没有 Hyperdrive binding、也没有
 * DATABASE_URL——此时冷启动自愈被 layout 顺带触发只会逐条 DDL 抛
 * "connection string not found" 刷屏（见 issue #191）。这里在入口安静短路：
 * 没有 DB 来源就不是"失败"，只在首次打一条 debug 级说明，行为等价 no-op。
 * 运行时（Workers 带 Hyperdrive）此判定为 true，自愈照常执行。
 *
 * 设计边界（如实标注，勿误解为更强语义）：
 *   - 判据是"有无可用连接串"（与 getConnectionString 同源），**不是**"是否处于
 *     build/prerender 阶段"。若某个 build 环境显式设了 DATABASE_URL（如部分集成
 *     build），短路不生效、自愈仍会在预渲染期尝试执行——这符合 #191 的精确场景
 *     （issue 明确前提是"build 期无连接串"），但不承诺"预渲染永不触碰 DB"。
 *   - 若 Worker 里存在坏配置的 Hyperdrive binding（有 HYPERDRIVE 但 connectionString
 *     为空），hasDbBinding 返回 false → 此处会跳过自愈。这是合理降级（坏绑定本就
 *     连不上），代价是掩盖坏配置；坏绑定会在真实业务 DB 访问处暴露，不由自愈负责报警。
 */
function dbUnavailableForBootstrap(): boolean {
  if (hasDbBinding()) {
    return false;
  }
  if (!noBindingLogged) {
    noBindingLogged = true;
    console.debug(
      '[db-bootstrap] 无 DB binding（build/预渲染阶段）— 跳过 schema patch + admin seed（运行时冷启动会执行）',
    );
  }
  return true;
}

/** Admin seed cache: we want to re-attempt until we've actually
 *  provisioned the admin row. A *resolved* Promise here means
 *  "we observed an isAdmin + rotated admin in the DB"; until that
 *  is true the cache stays null and every caller re-attempts. */
let adminSeedDone: Promise<void> | null = null;

export function ensureSchemaApplied(): Promise<void> {
  // Build/预渲染阶段无 DB binding：安静短路，不缓存（运行时再执行），
  // 避免逐条 DDL 抛错刷屏（issue #191）。
  if (dbUnavailableForBootstrap()) {
    return Promise.resolve();
  }
  if (!schemaPatchDone) {
    schemaPatchDone = runSchemaPatch().catch((err) => {
      schemaPatchDone = null;
      console.error('[db-bootstrap] schema patch failed:', err);
    });
  }
  // Fire the admin seed in the background — we don't want to block
  // the request on it, but every cold request gets a chance to try
  // again until the admin row is finalized.
  ensureAdminSeeded();
  return schemaPatchDone;
}

/**
 * Idempotent admin seed. Cached only on *success* (i.e. when we
 * observe the admin row in the desired final state, or successfully
 * write it). Returns the in-flight Promise so concurrent callers
 * share the work, but a skip-or-fail clears the cache so the next
 * caller retries.
 */
export function ensureAdminSeeded(): Promise<void> {
  // 同 ensureSchemaApplied：build 期无 DB binding 时安静跳过、不缓存，
  // 运行时冷启动再重试（issue #191）。
  if (dbUnavailableForBootstrap()) {
    return Promise.resolve();
  }
  if (adminSeedDone) return adminSeedDone;
  adminSeedDone = runAdminSeed()
    .then((didFinalize) => {
      // Only keep the cache if we reached a terminal state — i.e.
      // the admin row exists and is correctly flagged. Otherwise
      // (env vars missing, transient skip), clear so the next caller
      // re-attempts.
      if (!didFinalize) {
        adminSeedDone = null;
      }
    })
    .catch((err) => {
      adminSeedDone = null;
      console.error('[db-bootstrap] admin seed failed:', err);
    });
  return adminSeedDone;
}

async function runSchemaPatch(): Promise<void> {
  const db = getDb();

  // No advisory lock needed: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
  // is atomic in Postgres and a no-op if the column already exists.
  // The session-scoped lock approach (pg_try_advisory_lock) is unsafe
  // under Hyperdrive — different statements may run on different
  // pooled connections, so the lock is held on a session we may not
  // execute the DDL on, and a Worker isolate that dies mid-bootstrap
  // can leave the lock held indefinitely.
  await db.execute(
    sql`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mustChangePassword" boolean NOT NULL DEFAULT false`,
  );

  // Notification table — in-app notification feed used by the topbar
  // bell + future inbox surfaces. Created here (rather than via a
  // drizzle migration) so SaaS deploys self-heal on cold start, same
  // pattern as the 0009 column above. `IF NOT EXISTS` keeps it
  // idempotent across isolates.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "Notification" (
      "id" text PRIMARY KEY NOT NULL,
      "userId" text NOT NULL,
      "kind" text NOT NULL,
      "data" jsonb NOT NULL,
      "readAt" timestamp,
      "createdAt" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "Notification_userId_idx" ON "Notification" ("userId")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "Notification_userId_readAt_idx" ON "Notification" ("userId", "readAt")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "Notification_createdAt_idx" ON "Notification" ("createdAt")
  `);

  // PlatformSetting — generic admin-controlled key/value flags
  // (e.g. policy_sharing.enabled). No row is inserted here; the
  // read helper enforces the per-flag default (OFF) when the row
  // is missing.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "PlatformSetting" (
      "key" text PRIMARY KEY NOT NULL,
      "value" jsonb NOT NULL,
      "updatedAt" timestamp NOT NULL DEFAULT now(),
      "updatedBy" text
    )
  `);

  // PolicyShare — many-to-many policy → team grants. Unique on
  // (policyId, teamId) so creating the same share twice is a no-op
  // at the DB layer; the API still hits the unique violation as a
  // soft success.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "PolicyShare" (
      "id" text PRIMARY KEY NOT NULL,
      "policyId" text NOT NULL,
      "teamId" text NOT NULL,
      "sharedByUserId" text NOT NULL,
      "createdAt" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "PolicyShare_policy_team_key" ON "PolicyShare" ("policyId", "teamId")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "PolicyShare_teamId_idx" ON "PolicyShare" ("teamId")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "PolicyShare_policyId_idx" ON "PolicyShare" ("policyId")
  `);
  // Permission tier (view / execute). Existing rows default to
  // 'execute' so pre-tier shares keep their original behaviour.
  await db.execute(sql`
    ALTER TABLE "PolicyShare"
    ADD COLUMN IF NOT EXISTS "permission" text NOT NULL DEFAULT 'execute'
  `);

  // ----------------------------------------------------------------
  // user-domain-vocabulary tables (B1+B2 / migration 0021)
  //
  // Self-healed here for the same reason as the blocks above: Hyperdrive
  // is the only thing on the network with credentials, so a Worker cold
  // start has to materialize the tables idempotently on first request.
  // All DDL uses IF NOT EXISTS, so re-applying after the migration has
  // landed is a no-op. The order respects the FK chain:
  //   1. DomainTerm (independent)
  //   2. UserVocabularySnapshot (independent; UserDomainTerm references it)
  //   3. UserDomainTerm (FKs to DomainTerm + UserVocabularySnapshot + User)
  //   4. PolicyVersion.vocabularySnapshotIds column add
  // ----------------------------------------------------------------
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "DomainTerm" (
      "id" text PRIMARY KEY NOT NULL,
      "domain" text NOT NULL,
      "locale" text NOT NULL,
      "kind" text NOT NULL,
      "canonical" text NOT NULL,
      "canonicalNorm" text NOT NULL,
      "localized" text NOT NULL,
      "localizedNorm" text NOT NULL,
      "parentCanonical" text,
      "parentCanonicalNorm" text,
      "description" text,
      "aliases" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "source" text NOT NULL,
      "status" text NOT NULL DEFAULT 'active',
      "version" integer NOT NULL DEFAULT 1,
      "dedupKey" text NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      "deprecatedAt" timestamptz,
      "deprecatedReason" text,
      CONSTRAINT "DomainTerm_kind_check" CHECK (
        "kind" IN ('struct', 'field', 'function', 'enum_value')
      ),
      CONSTRAINT "DomainTerm_source_check" CHECK (
        "source" IN ('builtin', 'user', 'admin_seed')
      ),
      CONSTRAINT "DomainTerm_status_check" CHECK (
        "status" IN ('active', 'deprecated')
      )
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "DomainTerm_dedupKey_unique"
      ON "DomainTerm" ("dedupKey")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "DomainTerm_domain_locale_kind_idx"
      ON "DomainTerm" ("domain", "locale", "kind")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "DomainTerm_status_idx"
      ON "DomainTerm" ("status")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "DomainTerm_canonicalNorm_idx"
      ON "DomainTerm" ("canonicalNorm")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "DomainTerm_localizedNorm_idx"
      ON "DomainTerm" ("localizedNorm")
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "UserVocabularySnapshot" (
      "id" text PRIMARY KEY NOT NULL,
      "ownerType" text NOT NULL,
      "ownerId" text NOT NULL,
      "domain" text NOT NULL,
      "locale" text NOT NULL,
      "version" integer NOT NULL,
      "vocabularyJson" jsonb NOT NULL,
      "termIds" jsonb NOT NULL,
      "contentHash" text NOT NULL,
      "refCount" integer NOT NULL DEFAULT 0,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "archivedAt" timestamptz,
      CONSTRAINT "UserVocabularySnapshot_ownerType_check" CHECK (
        "ownerType" IN ('user', 'team')
      ),
      CONSTRAINT "UserVocabularySnapshot_refCount_check" CHECK ("refCount" >= 0)
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "UserVocabularySnapshot_owner_version_unique"
      ON "UserVocabularySnapshot" (
        "ownerType",
        "ownerId",
        "domain",
        "locale",
        "version"
      )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "UserVocabularySnapshot_owner_hash_unique"
      ON "UserVocabularySnapshot" (
        "ownerType",
        "ownerId",
        "domain",
        "locale",
        "contentHash"
      )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "UserVocabularySnapshot_refCount_idx"
      ON "UserVocabularySnapshot" ("refCount")
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "UserDomainTerm" (
      "id" text PRIMARY KEY NOT NULL,
      "userId" text NOT NULL,
      "termId" text NOT NULL,
      "ownerType" text NOT NULL DEFAULT 'user',
      "teamId" text,
      "domain" text NOT NULL,
      "locale" text NOT NULL,
      "kind" text NOT NULL,
      "note" text,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      "deletedAt" timestamptz,
      "deletedBy" text,
      "deletedReason" text,
      "archivedAt" timestamptz,
      "archiveSnapshotId" text,
      CONSTRAINT "UserDomainTerm_userId_User_id_fk"
        FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE,
      CONSTRAINT "UserDomainTerm_termId_DomainTerm_id_fk"
        FOREIGN KEY ("termId") REFERENCES "DomainTerm" ("id") ON DELETE RESTRICT,
      CONSTRAINT "UserDomainTerm_teamId_Team_id_fk"
        FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE,
      CONSTRAINT "UserDomainTerm_archiveSnapshotId_UserVocabularySnapshot_id_fk"
        FOREIGN KEY ("archiveSnapshotId") REFERENCES "UserVocabularySnapshot" ("id"),
      CONSTRAINT "UserDomainTerm_owner_v1_check" CHECK (
        "ownerType" = 'user'
        AND "userId" IS NOT NULL
        AND "teamId" IS NULL
      )
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "UserDomainTerm_active_unique"
      ON "UserDomainTerm" ("userId", "termId")
      WHERE "deletedAt" IS NULL AND "archivedAt" IS NULL
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "UserDomainTerm_user_domain_idx"
      ON "UserDomainTerm" ("userId", "domain", "locale")
      WHERE "deletedAt" IS NULL AND "archivedAt" IS NULL
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "UserDomainTerm_termId_idx"
      ON "UserDomainTerm" ("termId")
      WHERE "deletedAt" IS NULL AND "archivedAt" IS NULL
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "UserDomainTerm_archive_idx"
      ON "UserDomainTerm" ("archivedAt", "deletedAt")
  `);

  await db.execute(sql`
    ALTER TABLE "PolicyVersion"
      ADD COLUMN IF NOT EXISTS "vocabularySnapshotIds" jsonb NOT NULL DEFAULT '[]'::jsonb
  `);
  // ADR 0051 §7：封印 envelope 时的词汇段（迁移 0060）。schema 声明了该列后，整行查询
  // PolicyVersion 都会选它；迁移未跑时冷启动先补列，避免所有版本读写 500。
  await db.execute(sql`
    ALTER TABLE "PolicyVersion" ADD COLUMN IF NOT EXISTS "sourceScopesJson" text
  `);

  // ----------------------------------------------------------------
  // Lexicon idempotency + bulk jobs (B5 / migration 0022 + 0023)
  // ----------------------------------------------------------------
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "LexiconIdempotencyKey" (
      "id" text PRIMARY KEY NOT NULL,
      "userId" text NOT NULL,
      "idempotencyKey" text NOT NULL,
      "routeKey" text NOT NULL,
      "requestHash" text NOT NULL,
      "responseStatus" integer NOT NULL,
      "responseBody" jsonb NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "expiresAt" timestamptz NOT NULL,
      CONSTRAINT "LexiconIdempotencyKey_userId_User_id_fk"
        FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "LexiconIdempotencyKey_user_route_key_unique"
      ON "LexiconIdempotencyKey" ("userId", "routeKey", "idempotencyKey")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "LexiconIdempotencyKey_expiresAt_idx"
      ON "LexiconIdempotencyKey" ("expiresAt")
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "LexiconBulkJob" (
      "id" text PRIMARY KEY NOT NULL,
      "userId" text NOT NULL,
      "idempotencyKey" text,
      "status" text NOT NULL DEFAULT 'queued',
      "mode" text NOT NULL,
      "rowCount" integer NOT NULL,
      "processed" integer NOT NULL DEFAULT 0,
      "rollup" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "errors" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "claimedBy" text,
      "claimedAt" timestamptz,
      "completedAt" timestamptz,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "LexiconBulkJob_userId_User_id_fk"
        FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE,
      CONSTRAINT "LexiconBulkJob_status_check" CHECK (
        "status" IN ('queued', 'running', 'completed', 'failed', 'cancelled')
      ),
      CONSTRAINT "LexiconBulkJob_mode_check" CHECK (
        "mode" IN ('sync', 'async')
      ),
      CONSTRAINT "LexiconBulkJob_processed_check" CHECK (
        "rowCount" > 0 AND "processed" >= 0 AND "processed" <= "rowCount"
      ),
      CONSTRAINT "LexiconBulkJob_rollup_shape_check" CHECK (
        jsonb_typeof("rollup") = 'object'
      ),
      CONSTRAINT "LexiconBulkJob_errors_shape_check" CHECK (
        jsonb_typeof("errors") = 'array'
      )
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "LexiconBulkJob_userId_createdAt_idx"
      ON "LexiconBulkJob" ("userId", "createdAt" DESC)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "LexiconBulkJob_status_createdAt_idx"
      ON "LexiconBulkJob" ("status", "createdAt")
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "LexiconBulkJob_user_idem_unique"
      ON "LexiconBulkJob" ("userId", "idempotencyKey")
      WHERE "idempotencyKey" IS NOT NULL
  `);
  await db.execute(sql`
    ALTER TABLE "LexiconBulkJob"
      ADD COLUMN IF NOT EXISTS "inputJson" jsonb
  `);

  console.warn(
    '[db-bootstrap] schema patch 0009 + notifications + policy-sharing + vocab applied',
  );
}

/**
 * Returns true if the admin seed reached a terminal state worth
 * caching (admin row exists with isAdmin=true), false if it was
 * skipped or otherwise non-final.
 */
async function runAdminSeed(): Promise<boolean> {
  const adminEmailRaw = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_INITIAL_PASSWORD;
  if (!adminEmailRaw || !adminPassword) {
    console.warn(
      '[db-bootstrap] ADMIN_EMAIL / ADMIN_INITIAL_PASSWORD not set — skipping admin seed (will retry on next request)',
    );
    return false;
  }

  // No advisory lock: the seed is already idempotent
  // (findFirst → update-or-insert), and concurrent inserts of the
  // same email are protected by the User_email_unique constraint
  // (the second insert will throw a unique-violation we treat as a
  // race-lost no-op).
  try {
    await seedAdmin(adminEmailRaw, adminPassword, process.env.ADMIN_NAME);
    return true;
  } catch (err) {
    // Surface as much error context as possible — drizzle's
    // `Failed query: ...` wrapper hides the underlying Postgres
    // detail/code by default. The Worker dashboard only renders
    // the top-level Error.message, so we manually pull out the
    // pg driver fields and log them.
    const e = err as {
      code?: string;
      detail?: string;
      message?: string;
      cause?: { code?: string; detail?: string; message?: string };
    } | null;
    const code = e?.code ?? e?.cause?.code;
    const detail = e?.detail ?? e?.cause?.detail;
    const causeMsg = e?.cause?.message;
    console.error(
      `[db-bootstrap] admin seed insert error: code=${code} detail=${detail} causeMsg=${causeMsg} topMsg=${e?.message}`,
    );

    // Postgres unique violation = another worker won the race.
    // Treat as success: the row exists, we just didn't write it.
    if (code === '23505') {
      console.warn(
        '[db-bootstrap] admin seed lost a race; another worker created the row',
      );
      return true;
    }
    throw err;
  }
}

async function seedAdmin(
  emailRaw: string,
  password: string,
  name: string | undefined,
): Promise<void> {
  if (password.length < 8) {
    console.error('[db-bootstrap] ADMIN_INITIAL_PASSWORD too short — skipping');
    return;
  }
  const email = emailRaw.toLowerCase().trim();
  const passwordHash = await bcrypt.hash(password, 12);
  const db = getDb();

  // Case-insensitive lookup: an existing row may have been written
  // with mixed-case email (e.g. via GitHub OAuth's profile.email),
  // which would fail `eq` against our lowercased input and then
  // collide with the email unique constraint on insert.
  const existingRows = await db.execute(
    sql`SELECT id, "mustChangePassword", "isAdmin" FROM "User" WHERE LOWER(email) = ${email} LIMIT 1`,
  );
  const existing = Array.isArray(existingRows) && existingRows[0]
    ? (existingRows[0] as { id: string; mustChangePassword: boolean; isAdmin: boolean })
    : null;

  if (existing) {
    // Already rotated voluntarily — don't reset the temp password or
    // re-arm the rotate flag on every cold start.
    if (existing.isAdmin && !existing.mustChangePassword) {
      console.warn(
        `[db-bootstrap] admin ${email} already provisioned + rotated — no-op`,
      );
      return;
    }
    // Raw SQL for the same reason as the insert branch — Drizzle's
    // .set() may swallow the updatedAt value if the column has
    // `.defaultNow()` in schema.ts.
    const updateNow = new Date();
    await db.execute(sql`
      UPDATE "User"
         SET "passwordHash"       = ${passwordHash},
             "isAdmin"            = true,
             "mustChangePassword" = true,
             "updatedAt"          = ${updateNow.toISOString()}
       WHERE "id" = ${existing.id}
    `);
    console.warn(
      `[db-bootstrap] refreshed admin ${email} (id=${existing.id})`,
    );
  } else {
    const id = randomUUID();
    const now = new Date();
    // Bypass Drizzle's TS-layer .values() entirely with raw SQL.
    // Empirically (see commit cb2df48) Drizzle was silently
    // dropping our explicit createdAt/updatedAt and emitting
    // `DEFAULT, DEFAULT` for them — likely because schema.ts
    // declares them with `.defaultNow()`, which the query builder
    // treats as "I'll handle this, ignore the user-provided value".
    // The DB-level column has no `DEFAULT now()` clause (original
    // migration never wrote one), so DEFAULT resolves to NULL and
    // the NOT NULL constraint fires (23502). Going raw forces the
    // exact INSERT we want.
    await db.execute(sql`
      INSERT INTO "User" (
        "id", "name", "email",
        "emailVerified", "passwordHash", "plan",
        "isAdmin", "mustChangePassword",
        "createdAt", "updatedAt"
      ) VALUES (
        ${id}, ${name ?? 'Admin'}, ${email},
        ${now.toISOString()}, ${passwordHash}, 'pro',
        true, true,
        ${now.toISOString()}, ${now.toISOString()}
      )
    `);
    console.warn(`[db-bootstrap] created admin ${email} (id=${id})`);
  }
}
