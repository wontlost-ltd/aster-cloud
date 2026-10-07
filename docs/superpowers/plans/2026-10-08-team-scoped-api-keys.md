# 团队作用域 API key 与 owner 共享配额池 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 aster-cloud 签发的 API key 能代表「成员 U 以团队 T 身份行动」（`tenantId = teamId`、`userId = U`、`role = 团队角色`），使 Action Guard 四眼审批在 SaaS 上可用，并把团队 key 的调用量计入 owner 的共享配额池。

**Architecture:** `ApiKey.teamId`（可空）区分个人/团队 key；`src/lib/api-key-identity.ts` 是 key → 身份的唯一解析器，verify 路由、snapshot 推送、snapshot/full、`validateApiKey` 四处复用；verify/snapshot 响应新增 `quotaOwnerId`，aster-api 把它随 key 身份透传并作为配额键（个人 key 下等于 userId，行为不变）；cloud 的 precheck/usage 按 `quotaOwnerId` 归池；团队生命周期路由在成员/所有权变化时吊销或重推 key 快照。

**Tech Stack:** aster-cloud：Next.js 16（App Router）、Drizzle ORM（手写 SQL 迁移）、vitest、next-intl；aster-api：Quarkus、Vert.x JsonObject、Caffeine、Redis、JUnit 5 + RestAssured。

**Spec:** `/Users/rpang/IdeaProjects/aster-cloud/docs/architecture/decisions/0015-team-scoped-api-keys.md`（分支 `adr-0015-team-scoped-api-keys`）。aster-api 侧改动是该 ADR §3 的配套。

## Global Constraints

- 代码注释与文档用简体中文描述意图；禁止「修改说明」式注释。
- aster-cloud：Node ≥ 24，`export PATH=/opt/homebrew/opt/node@24/bin:$PATH`，用 `corepack pnpm`（pnpm 10.28.0）。验证命令：`pnpm exec tsc --noEmit -p tsconfig.json && pnpm lint && pnpm test:run`；涉及文案时再加 `pnpm check:locales:strict`。
- aster-cloud 测试风格：手写 mock `@/lib/prisma` 的 `db.query.*` 与 `drizzle-orm` 算子（见 `src/__tests__/app/api/internal/apikey-verify-route.test.ts`）；路由/库新引入的表导出与算子必须同步加进相关测试的 mock，否则测试抛错。
- 迁移手写：`drizzle/0049_api_key_team_scope.sql`，`IF NOT EXISTS`，`--> statement-breakpoint` 分隔；`drizzle/meta/_journal.json` 追加 `{ "idx": 49, "version": "7", "when": 1789400000000, "tag": "0049_api_key_team_scope", "breakpoints": true }`（`when` 必须 > 1789342699256）。不做数据回填。
- 真实表名：`ApiKey`、`ApiCallRecord`（Drizzle 变量 `apiKeys`、`apiCallRecords`）、`Team`、`TeamMember`。
- aster-api：`export PATH=/opt/homebrew/opt/node@24/bin:/opt/podman/bin:$PATH`；纯 JUnit 用 `./gradlew --offline :test --tests '<类名>'`；`@QuarkusTest` 需要 Postgres：`podman run -d --name sdd-pg -p 55432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=aster_policy postgres:17-alpine postgres -c fsync=off -c synchronous_commit=off -c max_connections=200` 与 `podman run -d --name sdd-redis -p 6379:6379 redis:7-alpine`，运行时带 `DB_JDBC_URL=jdbc:postgresql://localhost:55432/aster_policy DB_USERNAME=postgres DB_PASSWORD=postgres`，结束后 `podman rm -f sdd-pg sdd-redis`。已知与本计划无关的失败：`PolicyGraphQLResourceTest.testBatchEvaluateLargeVolume`、`PrismaDatabaseE2ETest`。
- 向后兼容是铁律：`teamId IS NULL` 的 key 在 verify/snapshot/配额/租户上的每个输出必须与改前逐字段相同；aster-api 对缺失 `quotaOwnerId` 回退 `userId`。
- 所有对 aster-api 的推送/失效调用都是 best-effort：失败只记日志，不回滚业务写入。
- 提交信息后缀空行 + `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

## Review Focus

1. 既是团队成员又持有**个人** key 的用户：verify 必须仍返回 `tenantId = userId`、`role = owner`、`quotaOwnerId = userId`（Task 3 verify 成功路径测试「个人 key 不受团队成员身份影响」）。
2. 团队被删除但 `TeamMember` 行残留（或反之）：解析器返回 `team_not_found` / `membership_revoked`，不得抛错（Task 2 单测）。
3. owner 降到 free 后成员继续用团队 key：verify 返回 owner 的 `plan: 'free'`；precheck 对该 owner 返回 `apiCallsLimit: 0`，aster-api 403（Task 2 owner 套餐测试 + Task 6 precheck 测试）。
4. 旧 aster-api 发来的 usage 记录没有 `quotaOwnerId`：usage POST 必须以 `userId` 回填，且 precheck 用 `COALESCE` 把旧 NULL 行计入持有者个人池（Task 6 usage/precheck 测试）。
5. 旧 cloud 的 verify/snapshot 响应没有 `quotaOwnerId`：aster-api 回退到 `userId`，配额键不变（Task 8 `ApiKeyVerifyResultTest`、`ApiKeySnapshotTest`）。

---

## 文件结构

**aster-cloud（分支 `feat/adr-0015-team-scoped-api-keys`，基于 `adr-0015-team-scoped-api-keys`）**

| 文件 | 职责 |
|---|---|
| `src/db/schema.ts` | `apiKeys.teamId`、`apiCallRecords.quotaOwnerId`、`apiKeysRelations.team` |
| `drizzle/0049_api_key_team_scope.sql`、`drizzle/meta/_journal.json` | 迁移 |
| `src/lib/api-key-identity.ts`（新） | key → 身份的唯一解析器（单条 + 批量） |
| `src/lib/api-keys.ts` | 创建/列表/吊销/校验；团队 key 吊销与快照重推助手 |
| `src/lib/snapshot-pusher.ts` | `pushApiKeySnapshot` 用解析器；`pushUserSnapshot` 内 fan-out 失效团队 plan 缓存 |
| `src/lib/plan-gate-client.ts` | `invalidatePlanCacheForOwner(ownerId)` |
| `src/lib/api-quota-pool.ts`（新） | `countOwnerPoolUsage`、`ownerPoolCondition`、`currentPeriodMonth` |
| `src/app/api/internal/apikey/verify/route.ts` | 用解析器；响应加 `quotaOwnerId` |
| `src/app/api/internal/snapshot/full/route.ts` | 批量解析器 |
| `src/app/api/internal/api/precheck/route.ts`、`usage/route.ts` | 共享池计数；`quotaOwnerId` 落库 |
| `src/app/api/user/api-usage/route.ts`、`src/app/api/cron/api-quota-alerts/route.ts` | 共享池计数 |
| `src/app/api/api-keys/route.ts`、`[id]/route.ts` | `teamId` 契约 |
| `src/app/api/teams/[teamId]/members/[memberId]/route.ts`、`transfer/route.ts`、`route.ts` | 生命周期钩子 |
| `src/app/[locale]/(dashboard)/settings/api-keys/page.tsx`、`api-keys-content.tsx`、`src/i18n/demo-supplement.ts` | UI 与文案 |

**aster-api（分支 `feat/adr-0015-quota-owner`，基于 `main`）**

| 文件 | 职责 |
|---|---|
| `security/apikey/ApiKeyVerifyResult.java`、`ApiKeyVerifierService.java`、`ApiKeyAuthFilter.java` | `quotaOwnerId` 解析与透传 |
| `billing/snapshot/ApiKeySnapshot.java`、`SnapshotPushResource.java`、`SnapshotWarmupService.java` | 快照字段 |
| `policy/rest/RequestIdentityResolver.java` | `quotaOwnerId()` |
| `billing/ApiQuotaGuard.java` | 配额键改为 quotaOwnerId；usage 请求体 |
| `guard/api/GuardDecisionResource.java`、`policy/rest/PolicyEvaluationResource.java` | 调用点 |

---

### Task 1: schema 与迁移（aster-cloud）

**Files:**
- Modify: `src/db/schema.ts:519-536`（`apiKeys`）、`:725-748`（`apiCallRecords`）、`:1951-1956`（`apiKeysRelations`）
- Create: `drizzle/0049_api_key_team_scope.sql`
- Modify: `drizzle/meta/_journal.json`
- Test: `src/__tests__/db/api-key-team-scope-schema.test.ts`

**Interfaces:**
- Produces: `apiKeys.teamId: text | null`；`apiCallRecords.quotaOwnerId: text | null`；`apiKeysRelations.team`（`one(teams)`），供 `listApiKeys` 的 `with: { team }` 使用。

- [ ] **Step 1: 写失败测试**

```ts
// src/__tests__/db/api-key-team-scope-schema.test.ts
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { apiKeys, apiCallRecords } from '@/db/schema';

describe('ADR 0015 schema', () => {
  it('ApiKey 有可空 teamId 列', () => {
    const col = getTableColumns(apiKeys).teamId;
    expect(col).toBeDefined();
    expect(col.notNull).toBe(false);
  });
  it('ApiCallRecord 有可空 quotaOwnerId 列', () => {
    const col = getTableColumns(apiCallRecords).quotaOwnerId;
    expect(col).toBeDefined();
    expect(col.notNull).toBe(false);
  });
  it('迁移 0049 已登记且 when 单调', () => {
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as { entries: Array<{ tag: string; when: number }> };
    const last = journal.entries[journal.entries.length - 1];
    expect(last.tag).toBe('0049_api_key_team_scope');
    expect(last.when).toBeGreaterThan(1789342699256);
    const sql = readFileSync('drizzle/0049_api_key_team_scope.sql', 'utf8');
    expect(sql).toContain('ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "teamId" text');
    expect(sql).toContain('ALTER TABLE "ApiCallRecord" ADD COLUMN IF NOT EXISTS "quotaOwnerId" text');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run --project saas src/__tests__/db/api-key-team-scope-schema.test.ts`
Expected: FAIL（`teamId` undefined；迁移文件不存在）

- [ ] **Step 3: 改 schema**

`apiKeys` 列中 `userId` 之后加：

```ts
    // 团队作用域：非空即「成员以该团队身份使用」，角色在解析时从 TeamMember 现查（ADR 0015 §1）
    teamId: text('teamId'),
```

索引数组加 `index('ApiKey_teamId_idx').on(table.teamId),`。

`apiCallRecords` 列中 `apiKeyId` 之后加：

```ts
    // 配额归属：owner 共享池的键；旧行为 NULL，统计时 COALESCE(quotaOwnerId, userId)（ADR 0015 §4）
    quotaOwnerId: text('quotaOwnerId'),
```

索引数组加 `index('ApiCall_quotaOwnerId_period_idx').on(table.quotaOwnerId, table.periodMonth, table.status),`。

`apiKeysRelations` 改为：

```ts
export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, { fields: [apiKeys.userId], references: [users.id] }),
  team: one(teams, { fields: [apiKeys.teamId], references: [teams.id] }),
}));
```

（`teams` 在同文件 L1198 定义，位置在 `apiKeysRelations` 之前，无需前向引用处理。）

- [ ] **Step 4: 写迁移**

`drizzle/0049_api_key_team_scope.sql`：

```sql
-- 团队作用域 API key 与 owner 共享配额池（ADR 0015 §1）。
-- ★IF NOT EXISTS：与 0044–0048 同范式，生产可能已手工加列。
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "teamId" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ApiKey_teamId_idx" ON "ApiKey" USING btree ("teamId");
--> statement-breakpoint
ALTER TABLE "ApiCallRecord" ADD COLUMN IF NOT EXISTS "quotaOwnerId" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ApiCall_quotaOwnerId_period_idx" ON "ApiCallRecord" USING btree ("quotaOwnerId", "periodMonth", "status");
```

`_journal.json` 的 `entries` 末尾追加：

```json
    {
      "idx": 49,
      "version": "7",
      "when": 1789400000000,
      "tag": "0049_api_key_team_scope",
      "breakpoints": true
    }
```

- [ ] **Step 5: 运行测试通过**

Run: `pnpm exec vitest run --project saas src/__tests__/db/api-key-team-scope-schema.test.ts && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/db/schema.ts drizzle/0049_api_key_team_scope.sql drizzle/meta/_journal.json src/__tests__/db/api-key-team-scope-schema.test.ts
git commit -m "feat(db): ApiKey.teamId 与 ApiCallRecord.quotaOwnerId（ADR 0015 §1）"
```

---

### Task 2: 身份解析器 `api-key-identity.ts`（aster-cloud）

**Files:**
- Create: `src/lib/api-key-identity.ts`
- Test: `src/__tests__/lib/api-key-identity.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `apiKeys.teamId`；`SOLO_TENANT_ROLE`、`TeamRole`（`@/lib/team-permissions`）；`Plan`（`@/db/schema`）。
- Produces:

```ts
export type ApiKeyRow = {
  id: string; userId: string; teamId: string | null;
  revokedAt: Date | null; expiresAt: Date | null;
};
export type ApiKeyIdentity =
  | { valid: true; apiKeyId: string; userId: string; tenantId: string; teamId: string | null; quotaOwnerId: string;
      role: TeamRole; plan: Plan; subscriptionStatus: string | null }
  | { valid: false; reason: 'not_found' | 'revoked' | 'expired' | 'orphan_key' | 'team_not_found' | 'membership_revoked';
      revokedAt?: Date; expiredAt?: Date };
export const API_KEY_IDENTITY_COLUMNS = { id: true, userId: true, teamId: true, revokedAt: true, expiresAt: true } as const;
export async function resolveApiKeyIdentity(keyHash: string, now?: Date): Promise<ApiKeyIdentity>;
export async function resolveApiKeyIdentities(keys: ApiKeyRow[], now?: Date): Promise<Map<string, ApiKeyIdentity>>; // 键为 ApiKeyRow.id
```

- [ ] **Step 1: 写失败测试**

```ts
// src/__tests__/lib/api-key-identity.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  apiKeysFindFirst: vi.fn(),
  usersFindMany: vi.fn(),
  teamsFindMany: vi.fn(),
  teamMembersFindMany: vi.fn(),
}));
vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      apiKeys: { findFirst: m.apiKeysFindFirst },
      users: { findMany: m.usersFindMany },
      teams: { findMany: m.teamsFindMany },
      teamMembers: { findMany: m.teamMembersFindMany },
    },
  },
  apiKeys: { key: 'apiKeys.key' },
  users: { id: 'users.id' },
  teams: { id: 'teams.id' },
  teamMembers: { teamId: 'teamMembers.teamId', userId: 'teamMembers.userId' },
}));
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...c: unknown[]) => ({ op: 'and', c }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: 'in', col, vals }),
}));

const NOW = new Date('2026-10-08T00:00:00Z');
const personal = { id: 'k1', userId: 'u1', teamId: null, revokedAt: null, expiresAt: null };
const teamKey = { id: 'k2', userId: 'u2', teamId: 't1', revokedAt: null, expiresAt: null };

describe('resolveApiKeyIdentities', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.values(m).forEach((f) => f.mockReset());
    m.usersFindMany.mockResolvedValue([
      { id: 'u1', plan: 'pro', subscriptionStatus: 'active' },
      { id: 'u2', plan: 'free', subscriptionStatus: null },
      { id: 'owner', plan: 'team', subscriptionStatus: 'active' },
    ]);
    m.teamsFindMany.mockResolvedValue([{ id: 't1', ownerId: 'owner' }]);
    m.teamMembersFindMany.mockResolvedValue([{ teamId: 't1', userId: 'u2', role: 'member' }]);
  });

  it('个人 key：tenantId=userId、role=owner、quotaOwnerId=userId、plan 取本人', async () => {
    const { resolveApiKeyIdentities } = await import('@/lib/api-key-identity');
    const r = (await resolveApiKeyIdentities([personal], NOW)).get('k1');
    expect(r).toEqual({ valid: true, apiKeyId: 'k1', userId: 'u1', tenantId: 'u1', teamId: null, quotaOwnerId: 'u1', role: 'owner', plan: 'pro', subscriptionStatus: 'active' });
  });
  it('团队 key：tenantId=teamId、role=成员角色、quotaOwnerId=owner、plan 取 owner', async () => {
    const { resolveApiKeyIdentities } = await import('@/lib/api-key-identity');
    const r = (await resolveApiKeyIdentities([teamKey], NOW)).get('k2');
    expect(r).toEqual({ valid: true, apiKeyId: 'k2', userId: 'u2', tenantId: 't1', teamId: 't1', quotaOwnerId: 'owner', role: 'member', plan: 'team', subscriptionStatus: 'active' });
  });
  it('已吊销 / 已过期 优先于一切查询', async () => {
    const { resolveApiKeyIdentities } = await import('@/lib/api-key-identity');
    const revoked = { ...teamKey, id: 'k3', revokedAt: new Date('2026-01-01T00:00:00Z') };
    const expired = { ...teamKey, id: 'k4', expiresAt: new Date('2026-01-01T00:00:00Z') };
    const r = await resolveApiKeyIdentities([revoked, expired], NOW);
    expect(r.get('k3')).toEqual({ valid: false, reason: 'revoked', revokedAt: revoked.revokedAt });
    expect(r.get('k4')).toEqual({ valid: false, reason: 'expired', expiredAt: expired.expiresAt });
  });
  it('团队不存在 → team_not_found；无 membership → membership_revoked', async () => {
    const { resolveApiKeyIdentities } = await import('@/lib/api-key-identity');
    m.teamsFindMany.mockResolvedValue([]);
    expect((await resolveApiKeyIdentities([teamKey], NOW)).get('k2')).toEqual({ valid: false, reason: 'team_not_found' });
    m.teamsFindMany.mockResolvedValue([{ id: 't1', ownerId: 'owner' }]);
    m.teamMembersFindMany.mockResolvedValue([]);
    expect((await resolveApiKeyIdentities([teamKey], NOW)).get('k2')).toEqual({ valid: false, reason: 'membership_revoked' });
  });
  it('持有者或 owner 用户不存在 → orphan_key', async () => {
    const { resolveApiKeyIdentities } = await import('@/lib/api-key-identity');
    m.usersFindMany.mockResolvedValue([{ id: 'u2', plan: 'free', subscriptionStatus: null }]);
    expect((await resolveApiKeyIdentities([personal], NOW)).get('k1')).toEqual({ valid: false, reason: 'orphan_key' });
    expect((await resolveApiKeyIdentities([teamKey], NOW)).get('k2')).toEqual({ valid: false, reason: 'orphan_key' });
  });
  it('批量：只查一次 users/teams/teamMembers；空输入不查库', async () => {
    const { resolveApiKeyIdentities } = await import('@/lib/api-key-identity');
    await resolveApiKeyIdentities([personal, teamKey], NOW);
    expect(m.usersFindMany).toHaveBeenCalledTimes(1);
    expect(m.teamsFindMany).toHaveBeenCalledTimes(1);
    expect(m.teamMembersFindMany).toHaveBeenCalledTimes(1);
    Object.values(m).forEach((f) => f.mockClear());
    expect((await resolveApiKeyIdentities([], NOW)).size).toBe(0);
    expect(m.usersFindMany).not.toHaveBeenCalled();
  });
});

describe('resolveApiKeyIdentity', () => {
  it('按 hash 找不到 key → not_found；找到则委托批量解析', async () => {
    const { resolveApiKeyIdentity } = await import('@/lib/api-key-identity');
    m.apiKeysFindFirst.mockResolvedValue(undefined);
    expect(await resolveApiKeyIdentity('a'.repeat(64), NOW)).toEqual({ valid: false, reason: 'not_found' });
    m.apiKeysFindFirst.mockResolvedValue(personal);
    m.usersFindMany.mockResolvedValue([{ id: 'u1', plan: 'pro', subscriptionStatus: 'active' }]);
    m.teamsFindMany.mockResolvedValue([]);
    m.teamMembersFindMany.mockResolvedValue([]);
    expect((await resolveApiKeyIdentity('a'.repeat(64), NOW)).valid).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run --project saas src/__tests__/lib/api-key-identity.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/lib/api-key-identity.ts
/**
 * API key → 身份 的唯一解析器（ADR 0015 §2）。
 *
 * 个人 key（teamId 为空）：tenantId = userId，role = owner，quotaOwnerId = userId，套餐取本人。
 * 团队 key：tenantId = teamId，role = TeamMember.role（现查，成员被移出即失效），
 *          quotaOwnerId = Team.ownerId，套餐取 owner。
 * verify 路由、snapshot 推送、snapshot/full、validateApiKey 都只能经由这里拿身份。
 */
import { db, apiKeys, users, teams, teamMembers } from '@/lib/prisma';
import { eq, inArray } from 'drizzle-orm';
import { SOLO_TENANT_ROLE, type TeamRole } from '@/lib/team-permissions';
import type { Plan } from '@/db/schema';

export type ApiKeyRow = {
  id: string;
  userId: string;
  teamId: string | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
};

export type ApiKeyIdentity =
  | {
      valid: true;
      apiKeyId: string;
      userId: string;
      tenantId: string;
      teamId: string | null;
      quotaOwnerId: string;
      role: TeamRole;
      plan: Plan;
      subscriptionStatus: string | null;
    }
  | {
      valid: false;
      reason: 'not_found' | 'revoked' | 'expired' | 'orphan_key' | 'team_not_found' | 'membership_revoked';
      revokedAt?: Date;
      expiredAt?: Date;
    };

/** 解析所需的 ApiKey 列，供各调用方的查询复用，避免漏列。 */
export const API_KEY_IDENTITY_COLUMNS = {
  id: true,
  userId: true,
  teamId: true,
  revokedAt: true,
  expiresAt: true,
} as const;

type UserInfo = { id: string; plan: Plan; subscriptionStatus: string | null };

export async function resolveApiKeyIdentity(keyHash: string, now: Date = new Date()): Promise<ApiKeyIdentity> {
  const key = await db.query.apiKeys.findFirst({
    where: eq(apiKeys.key, keyHash),
    columns: API_KEY_IDENTITY_COLUMNS,
  });
  if (!key) return { valid: false, reason: 'not_found' };
  const map = await resolveApiKeyIdentities([key], now);
  return map.get(key.id) ?? { valid: false, reason: 'not_found' };
}

export async function resolveApiKeyIdentities(keys: ApiKeyRow[], now: Date = new Date()): Promise<Map<string, ApiKeyIdentity>> {
  const out = new Map<string, ApiKeyIdentity>();
  // 先按 key 自身状态裁掉，不碰数据库
  const live: ApiKeyRow[] = [];
  for (const k of keys) {
    if (k.revokedAt) out.set(k.id, { valid: false, reason: 'revoked', revokedAt: k.revokedAt });
    else if (k.expiresAt && k.expiresAt.getTime() < now.getTime()) out.set(k.id, { valid: false, reason: 'expired', expiredAt: k.expiresAt });
    else live.push(k);
  }
  if (live.length === 0) return out;

  const teamIds = [...new Set(live.map((k) => k.teamId).filter((t): t is string => !!t))];
  const teamRows = teamIds.length
    ? await db.query.teams.findMany({ where: inArray(teams.id, teamIds), columns: { id: true, ownerId: true } })
    : [];
  const teamById = new Map(teamRows.map((t) => [t.id, t]));

  const holderIds = live.map((k) => k.userId);
  const memberRows = teamIds.length
    ? await db.query.teamMembers.findMany({
        where: inArray(teamMembers.teamId, teamIds),
        columns: { teamId: true, userId: true, role: true },
      })
    : [];
  const roleByMembership = new Map(memberRows.map((r) => [`${r.teamId}\u0000${r.userId}`, r.role as TeamRole]));

  const userIds = [...new Set([...holderIds, ...teamRows.map((t) => t.ownerId)])];
  const userRows = (await db.query.users.findMany({
    where: inArray(users.id, userIds),
    columns: { id: true, plan: true, subscriptionStatus: true },
  })) as UserInfo[];
  const userById = new Map(userRows.map((u) => [u.id, u]));

  for (const k of live) {
    out.set(k.id, identityOf(k, teamById, roleByMembership, userById));
  }
  return out;
}

function identityOf(
  k: ApiKeyRow,
  teamById: Map<string, { id: string; ownerId: string }>,
  roleByMembership: Map<string, TeamRole>,
  userById: Map<string, UserInfo>
): ApiKeyIdentity {
  const holder = userById.get(k.userId);
  if (!holder) return { valid: false, reason: 'orphan_key' };
  if (!k.teamId) {
    return { valid: true, apiKeyId: k.id, userId: k.userId, tenantId: k.userId, teamId: null, quotaOwnerId: k.userId,
      role: SOLO_TENANT_ROLE, plan: holder.plan, subscriptionStatus: holder.subscriptionStatus ?? null };
  }
  const team = teamById.get(k.teamId);
  if (!team) return { valid: false, reason: 'team_not_found' };
  const role = roleByMembership.get(`${k.teamId}\u0000${k.userId}`);
  if (!role) return { valid: false, reason: 'membership_revoked' };
  const owner = userById.get(team.ownerId);
  if (!owner) return { valid: false, reason: 'orphan_key' };
  return { valid: true, apiKeyId: k.id, userId: k.userId, tenantId: k.teamId, teamId: k.teamId, quotaOwnerId: team.ownerId,
    role, plan: owner.plan, subscriptionStatus: owner.subscriptionStatus ?? null };
}
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm exec vitest run --project saas src/__tests__/lib/api-key-identity.test.ts && pnpm exec tsc --noEmit -p tsconfig.json && pnpm lint`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/api-key-identity.ts src/__tests__/lib/api-key-identity.test.ts
git commit -m "feat(api-keys): key 身份解析器——个人/团队 key 的租户、角色与配额归属（ADR 0015 §2）"
```

---

### Task 3: verify 路由、snapshot 推送、snapshot/full 改用解析器（aster-cloud）

**Files:**
- Modify: `src/app/api/internal/apikey/verify/route.ts:48-104`
- Modify: `src/lib/snapshot-pusher.ts:73-125`（`pushApiKeySnapshot`）
- Modify: `src/app/api/internal/snapshot/full/route.ts:83-113`
- Test: `src/__tests__/app/api/internal/apikey-verify-route.test.ts`、`src/__tests__/lib/snapshot-pusher.test.ts`、`src/__tests__/app/api/internal/snapshot-full-route.test.ts`、`src/__tests__/app/api/internal/fail-closed-all-routes.test.ts`

**Interfaces:**
- Consumes: Task 2 `resolveApiKeyIdentity`、`resolveApiKeyIdentities`、`API_KEY_IDENTITY_COLUMNS`。
- Produces（对 aster-api 的线上契约）：
  - verify 成功：`{ valid: true, apiKeyId, userId, tenantId, quotaOwnerId, plan, subscriptionStatus, role }`；失败：`{ valid: false, reason, revokedAt?: ISO, expiredAt?: ISO }`，`reason` 新增 `team_not_found` / `membership_revoked`。
  - snapshot 推送体与 snapshot/full 每项：`{ keyHash?, valid, apiKeyId, userId, tenantId, quotaOwnerId, role, plan, revokedAtEpochMs }`；无效项 `{ valid: false, reason, revokedAtEpochMs? }`。

- [ ] **Step 1: 写失败测试（verify 成功路径，含 Review Focus 1）**

在 `apikey-verify-route.test.ts` 中把 `@/lib/prisma` mock 换成解析器 mock（路由不再直接查库）：

```ts
const { mockResolve } = vi.hoisted(() => ({ mockResolve: vi.fn() }));
vi.mock('@/lib/api-key-identity', () => ({ resolveApiKeyIdentity: mockResolve }));
```

并删除原 `@/lib/prisma` 与 `drizzle-orm` 的 mock（路由不再 import 它们）。新增用例：

```ts
describe('成功路径（ADR 0015）', () => {
  const HASH = 'a'.repeat(64);
  it('个人 key：tenantId=userId、role=owner、quotaOwnerId=userId', async () => {
    mockResolve.mockResolvedValue({ valid: true, apiKeyId: 'k1', userId: 'u1', tenantId: 'u1', quotaOwnerId: 'u1', role: 'owner', plan: 'pro', subscriptionStatus: 'active' });
    const { POST } = await import('@/app/api/internal/apikey/verify/route');
    const res = await POST(postKeyHash({ keyHash: HASH }));
    expect(await res.json()).toEqual({ valid: true, apiKeyId: 'k1', userId: 'u1', tenantId: 'u1', quotaOwnerId: 'u1', plan: 'pro', subscriptionStatus: 'active', role: 'owner' });
  });
  it('团队 key：tenantId=teamId、role=成员角色、quotaOwnerId=owner', async () => {
    mockResolve.mockResolvedValue({ valid: true, apiKeyId: 'k2', userId: 'u2', tenantId: 't1', quotaOwnerId: 'owner', role: 'member', plan: 'team', subscriptionStatus: 'active' });
    const { POST } = await import('@/app/api/internal/apikey/verify/route');
    const body = await (await POST(postKeyHash({ keyHash: HASH }))).json();
    expect(body).toMatchObject({ tenantId: 't1', userId: 'u2', role: 'member', quotaOwnerId: 'owner', plan: 'team' });
  });
  it('membership_revoked / revoked 带 ISO 时间', async () => {
    mockResolve.mockResolvedValue({ valid: false, reason: 'membership_revoked' });
    const { POST } = await import('@/app/api/internal/apikey/verify/route');
    expect(await (await POST(postKeyHash({ keyHash: HASH }))).json()).toEqual({ valid: false, reason: 'membership_revoked' });
    const at = new Date('2026-01-01T00:00:00Z');
    mockResolve.mockResolvedValue({ valid: false, reason: 'revoked', revokedAt: at });
    expect(await (await POST(postKeyHash({ keyHash: HASH }))).json()).toEqual({ valid: false, reason: 'revoked', revokedAt: at.toISOString() });
  });
});
```

`snapshot-pusher.test.ts` 的 `pushApiKeySnapshot` 块：mock `@/lib/api-key-identity`（`resolveApiKeyIdentities`）而不是 users 查询；断言推送体含 `quotaOwnerId` 且团队 key 时 `tenantId === 't1'`、`role === 'member'`；原「`tenantId==='u1'`、`role==='owner'`」用例改为个人 key 场景并保留。

`snapshot-full-route.test.ts`：mock `resolveApiKeyIdentities` 返回两条（一条 valid 团队 key、一条 `membership_revoked`），断言输出数组中前者带 `quotaOwnerId`、`tenantId: 't1'`，后者 `valid: false`。

`fail-closed-all-routes.test.ts`：其 `@/lib/prisma` mock 加 `teams: {}`、`teamMembers: {}` 已有；再加 `vi.mock('@/lib/api-key-identity', ...)` 返回 `{ valid: false, reason: 'not_found' }`（该测试只验签名失败路径）。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run --project saas src/__tests__/app/api/internal/apikey-verify-route.test.ts src/__tests__/lib/snapshot-pusher.test.ts src/__tests__/app/api/internal/snapshot-full-route.test.ts`
Expected: FAIL

- [ ] **Step 3: 改 verify 路由**

把 L48-104 替换为：

```ts
  const identity = await resolveApiKeyIdentity(body.keyHash);
  if (!identity.valid) {
    return NextResponse.json({
      valid: false,
      reason: identity.reason,
      ...(identity.revokedAt ? { revokedAt: identity.revokedAt.toISOString() } : {}),
      ...(identity.expiredAt ? { expiredAt: identity.expiredAt.toISOString() } : {}),
    });
  }
  // 字段顺序与旧响应一致，仅追加 quotaOwnerId；aster-api 按键读取，顺序无关
  return NextResponse.json({
    valid: true,
    apiKeyId: identity.apiKeyId,
    userId: identity.userId,
    tenantId: identity.tenantId,
    quotaOwnerId: identity.quotaOwnerId,
    plan: identity.plan,
    subscriptionStatus: identity.subscriptionStatus,
    role: identity.role,
  });
}
```

import 改为 `import { resolveApiKeyIdentity } from '@/lib/api-key-identity';`，删除 `db/apiKeys/users`、`eq`、`SOLO_TENANT_ROLE` 的 import；文件头注释更新为「个人 key 与团队 key 的映射见 ADR 0015 §2」。

- [ ] **Step 4: 改 `pushApiKeySnapshot`**

```ts
export async function pushApiKeySnapshot(keyHash: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/i.test(keyHash)) return;
  try {
    const key = await db.query.apiKeys.findFirst({
      where: eq(apiKeys.key, keyHash),
      columns: API_KEY_IDENTITY_COLUMNS,
    });
    const identity = key
      ? (await resolveApiKeyIdentities([key])).get(key.id) ?? { valid: false as const, reason: 'not_found' as const }
      : { valid: false as const, reason: 'not_found' as const };
    const bodyObj: Record<string, unknown> = identity.valid
      ? {
          valid: true,
          apiKeyId: identity.apiKeyId,
          userId: identity.userId,
          tenantId: identity.tenantId,
          quotaOwnerId: identity.quotaOwnerId,
          role: identity.role,
          plan: identity.plan,
          revokedAtEpochMs: null,
        }
      : {
          valid: false,
          reason: identity.reason,
          ...(identity.revokedAt ? { revokedAtEpochMs: identity.revokedAt.getTime() } : {}),
        };
    const path = `/api/internal/snapshot/apikey/${keyHash}`;
    await callAsterApi('POST', path, JSON.stringify(bodyObj), `push-apikey ${keyHash.slice(0, 8)}`);
  } catch (err) {
    console.warn(`[snapshot-pusher] pushApiKeySnapshot error:`, err);
  }
}
```

删除 `SOLO_TENANT_ROLE` 与 `users` 的 import（`pushUserSnapshot` 仍用 `users`——保留 `users`）。

- [ ] **Step 5: 改 snapshot/full**

```ts
  const userIds = userRows.map((u) => u.id);
  let keyRows: Array<{ id: string; userId: string; teamId: string | null; key: string; revokedAt: Date | null; expiresAt: Date | null }> = [];
  if (userIds.length > 0) {
    keyRows = await db.query.apiKeys.findMany({
      where: and(isNull(apiKeys.revokedAt), inArray(apiKeys.userId, userIds)),
      columns: { ...API_KEY_IDENTITY_COLUMNS, key: true },
    });
  }
  // 身份口径与 verify 路由同源（ADR 0015 §2）；成员已被移出的团队 key 以 valid:false 下发，让 warmup 顺手失效它
  const identities = await resolveApiKeyIdentities(keyRows);
  const apiKeySnapshots = keyRows.map((k) => {
    const id = identities.get(k.id);
    if (!id || !id.valid) {
      return { keyHash: k.key, valid: false, reason: id?.reason ?? 'not_found', revokedAtEpochMs: k.revokedAt?.getTime() ?? null };
    }
    return {
      keyHash: k.key,
      valid: true,
      apiKeyId: id.apiKeyId,
      userId: id.userId,
      tenantId: id.tenantId,
      quotaOwnerId: id.quotaOwnerId,
      role: id.role,
      plan: id.plan,
      revokedAtEpochMs: null,
    };
  });
```

删除 `SOLO_TENANT_ROLE` import 与 `userPlanMap`。

- [ ] **Step 6: 运行测试通过**

Run: `pnpm exec vitest run --project saas src/__tests__/app/api/internal src/__tests__/lib/snapshot-pusher.test.ts && pnpm exec tsc --noEmit -p tsconfig.json && pnpm lint`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/app/api/internal/apikey/verify/route.ts src/lib/snapshot-pusher.ts src/app/api/internal/snapshot/full/route.ts src/__tests__
git commit -m "feat(internal): verify/snapshot 走身份解析器，下发 quotaOwnerId 与团队租户（ADR 0015 §2-§3）"
```

---

### Task 4: key 创建/列表/吊销/校验与团队 key 助手（aster-cloud）

**Files:**
- Modify: `src/lib/api-keys.ts`
- Modify: `src/app/api/api-keys/route.ts`、`src/app/api/api-keys/[id]/route.ts`
- Test: `src/__tests__/lib/api-keys.test.ts`、`src/__tests__/api/api-keys.test.ts`

**Interfaces:**
- Consumes: Task 2 解析器；Task 3 `pushApiKeySnapshot`；`invalidateApiKeyCache`（`@/lib/plan-gate-client`）；`checkTeamAccess`（`@/lib/team-permissions`）；`hasFeatureAccess`（`@/lib/usage`）。
- Produces:

```ts
export async function createApiKey(userId: string, name: string, teamId: string | null = null): Promise<{ id; key; prefix; name; teamId: string | null; createdAt: Date }>;
export async function listApiKeys(userId: string): Promise<Array<{ id; name; prefix; teamId: string | null; teamName: string | null; lastUsedAt: Date | null; expiresAt: Date | null; createdAt: Date }>>;
export async function revokeApiKey(userId: string, keyId: string): Promise<boolean>;      // 成功后推送无效快照 + 失效 verify 缓存
export async function revokeTeamKeys(teamId: string, userId?: string): Promise<number>;    // 吊销团队（某成员）全部 key，返回条数
export async function refreshTeamKeySnapshots(teamId: string, userId?: string): Promise<number>; // 重推团队（某成员）全部活跃 key 快照，返回条数
export type ApiAuthResult = { success: true; userId: string; apiKeyId: string; teamId: string | null } | { success: false; error: string; status: number };
```

HTTP 契约：`POST /api/api-keys` 体 `{ name: string; teamId?: string }`；团队路径 403 `{ error: 'not_a_member' }` / `{ error: 'plan_no_api_access', upgrade: true }`；201 体含 `teamId`。个人路径的既有响应不变。

- [ ] **Step 1: 写失败测试**

`src/__tests__/lib/api-keys.test.ts`：其 `@/lib/prisma` mock 的 `apiKeys` 列表加 `teamId`；新增 mock `@/lib/api-key-identity`（`resolveApiKeyIdentity: mockResolve`）、`@/lib/snapshot-pusher`（`pushApiKeySnapshot: vi.fn()`）、`@/lib/plan-gate-client`（`invalidateApiKeyCache: vi.fn()`）、`@/lib/usage`（`hasFeatureAccess: vi.fn()`）。沿用该文件既有的 db 链式 mock（`insert().values().returning()`、`update().set().where().returning()`、`query.apiKeys.findMany`），下面以 `mockValues`、`mockReturning`、`mockFindMany` 指代这些链尾的 `vi.fn()`。用例：

```ts
it('createApiKey 带 teamId 落库并推送快照', async () => {
  mockReturning.mockResolvedValue([{ id: 'k9', prefix: 'abcdefgh', name: 'n', teamId: 't1', createdAt: new Date() }]);
  const { createApiKey } = await import('@/lib/api-keys');
  const r = await createApiKey('u2', 'n', 't1');
  expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u2', teamId: 't1' }));
  expect(r.teamId).toBe('t1');
  expect(pushApiKeySnapshot).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/));
});
it('createApiKey 不带 teamId 时 teamId 为 null（个人 key 不变）', async () => {
  mockReturning.mockResolvedValue([{ id: 'k1', prefix: 'abcdefgh', name: 'n', teamId: null, createdAt: new Date() }]);
  const { createApiKey } = await import('@/lib/api-keys');
  const r = await createApiKey('u1', 'n');
  expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', teamId: null }));
  expect(r.teamId).toBeNull();
});
it('revokeApiKey 成功后推送无效快照并失效缓存；未命中则都不调用', async () => {
  mockReturning.mockResolvedValueOnce([{ key: 'h'.repeat(64), userId: 'u1' }]);
  const { revokeApiKey } = await import('@/lib/api-keys');
  expect(await revokeApiKey('u1', 'k1')).toBe(true);
  expect(pushApiKeySnapshot).toHaveBeenCalledWith('h'.repeat(64));
  expect(invalidateApiKeyCache).toHaveBeenCalledWith('u1');
  vi.clearAllMocks();
  mockReturning.mockResolvedValueOnce([]);
  expect(await revokeApiKey('u1', 'nope')).toBe(false);
  expect(pushApiKeySnapshot).not.toHaveBeenCalled();
  expect(invalidateApiKeyCache).not.toHaveBeenCalled();
});
it('revokeTeamKeys(teamId, userId) 逐 key 推送，按用户去重失效缓存，返回条数', async () => {
  mockReturning.mockResolvedValueOnce([{ key: 'a'.repeat(64), userId: 'u2' }, { key: 'b'.repeat(64), userId: 'u2' }]);
  const { revokeTeamKeys } = await import('@/lib/api-keys');
  expect(await revokeTeamKeys('t1', 'u2')).toBe(2);
  expect(pushApiKeySnapshot).toHaveBeenCalledTimes(2);
  expect(invalidateApiKeyCache).toHaveBeenCalledTimes(1);
  expect(invalidateApiKeyCache).toHaveBeenCalledWith('u2');
});
it('refreshTeamKeySnapshots(teamId) 对每把活跃 key 推送一次，按用户失效缓存', async () => {
  mockFindMany.mockResolvedValueOnce([{ key: 'a'.repeat(64), userId: 'u2' }, { key: 'c'.repeat(64), userId: 'u3' }]);
  const { refreshTeamKeySnapshots } = await import('@/lib/api-keys');
  expect(await refreshTeamKeySnapshots('t1')).toBe(2);
  expect(pushApiKeySnapshot).toHaveBeenCalledTimes(2);
  expect(invalidateApiKeyCache).toHaveBeenCalledTimes(2);
});
it('validateApiKey：团队 key 以 quotaOwnerId 判断 apiAccess；membership_revoked → 无效', async () => {
  mockResolve.mockResolvedValue({ valid: true, apiKeyId: 'k2', userId: 'u2', tenantId: 't1', teamId: 't1', quotaOwnerId: 'owner', role: 'member', plan: 'team', subscriptionStatus: 'active' });
  hasFeatureAccess.mockResolvedValue(true);
  const { validateApiKey } = await import('@/lib/api-keys');
  expect(await validateApiKey('ak_' + 'f'.repeat(64))).toEqual({ valid: true, userId: 'u2', apiKeyId: 'k2', teamId: 't1' });
  expect(hasFeatureAccess).toHaveBeenCalledWith('owner', 'apiAccess');
  mockResolve.mockResolvedValue({ valid: false, reason: 'membership_revoked' });
  expect((await validateApiKey('ak_' + 'f'.repeat(64))).valid).toBe(false);
});
```

`src/__tests__/api/api-keys.test.ts`：把 `expect(mockCreateApiKey).toHaveBeenCalledWith('user-1', 'My Key')` 改为 `('user-1', 'My Key', null)`；新增：

```ts
it('POST 带 teamId：非成员 403 not_a_member', async () => {
  mockCheckTeamAccess.mockResolvedValue({ allowed: false, error: 'x', status: 403 });
  const res = await POST(jsonReq({ name: 'k', teamId: 't1' }));
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: 'not_a_member' });
  expect(mockCreateApiKey).not.toHaveBeenCalled();
});
it('POST 带 teamId：owner 套餐无 apiAccess → 403 plan_no_api_access', async () => {
  mockCheckTeamAccess.mockResolvedValue({ allowed: true, role: 'member', teamId: 't1' });
  mockTeamsFindFirst.mockResolvedValue({ ownerId: 'owner' });
  mockHasFeatureAccess.mockResolvedValue(false);
  const res = await POST(jsonReq({ name: 'k', teamId: 't1' }));
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: 'plan_no_api_access', upgrade: true });
  expect(mockHasFeatureAccess).toHaveBeenCalledWith('owner', 'apiAccess');
  expect(mockCreateApiKey).not.toHaveBeenCalled();
});
it('POST 带 teamId：成员且 owner 有 apiAccess → 201，createApiKey(uid, name, "t1")', async () => {
  mockCheckTeamAccess.mockResolvedValue({ allowed: true, role: 'member', teamId: 't1' });
  mockTeamsFindFirst.mockResolvedValue({ ownerId: 'owner' });
  mockHasFeatureAccess.mockResolvedValue(true);
  mockCreateApiKey.mockResolvedValue({ id: 'k9', key: 'ak_x', prefix: 'p', name: 'k', teamId: 't1', createdAt: new Date() });
  const res = await POST(jsonReq({ name: 'k', teamId: 't1' }));
  expect(res.status).toBe(201);
  expect(mockCreateApiKey).toHaveBeenCalledWith('user-1', 'k', 't1');
});
```

（该文件需新增 mock：`@/lib/team-permissions` 的 `checkTeamAccess`、`@/lib/prisma` 的 `db.query.teams.findFirst` 与 `teams: { id: 'teams.id' }`、`drizzle-orm` 的 `eq`；`jsonReq` 为该文件既有或新增的 JSON Request 构造助手。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run --project saas src/__tests__/lib/api-keys.test.ts src/__tests__/api/api-keys.test.ts`
Expected: FAIL

- [ ] **Step 3: 改 `src/lib/api-keys.ts`**

```ts
import { randomBytes, createHash } from 'crypto';
import { db, apiKeys, teams } from '@/lib/prisma';
import { eq, desc, isNull, and } from 'drizzle-orm';
import { resolveApiKeyIdentity, type ApiKeyIdentity } from '@/lib/api-key-identity';
import { pushApiKeySnapshot } from '@/lib/snapshot-pusher';
import { invalidateApiKeyCache } from '@/lib/plan-gate-client';
import { hasFeatureAccess } from '@/lib/usage';

// createApiKey：
export async function createApiKey(userId: string, name: string, teamId: string | null = null) {
  const { key, hash, prefix } = generateApiKey();
  const [apiKey] = await db.insert(apiKeys).values({ id: crypto.randomUUID(), userId, teamId, name, key: hash, prefix }).returning();
  // 让 aster-api 立刻拿到身份快照，而不是等 1 h TTL 或下一次 verify（ADR 0015 §5）
  await pushApiKeySnapshot(hash);
  return { id: apiKey.id, key, prefix: apiKey.prefix, name: apiKey.name, teamId: apiKey.teamId ?? null, createdAt: apiKey.createdAt };
}

// validateApiKey：
export async function validateApiKey(key: string): Promise<{ valid: boolean; userId?: string; apiKeyId?: string; teamId?: string | null; error?: string }> {
  if (!key || !key.startsWith('ak_')) return { valid: false, error: 'Invalid API key format' };
  const identity = await resolveApiKeyIdentity(hashApiKey(key));
  if (!identity.valid) return { valid: false, error: INVALID_KEY_MESSAGES[identity.reason] };
  // 套餐门槛看配额 owner（团队 key 即 team owner），与 POST /api/api-keys 同口径
  if (!(await hasFeatureAccess(identity.quotaOwnerId, 'apiAccess'))) {
    return { valid: false, error: 'API access requires a Pro or Team subscription' };
  }
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, identity.apiKeyId));
  return { valid: true, userId: identity.userId, apiKeyId: identity.apiKeyId, teamId: identity.teamId };
}
const INVALID_KEY_MESSAGES: Record<Exclude<ApiKeyIdentity, { valid: true }>['reason'], string> = {
  not_found: 'Invalid API key',
  revoked: 'API key has been revoked',
  expired: 'API key has expired',
  orphan_key: 'Invalid API key',
  team_not_found: 'API key team no longer exists',
  membership_revoked: 'API key holder is no longer a member of the team',
};

// listApiKeys：
export async function listApiKeys(userId: string) {
  const keys = await db.query.apiKeys.findMany({
    where: and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)),
    columns: { id: true, name: true, prefix: true, teamId: true, lastUsedAt: true, expiresAt: true, createdAt: true },
    with: { team: { columns: { name: true } } },
    orderBy: [desc(apiKeys.createdAt)],
  });
  return keys.map(({ team, ...k }) => ({ ...k, teamId: k.teamId ?? null, teamName: team?.name ?? null }));
}

// revokeApiKey：
export async function revokeApiKey(userId: string, keyId: string): Promise<boolean> {
  const result = await db.update(apiKeys).set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .returning({ key: apiKeys.key, userId: apiKeys.userId });
  if (result.length === 0) return false;
  await notifyRevoked(result);
  return true;
}

export async function revokeTeamKeys(teamId: string, userId?: string): Promise<number> {
  const cond = [eq(apiKeys.teamId, teamId), isNull(apiKeys.revokedAt)];
  if (userId) cond.push(eq(apiKeys.userId, userId));
  const result = await db.update(apiKeys).set({ revokedAt: new Date() }).where(and(...cond))
    .returning({ key: apiKeys.key, userId: apiKeys.userId });
  await notifyRevoked(result);
  return result.length;
}

export async function refreshTeamKeySnapshots(teamId: string, userId?: string): Promise<number> {
  const cond = [eq(apiKeys.teamId, teamId), isNull(apiKeys.revokedAt)];
  if (userId) cond.push(eq(apiKeys.userId, userId));
  const rows = await db.query.apiKeys.findMany({ where: and(...cond), columns: { key: true, userId: true } });
  await notifyChanged(rows);
  return rows.length;
}

/** 吊销后：逐 key 推无效快照，按用户去重失效 aster-api 的 verify 缓存。推送失败只记日志。 */
async function notifyRevoked(rows: Array<{ key: string; userId: string }>) { await notifyChanged(rows); }
async function notifyChanged(rows: Array<{ key: string; userId: string }>) {
  for (const r of rows) await pushApiKeySnapshot(r.key);
  for (const uid of new Set(rows.map((r) => r.userId))) await invalidateApiKeyCache(uid);
}
```

`ApiAuthResult` 成功分支加 `teamId: string | null`；`authenticateApiRequest` 返回 `teamId: validation.teamId ?? null`。`teams` 仅为 relation 推断引入时若 lint 报未使用则删掉该 import。

- [ ] **Step 4: 改路由**

`src/app/api/api-keys/route.ts` POST：

```ts
    const { name, teamId } = (await req.json()) as { name?: unknown; teamId?: unknown };
    if (!name || typeof name !== 'string') return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    if (teamId !== undefined && teamId !== null && typeof teamId !== 'string') {
      return NextResponse.json({ error: 'teamId must be a string' }, { status: 400 });
    }
    if (typeof teamId === 'string') {
      // 团队 key：调用者须为活跃成员；套餐门槛看 team owner（ADR 0015 §5）
      const access = await checkTeamAccess(session.user.id, teamId);
      const team = access.allowed ? await db.query.teams.findFirst({ where: eq(teams.id, teamId), columns: { ownerId: true } }) : null;
      if (!access.allowed || !team) return NextResponse.json({ error: 'not_a_member' }, { status: 403 });
      if (!(await hasFeatureAccess(team.ownerId, 'apiAccess'))) {
        return NextResponse.json({ error: 'plan_no_api_access', upgrade: true }, { status: 403 });
      }
      return NextResponse.json(await createApiKey(session.user.id, name, teamId), { status: 201 });
    }
    // 个人 key：原有流程不变
    const hasAccess = await hasFeatureAccess(session.user.id, 'apiAccess');
    if (!hasAccess) return NextResponse.json({ error: 'API access requires Pro or Team subscription', upgrade: true }, { status: 403 });
    return NextResponse.json(await createApiKey(session.user.id, name, null), { status: 201 });
```

（个人路径原本先查套餐再读 body；改为先读 body 以便分流。个人路径的错误体与状态码保持不变。）`[id]/route.ts` 不改（吊销的通知在 lib 内完成）。

- [ ] **Step 5: 运行测试通过**

Run: `pnpm exec vitest run --project saas src/__tests__/lib/api-keys.test.ts src/__tests__/api/api-keys.test.ts src/__tests__/api/v1-policies.test.ts && pnpm exec tsc --noEmit -p tsconfig.json && pnpm lint`
Expected: PASS（`v1-policies.test.ts` 依赖 `authenticateApiRequest`，确认未破坏）

- [ ] **Step 6: 提交**

```bash
git add src/lib/api-keys.ts src/app/api/api-keys src/__tests__
git commit -m "feat(api-keys): 团队作用域 key 的创建/列表/校验，吊销与成员变动的快照通知（ADR 0015 §5）"
```

---

### Task 5: 团队生命周期钩子与 owner 套餐 fan-out（aster-cloud）

**Files:**
- Modify: `src/app/api/teams/[teamId]/members/[memberId]/route.ts`（PUT L69-73 之后、DELETE L153 之后）
- Modify: `src/app/api/teams/[teamId]/transfer/route.ts`（事务之后）
- Modify: `src/app/api/teams/[teamId]/route.ts`（DELETE 事务之前）
- Modify: `src/lib/plan-gate-client.ts`（新增 `invalidatePlanCacheForOwner`）
- Modify: `src/lib/snapshot-pusher.ts`（`pushUserSnapshot` 末尾调用 fan-out）
- Test: `src/__tests__/api/team-lifecycle-keys.test.ts`（新）、`src/__tests__/lib/plan-gate-client-invalidate.test.ts`、`src/__tests__/lib/snapshot-pusher.test.ts`

**Interfaces:**
- Consumes: Task 4 `revokeTeamKeys`、`refreshTeamKeySnapshots`；`invalidatePlanCache`。
- Produces: `export async function invalidatePlanCacheForOwner(ownerId: string): Promise<void>`（查 `teams.ownerId = ownerId`，逐团队 `invalidatePlanCache(teamId)`）。

- [ ] **Step 1: 写失败测试**

`team-lifecycle-keys.test.ts`：mock `@/lib/auth`（session user `u-admin`）、`@/lib/team-permissions`（`checkTeamAccess` → owner、`checkTeamPermission` → allowed、`canRemoveMember`/`canChangeRole` → allowed）、`@/lib/prisma`（`teamMembers.findFirst` 返回 `{ id: 'm1', teamId: 't1', userId: 'u2', role: 'member' }`，`db.update/delete/transaction` 为空 mock）、`@/lib/api-keys`（`revokeTeamKeys`、`refreshTeamKeySnapshots` 为 `vi.fn()`）、`@/lib/plan-gate-client`（`invalidatePlanCache`）。用例：

```ts
const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
const json = (method: string, body: unknown) => new Request('http://cloud.test/x', { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

it('DELETE 成员 → revokeTeamKeys("t1","u2")（用 targetMember.userId，不是 memberId）', async () => {
  const { DELETE } = await import('@/app/api/teams/[teamId]/members/[memberId]/route');
  const res = await DELETE(new Request('http://cloud.test/x', { method: 'DELETE' }), params({ teamId: 't1', memberId: 'm1' }));
  expect(res.status).toBe(200);
  expect(revokeTeamKeys).toHaveBeenCalledWith('t1', 'u2');
});
it('PUT 角色 → refreshTeamKeySnapshots("t1","u2")', async () => {
  const { PUT } = await import('@/app/api/teams/[teamId]/members/[memberId]/route');
  const res = await PUT(json('PUT', { role: 'admin' }), params({ teamId: 't1', memberId: 'm1' }));
  expect(res.status).toBe(200);
  expect(refreshTeamKeySnapshots).toHaveBeenCalledWith('t1', 'u2');
});
it('POST transfer → refreshTeamKeySnapshots("t1") 且 invalidatePlanCache("t1")', async () => {
  const { POST } = await import('@/app/api/teams/[teamId]/transfer/route');
  const res = await POST(json('POST', { newOwnerId: 'u2' }), params({ teamId: 't1' }));
  expect(res.status).toBe(200);
  expect(refreshTeamKeySnapshots).toHaveBeenCalledWith('t1');
  expect(invalidatePlanCache).toHaveBeenCalledWith('t1');
});
it('DELETE 团队 → revokeTeamKeys("t1") 在事务之前被调用', async () => {
  const order: string[] = [];
  revokeTeamKeys.mockImplementation(async () => { order.push('revoke'); return 0; });
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => { order.push('tx'); await fn(txStub); });
  const { DELETE } = await import('@/app/api/teams/[teamId]/route');
  const res = await DELETE(new Request('http://cloud.test/x', { method: 'DELETE' }), params({ teamId: 't1' }));
  expect(res.status).toBe(200);
  expect(order).toEqual(['revoke', 'tx']);
});
```

（`txStub` 是 `{ update: () => ({ set: () => ({ where: vi.fn() }) }), delete: () => ({ where: vi.fn() }) }`；transfer 路由里的 session user 是原 owner `u-admin`，`teamMembers.findFirst` 对 `newOwnerId` 返回成员行。）

`snapshot-pusher.test.ts` 的 `pushUserSnapshot` 块：mock `teams.findMany` 返回 `[{ id: 't1' }, { id: 't2' }]`，mock `@/lib/plan-gate-client`，断言推送用户快照后 `invalidatePlanCache` 被调用 2 次（t1、t2）。

`plan-gate-client-invalidate.test.ts`：新增 `invalidatePlanCacheForOwner('owner')` 对 `teams.findMany` 返回的每个团队发 DELETE。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run --project saas src/__tests__/api/team-lifecycle-keys.test.ts src/__tests__/lib/plan-gate-client-invalidate.test.ts src/__tests__/lib/snapshot-pusher.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`plan-gate-client.ts`：

```ts
/** owner 套餐变化时，其名下每个团队在 aster-api 的 plan 缓存都要失效（团队 key 的限速按 owner 套餐）。 */
export async function invalidatePlanCacheForOwner(ownerId: string): Promise<void> {
  if (!ownerId) return;
  const owned = await db.query.teams.findMany({ where: eq(teams.ownerId, ownerId), columns: { id: true } });
  for (const t of owned) await invalidatePlanCache(t.id);
}
```

（需 `import { db, teams } from '@/lib/prisma'; import { eq } from 'drizzle-orm';`。）

`snapshot-pusher.ts` `pushUserSnapshot`：在成功推送用户快照之后、try 块末尾加 `await invalidatePlanCacheForOwner(userId);`（import 自 `@/lib/plan-gate-client`；该模块与 `plan-gate-client` 无循环依赖——`plan-gate-client` 不 import `snapshot-pusher`）。

`members/[memberId]/route.ts`：PUT 更新角色后 `await refreshTeamKeySnapshots(teamId, targetMember.userId);`；DELETE 删除成员后 `await revokeTeamKeys(teamId, targetMember.userId);`。
`transfer/route.ts`：事务后 `await refreshTeamKeySnapshots(teamId); await invalidatePlanCache(teamId);`。
`[teamId]/route.ts` DELETE：事务前 `await revokeTeamKeys(teamId);`（吊销要先查到 key，必须在删团队之前；吊销是幂等的，事务失败只会多一次无害吊销）。

每处加一行中文注释说明意图（ADR 0015 §5 钩子表）。

- [ ] **Step 4: 运行测试通过**

Run: `pnpm exec vitest run --project saas src/__tests__/api src/__tests__/lib && pnpm exec tsc --noEmit -p tsconfig.json && pnpm lint`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/app/api/teams src/lib/plan-gate-client.ts src/lib/snapshot-pusher.ts src/__tests__
git commit -m "feat(teams): 成员/所有权/团队变化时吊销或重推团队 key，owner 套餐变化失效团队 plan 缓存（ADR 0015 §5）"
```

---

### Task 6: owner 共享配额池（aster-cloud）

**Files:**
- Create: `src/lib/api-quota-pool.ts`
- Modify: `src/app/api/internal/api/precheck/route.ts:84-94`、`src/app/api/internal/api/usage/route.ts:39-100`、`src/app/api/user/api-usage/route.ts:61-71`、`src/app/api/cron/api-quota-alerts/route.ts:48-65`
- Test: `src/__tests__/lib/api-quota-pool.test.ts`（新）、`src/__tests__/app/api/internal/precheck-route.test.ts`（新）、`src/__tests__/app/api/internal/usage-route.test.ts`

**Interfaces:**
- Produces:

```ts
export function currentPeriodMonth(now?: Date): string;                 // 'YYYY-MM'（UTC）
export function ownerPoolCondition(ownerId: string): SQL;               // quotaOwnerId = O OR (quotaOwnerId IS NULL AND userId = O)
export async function countOwnerPoolUsage(ownerId: string, periodMonth: string): Promise<number>; // status = 'success'
```
- usage POST 体新增 `quotaOwnerId?: string`（缺省 = `userId`）。

- [ ] **Step 1: 写失败测试**

`api-quota-pool.test.ts`（mock `drizzle-orm` 算子为结构对象，mock `db.select().from().where()` 链返回 `[{ c: 7 }]`）：

```ts
const { mockWhere } = vi.hoisted(() => ({ mockWhere: vi.fn() }));
vi.mock('@/lib/prisma', () => ({
  db: { select: () => ({ from: () => ({ where: mockWhere }) }) },
  apiCallRecords: { quotaOwnerId: 'quotaOwnerId', userId: 'userId', periodMonth: 'periodMonth', status: 'status' },
}));
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...c: unknown[]) => ({ op: 'and', c }),
  or: (...c: unknown[]) => ({ op: 'or', c }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  sql: Object.assign(() => ({ op: 'sql' }), { raw: () => ({ op: 'sql' }) }),
}));

it('ownerPoolCondition = or(eq(quotaOwnerId,O), and(isNull(quotaOwnerId), eq(userId,O)))', async () => {
  const { ownerPoolCondition } = await import('@/lib/api-quota-pool');
  expect(ownerPoolCondition('O')).toEqual({ op: 'or', c: [
    { op: 'eq', col: 'quotaOwnerId', val: 'O' },
    { op: 'and', c: [{ op: 'isNull', col: 'quotaOwnerId' }, { op: 'eq', col: 'userId', val: 'O' }] },
  ] });
});
it('countOwnerPoolUsage 以 period 与 status=success 过滤并返回 count', async () => {
  const { countOwnerPoolUsage, ownerPoolCondition } = await import('@/lib/api-quota-pool');
  mockWhere.mockResolvedValue([{ c: 7 }]);
  expect(await countOwnerPoolUsage('O', '2026-10')).toBe(7);
  expect(mockWhere).toHaveBeenCalledWith({ op: 'and', c: [ownerPoolCondition('O'), { op: 'eq', col: 'periodMonth', val: '2026-10' }, { op: 'eq', col: 'status', val: 'success' }] });
  mockWhere.mockResolvedValue([]);
  expect(await countOwnerPoolUsage('O', '2026-10')).toBe(0);
});
it('currentPeriodMonth 用 UTC', async () => {
  const { currentPeriodMonth } = await import('@/lib/api-quota-pool');
  expect(currentPeriodMonth(new Date('2026-10-31T23:30:00Z'))).toBe('2026-10');
  expect(currentPeriodMonth(new Date('2026-11-01T00:30:00+08:00'))).toBe('2026-10');
  expect(currentPeriodMonth(new Date('2026-01-05T00:00:00Z'))).toBe('2026-01');
});
```

`precheck-route.test.ts`（照 `usage-route.test.ts` 的签名/HMAC 工具）：mock `@/lib/api-quota-pool` 的 `countOwnerPoolUsage` → 42；owner `plan: 'pro'` → 响应 `monthlyUsed: 42`；owner `plan: 'free'` → `apiCallsLimit: 0`（Review Focus 3）；未知用户 → 既有 free 响应。

`usage-route.test.ts` 新增：POST 不带 `quotaOwnerId` → insert 的 `quotaOwnerId === body.userId`（Review Focus 4）；带 `quotaOwnerId: 'owner'` → 原样落库；GET 走 `countOwnerPoolUsage`。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run --project saas src/__tests__/lib/api-quota-pool.test.ts src/__tests__/app/api/internal/precheck-route.test.ts src/__tests__/app/api/internal/usage-route.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/lib/api-quota-pool.ts
/**
 * owner 共享配额池（ADR 0015 §4）：owner 个人 key 的调用 + owner 名下团队 key 的调用共用一个月度池。
 * 旧行 quotaOwnerId 为 NULL，按持有者归池（COALESCE 语义），不做回填。
 */
import { db, apiCallRecords } from '@/lib/prisma';
import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm';

export function currentPeriodMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function ownerPoolCondition(ownerId: string): SQL {
  return or(
    eq(apiCallRecords.quotaOwnerId, ownerId),
    and(isNull(apiCallRecords.quotaOwnerId), eq(apiCallRecords.userId, ownerId))
  )!;
}

export async function countOwnerPoolUsage(ownerId: string, periodMonth: string): Promise<number> {
  const r = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(apiCallRecords)
    .where(and(ownerPoolCondition(ownerId), eq(apiCallRecords.periodMonth, periodMonth), eq(apiCallRecords.status, 'success')));
  return r[0]?.c ?? 0;
}
```

precheck：L85-94 的计数替换为 `const monthlyUsed = await countOwnerPoolUsage(userId, period);`，`period` 用 `currentPeriodMonth()`（删除本地 `currentPeriod`）。注释：「`userId` 参数语义是配额 owner（ADR 0015 §4）」。
usage GET：计数替换为 `countOwnerPoolUsage(userId, periodMonth)`。usage POST：body 类型加 `quotaOwnerId?: string`，insert 加 `quotaOwnerId: body.quotaOwnerId ?? body.userId`。
api-usage：计数替换为 `countOwnerPoolUsage(userId, period)`。
api-quota-alerts：`groupBy` 改为按 `sql<string>\`coalesce(${apiCallRecords.quotaOwnerId}, ${apiCallRecords.userId})\`` 分组（select 别名 `userId` 保持，后续按 owner 查 users 发告警不变）。

- [ ] **Step 4: 运行测试通过**

Run: `pnpm exec vitest run --project saas src/__tests__/lib src/__tests__/app/api/internal && pnpm exec tsc --noEmit -p tsconfig.json && pnpm lint`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/api-quota-pool.ts src/app/api/internal/api src/app/api/user/api-usage/route.ts src/app/api/cron/api-quota-alerts/route.ts src/__tests__
git commit -m "feat(quota): API 调用量按配额 owner 共享池统计，usage 落 quotaOwnerId（ADR 0015 §4）"
```

---

### Task 7: UI 与文案（aster-cloud）

**Files:**
- Modify: `src/app/[locale]/(dashboard)/settings/api-keys/page.tsx`
- Modify: `src/app/[locale]/(dashboard)/settings/api-keys/api-keys-content.tsx`
- Modify: `src/i18n/demo-supplement.ts`（en L29-560、zh L561-1067、de L1068-1576、hi L1577-2081 四块的 `settings:` 子树）
- Test: `src/__tests__/components/api-keys-content.test.tsx`（新，jsdom）

**Interfaces:**
- Consumes: Task 4 `listApiKeys` 的 `teamId`/`teamName`；`POST /api/api-keys` 的 `teamId`。
- Produces: `ApiKeysContentProps` 增加 `teams: Array<{ id: string; name: string }>`；`Translations` 增加 `scope`、`scopePersonal`、`scopeTeam`、`scopeColumn`、`errorNotMember`、`errorPlanNoApiAccess`；`ApiKey` 增加 `teamId: string | null`、`teamName: string | null`。

- [ ] **Step 1: 写失败测试**

```tsx
// src/__tests__/components/api-keys-content.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
it('选择团队作用域后 POST 体带 teamId，列表显示团队名', async () => {
  global.fetch = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ key: 'ak_x', id: 'k9' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ([{ id: 'k9', name: 'n', prefix: 'abcdefgh', teamId: 't1', teamName: 'Team One', lastUsedAt: null, createdAt: new Date().toISOString(), expiresAt: null }]) }) as never;
  render(<ApiKeysContent initialApiKeys={[]} teams={[{ id: 't1', name: 'Team One' }]} translations={T} locale="en" />);
  fireEvent.change(screen.getByLabelText(T.scope), { target: { value: 't1' } });
  fireEvent.change(screen.getByLabelText(T.createNew), { target: { value: 'n' } });
  fireEvent.submit(screen.getByRole('button', { name: T.createKey }).closest('form')!);
  await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/api-keys', expect.objectContaining({ body: JSON.stringify({ name: 'n', teamId: 't1' }) })));
  expect(await screen.findByText('Team One')).toBeInTheDocument();
});
it('未选团队时 POST 体不带 teamId；个人 key 行显示 scopePersonal', async () => {
  global.fetch = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ key: 'ak_x', id: 'k1' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ([{ id: 'k1', name: 'n', prefix: 'abcdefgh', teamId: null, teamName: null, lastUsedAt: null, createdAt: new Date().toISOString(), expiresAt: null }]) }) as never;
  render(<ApiKeysContent initialApiKeys={[]} teams={[{ id: 't1', name: 'Team One' }]} translations={T} locale="en" />);
  fireEvent.change(screen.getByLabelText(T.createNew), { target: { value: 'n' } });
  fireEvent.submit(screen.getByRole('button', { name: T.createKey }).closest('form')!);
  await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/api-keys', expect.objectContaining({ body: JSON.stringify({ name: 'n' }) })));
  expect((await screen.findAllByText(T.scopePersonal)).length).toBeGreaterThan(0);
});
it('403 not_a_member → 显示 errorNotMember 文案', async () => {
  global.fetch = vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'not_a_member' }) }) as never;
  render(<ApiKeysContent initialApiKeys={[]} teams={[{ id: 't1', name: 'Team One' }]} translations={T} locale="en" />);
  fireEvent.change(screen.getByLabelText(T.scope), { target: { value: 't1' } });
  fireEvent.change(screen.getByLabelText(T.createNew), { target: { value: 'n' } });
  fireEvent.submit(screen.getByRole('button', { name: T.createKey }).closest('form')!);
  expect(await screen.findByText(T.errorNotMember)).toBeInTheDocument();
});
```

（`T` 为含全部必填键的测试翻译对象；检查现有组件测试目录与 testing-library 配置，沿用其 render 方式。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run --project saas src/__tests__/components/api-keys-content.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

`page.tsx`：

```ts
  // 用户所在团队，供创建表单选择作用域（与 GET /api/teams 同一查询口径）
  const memberships = await db.query.teamMembers.findMany({
    where: eq(teamMembers.userId, session.user.id),
    with: { team: { columns: { id: true, name: true } } },
  });
  const teams = memberships.map((m) => ({ id: m.team.id, name: m.team.name }));
```

序列化 `apiKeys` 加 `teamId: key.teamId, teamName: key.teamName`；`translations` 加六个新键 `t('scope')` 等；传 `teams={teams}`。

`api-keys-content.tsx`：状态 `const [scope, setScope] = useState<string>('personal');`；表单在名称输入前加

```tsx
<label htmlFor="apiKeyScope" className="sr-only">{t.scope}</label>
<select id="apiKeyScope" value={scope} onChange={(e) => setScope(e.target.value)} className="rounded-md border border-border bg-bg px-3 py-2 text-sm">
  <option value="personal">{t.scopePersonal}</option>
  {teams.map((team) => (<option key={team.id} value={team.id}>{t.scopeTeam.replace('{team}', team.name)}</option>))}
</select>
```

（若 `@/components/ui` 已有 `Select` 组件则改用它，保持同一视觉。）POST 体 `JSON.stringify(scope === 'personal' ? { name: newKeyName } : { name: newKeyName, teamId: scope })`；错误映射：`data.error === 'not_a_member' → t.errorNotMember`，`'plan_no_api_access' → t.errorPlanNoApiAccess`，否则沿用原文案。表头在 `{t.key}` 之后加 `<Th>{t.scopeColumn}</Th>`，行内加 `<td …>{key.teamName ?? t.scopePersonal}</td>`。`label htmlFor="apiKeyName"` 文案保持 `t.createNew`（测试用它定位）。

`demo-supplement.ts` 四块 `settings:` 子树各加：

```ts
      apiKeys: {
        scope: 'Scope', scopePersonal: 'Personal', scopeTeam: 'Team · {team}', scopeColumn: 'Scope',
        errorNotMember: 'You are not a member of this team.',
        errorPlanNoApiAccess: 'The team owner’s plan does not include API access.',
      },
```

zh：`作用域 / 个人 / 团队 · {team} / 作用域 / 你不是该团队成员。 / 团队 owner 的套餐不含 API 访问。`；de：`Geltungsbereich / Persönlich / Team · {team} / Geltungsbereich / Du bist kein Mitglied dieses Teams. / Der Tarif des Team-Owners enthält keinen API-Zugang.`；hi：`दायरा / व्यक्तिगत / टीम · {team} / दायरा / आप इस टीम के सदस्य नहीं हैं। / टीम owner के प्लान में API एक्सेस शामिल नहीं है।`。

- [ ] **Step 4: 运行测试通过**

Run: `pnpm exec vitest run --project saas src/__tests__/components/api-keys-content.test.tsx && pnpm exec tsc --noEmit -p tsconfig.json && pnpm lint && pnpm check:locales:strict`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/app/[locale]/\(dashboard\)/settings/api-keys src/i18n/demo-supplement.ts src/__tests__/components/api-keys-content.test.tsx
git commit -m "feat(ui): API key 作用域选择与团队列（ADR 0015 §6）"
```

---

### Task 8: aster-api 透传 `quotaOwnerId`

**Files:**
- Modify: `src/main/java/io/aster/security/apikey/ApiKeyVerifyResult.java`
- Modify: `src/main/java/io/aster/security/apikey/ApiKeyVerifierService.java:225-254`、`:396-410`
- Modify: `src/main/java/io/aster/security/apikey/ApiKeyAuthFilter.java:130-132`
- Modify: `src/main/java/io/aster/billing/snapshot/ApiKeySnapshot.java`、`SnapshotPushResource.java:99-131`、`SnapshotWarmupService.java:162-174`
- Modify: `src/main/java/io/aster/policy/rest/RequestIdentityResolver.java`
- Test: `src/test/java/io/aster/security/apikey/ApiKeyVerifyResultTest.java`、`src/test/java/io/aster/billing/snapshot/ApiKeySnapshotTest.java`、`src/test/java/io/aster/policy/rest/RequestIdentityResolverTest.java`、`src/test/java/io/aster/security/apikey/ApiKeyAuthFilterTenantOverwriteTest.java`

**Interfaces:**
- Produces:

```java
public record ApiKeyVerifyResult(boolean valid, String reason, String apiKeyId, String userId, String tenantId,
                                 String plan, String subscriptionStatus, String role, String quotaOwnerId) {
  // 既有 valid(5 参)/valid(6 参) 保留并委托；新增
  public static ApiKeyVerifyResult valid(String apiKeyId, String userId, String tenantId, String plan,
                                         String subscriptionStatus, String role, String quotaOwnerId);
  // quotaOwnerId 为空白时回退 userId（旧 cloud）
}
public record ApiKeySnapshot(boolean valid, String reason, String apiKeyId, String userId, String tenantId,
                             String plan, String role, Long revokedAtEpochMs, String quotaOwnerId) {
  public String effectiveQuotaOwnerId(); // 空白 → userId
}
// ApiKeyAuthFilter 写入 ctx 属性 "aster.apikey.quotaOwnerId"
// RequestIdentityResolver: public String quotaOwnerId()  — 属性缺失 → performedBy()
```

- [ ] **Step 1: 写失败测试**

`ApiKeyVerifyResultTest` 新增：

```java
@Test
void valid_withQuotaOwner_keepsIt() {
    ApiKeyVerifyResult r = ApiKeyVerifyResult.valid("key-1", "user-1", "team-1", "team", "active", "member", "owner-1");
    assertThat(r.quotaOwnerId()).isEqualTo("owner-1");
    assertThat(r.tenantId()).isEqualTo("team-1");
}
@Test
void valid_withoutQuotaOwner_fallsBackToUserId() {
    assertThat(ApiKeyVerifyResult.valid("key-1", "user-1", "user-1", "pro", "active").quotaOwnerId()).isEqualTo("user-1");
    assertThat(ApiKeyVerifyResult.valid("key-1", "user-1", "user-1", "pro", "active", "owner", " ").quotaOwnerId()).isEqualTo("user-1");
}
```

`ApiKeySnapshotTest` 新增：9 参构造 + `effectiveQuotaOwnerId()` 回退用例（null → userId；"owner-1" → "owner-1"）。
`RequestIdentityResolverTest` 新增：属性 `aster.apikey.quotaOwnerId` 存在时返回它；缺失时等于 `performedBy()`（照该测试现有的 `setResolverField` 方式注入 jaxrs 上下文）。
`ApiKeyAuthFilterTenantOverwriteTest` 新增：`applyResultSync` 后 `ctx.getProperty("aster.apikey.quotaOwnerId")` 等于结果的 `quotaOwnerId`。

- [ ] **Step 2: 运行确认失败**

Run: `./gradlew --offline :test --tests 'io.aster.security.apikey.ApiKeyVerifyResultTest' --tests 'io.aster.billing.snapshot.ApiKeySnapshotTest' --tests 'io.aster.policy.rest.RequestIdentityResolverTest'`
Expected: 编译失败（新签名不存在）

- [ ] **Step 3: 实现**

`ApiKeyVerifyResult`：加组件 `String quotaOwnerId`（注释：「配额归属：团队 key 为 team owner，个人 key 等于 userId；旧 cloud 不返回时回退 userId（ADR 0015 §3）」）；`invalid` 多传一个 null；6 参 `valid` 委托 7 参并传 `null`；7 参：

```java
String effectiveOwner = (quotaOwnerId == null || quotaOwnerId.isBlank()) ? userId : quotaOwnerId.trim();
return new ApiKeyVerifyResult(true, null, apiKeyId, userId, tenantId, plan, subscriptionStatus, effectiveRole, effectiveOwner);
```

`ApiKeyVerifierService.fetchFromCloud`：传 `json.getString("quotaOwnerId")`；Redis 分支：`ApiKeyVerifyResult.valid(s.apiKeyId(), s.userId(), s.tenantId(), s.plan(), null, s.role(), s.effectiveQuotaOwnerId())`。
`ApiKeySnapshot`：加末尾组件 `String quotaOwnerId`（注释「旧 snapshot 可能为 null → 回退 userId」）；`invalid` 多一个 null；`effectiveQuotaOwnerId()`。全仓 `new ApiKeySnapshot(` 调用点（`SnapshotPushResource`、`SnapshotWarmupService`、`ApiKeySnapshotTest`）补 `json.getString("quotaOwnerId")` / `k.getString("quotaOwnerId")` / 测试值。
`ApiKeyAuthFilter.applyResultSync`：`ctx.setProperty("aster.apikey.quotaOwnerId", result.quotaOwnerId());`。
`RequestIdentityResolver`：

```java
    static final String PROP_QUOTA_OWNER_ID = "aster.apikey.quotaOwnerId";
    /** 配额归属：团队 key 为 team owner，个人 key 等于 performedBy；属性缺失（旧 cloud / 无 key）回退 performedBy。 */
    public String quotaOwnerId() {
        String prop = jaxrsProperty(PROP_QUOTA_OWNER_ID);
        return prop != null && !prop.isBlank() ? prop : performedBy();
    }
```

- [ ] **Step 4: 运行测试通过**

Run: `./gradlew --offline :test --tests 'io.aster.security.apikey.*' --tests 'io.aster.billing.snapshot.*' --tests 'io.aster.policy.rest.RequestIdentityResolverTest'`（`ApiKeyAuthFilterTenantOverwriteTest` 若为 `@QuarkusTest`，按 Global Constraints 起容器）
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/java/io/aster/security/apikey src/main/java/io/aster/billing/snapshot src/main/java/io/aster/policy/rest/RequestIdentityResolver.java src/test
git commit -m "feat(apikey): 透传 quotaOwnerId（缺省回退 userId）（ADR 0015 §3）"
```

---

### Task 9: aster-api 配额键改为 quotaOwnerId

**Files:**
- Modify: `src/main/java/io/aster/billing/ApiQuotaGuard.java:138-237`（`check`）、`:333-389`（`recordAsync`）、`:394-445`（prefetch/precheck 命名）
- Modify: `src/main/java/io/aster/guard/api/GuardDecisionResource.java:63-76, 107-108`
- Modify: `src/main/java/io/aster/policy/rest/PolicyEvaluationResource.java:1258-1267`（`RequestIdentity`/`captureIdentity`）、`:1296-1319`（`enforceApiQuota`）、`:1394-1409`（两个 `recordApiCall`）及 13 处 6 参调用点（258, 280, 361, 386, 394, 1093, 1109；627, 691, 711, 732, 745, 758）
- Test: `src/test/java/io/aster/billing/ApiQuotaGuardUsageBodyTest.java`（新）、`src/test/java/io/aster/guard/api/GuardDecisionResourceQuotaTest.java`、`src/test/java/io/aster/policy/rest/PolicyEvaluationResourceTrialIdentityTest.java`

**Interfaces:**
- Consumes: Task 8 `RequestIdentityResolver.quotaOwnerId()`。
- Produces:

```java
public GuardResult check(String tenantId, String quotaOwnerId);   // 快照/计数器/precheck/Caffeine 全部按 quotaOwnerId 取键
public void recordAsync(String quotaOwnerId, String userId, String tenantId, String apiKeyId,
                        String endpointPath, String status, long latencyMs);
static JsonObject usageBody(String quotaOwnerId, String userId, String tenantId, String apiKeyId,
                            String endpointPath, String status, long latencyMs); // 包可见，供测试
```

- [ ] **Step 1: 写失败测试**

```java
// ApiQuotaGuardUsageBodyTest.java（纯 JUnit）
@Test
void usageBody_carriesQuotaOwnerAndUser() {
    JsonObject b = ApiQuotaGuard.usageBody("owner-1", "member-1", "team-1", "key-1", "/api/v1/guard/decisions", "success", 12L);
    assertThat(b.getString("quotaOwnerId")).isEqualTo("owner-1");
    assertThat(b.getString("userId")).isEqualTo("member-1");
    assertThat(b.getString("tenantId")).isEqualTo("team-1");
    assertThat(b.getString("apiKeyId")).isEqualTo("key-1");
    assertThat(b.getString("endpointPath")).isEqualTo("/api/v1/guard/decisions");
    assertThat(b.getString("status")).isEqualTo("success");
    assertThat(b.getLong("latencyMs")).isEqualTo(12L);
}
```

`GuardDecisionResourceQuotaTest`：增加 `when(identityResolver.quotaOwnerId()).thenReturn(OWNER)`（`OWNER = "owner-guard-quota"`）；`check` 的 stub/verify 改为 `(TENANT, OWNER)`；`recordAsync` 的 verify 改为 7 参 `eq(OWNER), eq(USER), eq(TENANT), eq(API_KEY_ID), eq(PATH), eq("success"), anyLong()`；新增一条「`quotaOwnerId()` 返回 null 时按 performedBy 计配额」——mock 返回 null，verify `check(TENANT, USER)`。
`PolicyEvaluationResourceTrialIdentityTest`：`check(` 的 7 处 stub/verify 第二参改为 quotaOwnerId（该测试用真实 resolver，个人 key 下等于 performedBy，多数断言值不变；逐处确认）。

- [ ] **Step 2: 运行确认失败**

Run: `./gradlew --offline :test --tests 'io.aster.billing.ApiQuotaGuardUsageBodyTest'`
Expected: 编译失败

- [ ] **Step 3: 实现**

`ApiQuotaGuard.check(String tenantId, String quotaOwnerId)`：方法体内 `userId` 全部改名 `quotaOwnerId`（span 属性加 `aster.quota_owner_id`，保留 `aster.user_id` 写入同值以免看板断档）；`snapshot.getUser(quotaOwnerId)`、`snapshot.getCounter(quotaOwnerId)`、`precheckCache.getIfPresent(quotaOwnerId)`、`triggerAsyncPrefetch(quotaOwnerId)`。`triggerAsyncPrefetch`/`fetchPrecheckSync` 参数改名 `quotaOwnerId`（precheck 的 `userId=` 查询参数名不变，注释说明其语义是配额 owner）。

`recordAsync`：

```java
    public void recordAsync(String quotaOwnerId, String userId, String tenantId, String apiKeyId,
                             String endpointPath, String status, long latencyMs) {
        if (!config.enabled()) return;
        // 本地计数器按配额归属累加：个人 key 等于 userId，团队 key 为 team owner（ADR 0015 §4）
        String counterKey = quotaOwnerId != null ? quotaOwnerId : userId;
        if ("success".equals(status) && counterKey != null) {
            try { snapshot.incrementCounter(counterKey); }
            catch (Exception e) { LOG.warnf("local counter incr failed quotaOwnerId=%s: %s", counterKey, e.getMessage()); }
        }
        try {
            …
            JsonObject body = usageBody(quotaOwnerId, userId, tenantId, apiKeyId, endpointPath, status, latencyMs);
            …
    }

    static JsonObject usageBody(String quotaOwnerId, String userId, String tenantId, String apiKeyId,
                                String endpointPath, String status, long latencyMs) {
        return new JsonObject()
            .put("quotaOwnerId", quotaOwnerId)
            .put("userId", userId)
            .put("tenantId", tenantId)
            .put("apiKeyId", apiKeyId)
            .put("endpointPath", endpointPath)
            .put("status", status)
            .put("latencyMs", latencyMs);
    }
```

`GuardDecisionResource.decide`：取 `String quotaOwnerId = identityResolver.quotaOwnerId();`，若为 null 回退 `performedBy`（mock 场景）；`quotaRejection(tenantId, quotaOwnerId, apiKeyId)` → `check(tenantId, quotaOwnerId)`；`recordAsync(quotaOwnerId, performedBy, tenantId, apiKeyId, PATH, "success", …)`。

`PolicyEvaluationResource`：`record RequestIdentity(String tenantId, String performedBy, String apiKeyId, String quotaOwnerId)`；`captureIdentity()` 加 `quotaOwnerId()`；`enforceApiQuota` 用 `String quotaOwnerId = quotaOwnerId();` 调 `check(tenantId, quotaOwnerId)`；3 参 `recordApiCall` 内取 `quotaOwnerId()`；6 参 `recordApiCall` 改为 7 参 `(endpointPath, status, latencyMs, tenantId, userId, apiKeyId, quotaOwnerId)`，13 处调用点补传 `identity.quotaOwnerId()`（evaluate-source 处对应 `quotaOwnerSnap`，与 `apiKeyIdSnap` 同处捕获）。新增私有 `quotaOwnerId()` 委托 `identityResolver.quotaOwnerId()`（与既有 `tenantId()`/`performedBy()` 同模式）。

- [ ] **Step 4: 运行测试通过**

Run（纯 JUnit）：`./gradlew --offline :test --tests 'io.aster.billing.ApiQuotaGuardUsageBodyTest' --tests 'io.aster.policy.rest.PolicyEvaluationResourceTrialIdentityTest'`
Run（DB，按 Global Constraints 起容器）：`DB_JDBC_URL=… ./gradlew --offline :test --tests 'io.aster.guard.*' --tests 'io.aster.billing.*' --tests 'io.aster.security.apikey.*' --tests 'io.aster.policy.security.QuotaChainIT'`
Expected: PASS（报告中给出 @QuarkusTest 实际执行数）

- [ ] **Step 5: 提交**

```bash
git add src/main/java/io/aster/billing/ApiQuotaGuard.java src/main/java/io/aster/guard/api/GuardDecisionResource.java src/main/java/io/aster/policy/rest/PolicyEvaluationResource.java src/test
git commit -m "feat(quota): 配额键改为 quotaOwnerId，usage 上报携带配额归属（ADR 0015 §3-§4）"
```

---

### Task 10: 全栈验收（podman）与 ADR 定稿

**Files:**
- Modify: `aster-cloud/docs/architecture/decisions/0015-team-scoped-api-keys.md`（Status → Accepted；§8 追加「验收结果」）
- Create: `/private/tmp/aster-stack/seed-team.sql`（临时，不入库）

**Interfaces:**
- Consumes: Tasks 1–9 全部；现有栈 `/private/tmp/aster-stack/`（容器 aster-pg/aster-redis/aster-cloud/aster-api，env 文件含 KEY1 等）；`aster-guard/scripts/e2e-local.mjs`。

- [ ] **Step 1: 重建并重启**

```bash
export PATH=/opt/homebrew/opt/node@24/bin:/opt/podman/bin:$PATH; . /private/tmp/aster-stack/env
cd /Users/rpang/IdeaProjects/aster-api && git checkout feat/adr-0015-quota-owner && ./gradlew --offline quarkusBuild -x test -q && podman build --platform linux/arm64 -f Dockerfile.jvm -t aster/policy-api:stack . >/dev/null
podman rm -f aster-api && podman run -d --name aster-api --network aster-stack -p $API_PORT:8080 -e DB_JDBC_URL=jdbc:postgresql://aster-pg:5432/aster_policy -e DB_USERNAME=postgres -e DB_PASSWORD=postgres -e QUARKUS_DATASOURCE_JDBC_URL=jdbc:postgresql://aster-pg:5432/aster_policy -e QUARKUS_DATASOURCE_REACTIVE_URL=postgresql://aster-pg:5432/aster_policy -e QUARKUS_REDIS_HOSTS=redis://aster-redis:6379 -e ASTER_SECURITY_SIGNATURE_ENABLED=false -e ASTER_CLOUD_INTERNAL_URL=http://aster-cloud:3000 -e ASTER_PLAN_GATE_HMAC_KEY=$HMAC_KEY -e JAVA_OPTS="-Xmx1g -Xms256m" localhost/aster/policy-api:stack
cd /Users/rpang/IdeaProjects/aster-cloud && git checkout feat/adr-0015-team-scoped-api-keys && podman restart aster-cloud   # 容器命令含 pnpm db:migrate → 迁移 0049 自动执行
until curl -sf http://localhost:$API_PORT/q/health >/dev/null; do sleep 2; done; until podman logs aster-cloud 2>&1 | grep -q 'Ready in'; do sleep 3; done
podman exec aster-pg psql -U postgres -d aster_cloud -Atc "select column_name from information_schema.columns where table_name='ApiKey' and column_name='teamId'"   # 期望输出 teamId
```

- [ ] **Step 2: 造团队与团队 key**

```sql
-- /private/tmp/aster-stack/seed-team.sql（对 aster_cloud）
INSERT INTO "User"(id,email,plan,"updatedAt") VALUES ('owner1','owner1@stack.test','pro',now()),('m-free','m-free@stack.test','free',now()),('m-dpo','m-dpo@stack.test','free',now()) ON CONFLICT (id) DO NOTHING;
INSERT INTO "Team"(id,name,slug,"ownerId") VALUES ('team1','Stack Team','stack-team','owner1') ON CONFLICT (id) DO NOTHING;
INSERT INTO "TeamMember"(id,"teamId","userId",role) VALUES ('tm1','team1','owner1','owner'),('tm2','team1','m-free','member'),('tm3','team1','m-dpo','admin') ON CONFLICT DO NOTHING;
-- 两把团队 key：明文由 shell 生成，hash = sha256(明文)，prefix = 明文第 4–11 字符
INSERT INTO "ApiKey"(id,"userId","teamId",name,key,prefix) VALUES ('tk-free','m-free','team1','team-key-free',:'H_FREE',:'P_FREE'),('tk-dpo','m-dpo','team1','team-key-dpo',:'H_DPO',:'P_DPO') ON CONFLICT (id) DO NOTHING;
```

```bash
KEY_FREE=ak_$(openssl rand -hex 32); KEY_DPO=ak_$(openssl rand -hex 32); echo "KEY_FREE=$KEY_FREE" >> /private/tmp/aster-stack/env; echo "KEY_DPO=$KEY_DPO" >> /private/tmp/aster-stack/env
podman exec -i aster-pg psql -U postgres -d aster_cloud -v H_FREE=$(printf %s "$KEY_FREE" | shasum -a 256 | cut -d' ' -f1) -v P_FREE=${KEY_FREE:3:8} -v H_DPO=$(printf %s "$KEY_DPO" | shasum -a 256 | cut -d' ' -f1) -v P_DPO=${KEY_DPO:3:8} -f /private/tmp/aster-stack/seed-team.sql
# aster-api 侧为 team1 部署同一示例策略：复用 /private/tmp/aster-stack/policy.sql，把两处 't1' 换成 'team1' 后执行
sed "s/'t1'/'team1'/g" /private/tmp/aster-stack/policy.sql | podman exec -i aster-pg psql -U postgres -d aster_policy -Atq -f /dev/stdin
```

- [ ] **Step 3: 验收 1 —— 两名成员用团队 key 完成四眼**

```bash
cd /Users/rpang/IdeaProjects/aster-guard && ASTER_GUARD_BASE_URL=http://localhost:$API_PORT ASTER_GUARD_API_KEY=$KEY_FREE ASTER_GUARD_APPROVER_API_KEY=$KEY_DPO node scripts/e2e-local.mjs
```
Expected: 4 步全 ✓，退出码 0。并查 `guard_decisions`：`tenant_id='team1'`、`requested_by='m-free'`；`guard_approvals.decided_by='m-dpo'`。

- [ ] **Step 4: 验收 2 —— free 成员不被配额拦，调用计入 owner 池**

验收 1 的步骤 1 已证明 free 成员的请求得到 ALLOW 而非 403。再查 cloud：
```bash
podman exec aster-pg psql -U postgres -d aster_cloud -Atc "select \"userId\", \"quotaOwnerId\", count(*) from \"ApiCallRecord\" where \"quotaOwnerId\"='owner1' group by 1,2"
```
Expected: 行 `m-free | owner1 | n` 与 `m-dpo | owner1 | n`（n ≥ 1）；且 `GET /api/internal/api/precheck?userId=owner1`（用 push-snapshot.mjs 同款 HMAC 方式签名 GET，或直接查 `countOwnerPoolUsage` 口径的 SQL）`monthlyUsed` 等于上述之和。

- [ ] **Step 5: 验收 3 —— 成员移出后团队 key 失效**

```bash
podman exec aster-pg psql -U postgres -d aster_cloud -Atc "delete from \"TeamMember\" where id='tm3'"
sleep 61   # aster-api verify 本地缓存 60 s；SQL 直删不触发钩子，这里验证的是解析器现查这道兜底
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:$API_PORT/api/v1/guard/decisions -H "Authorization: Bearer $KEY_DPO" -H 'content-type: application/json' -d '{"policyModule":"guard.customer","policyFunction":"decide","action":{"principal":{"id":"x","type":"agent"},"action":{"name":"read_customer_record"}}}'
```
Expected: `401`。

- [ ] **Step 6: 验收 4 —— 个人 key 行为不变**

```bash
ASTER_GUARD_BASE_URL=http://localhost:$API_PORT ASTER_GUARD_API_KEY=$KEY1 ASTER_GUARD_APPROVER_API_KEY=$KEY3 node scripts/e2e-local.mjs
podman exec aster-pg psql -U postgres -d aster_policy -Atc "select tenant_id, requested_by from guard_decisions order by created_at desc limit 1"
```
Expected: 4 步全 ✓；最新决策 `tenant_id='t1'`、`requested_by='t1'`（与 ADR 0015 之前的运行相同）。

- [ ] **Step 7: ADR 定稿与提交**

ADR 0015 `Status: Accepted（2026-10-08 本地全栈验收通过）`；§8 末尾追加「验收结果」小节，逐条写 4 项的实测输出（决策/审批行、`ApiCallRecord` 聚合、401、个人 key 行）。

```bash
cd /Users/rpang/IdeaProjects/aster-cloud && git add docs/architecture/decisions/0015-team-scoped-api-keys.md docs/architecture/decisions/README.md && git commit -m "docs(adr): ADR 0015 定稿——本地全栈验收结果"
```

---

## 对 ADR 的修正（执行前已并入）

| ADR 原文 | 代码事实 | 处理 |
|---|---|---|
| 迁移写 `"ApiCall"` 表 | 真实表名 `"ApiCallRecord"`（索引名才以 `ApiCall_` 开头） | ADR §1 已改 |
| 钩子表写 `invalidateApiKeyCache(memberId)` | 路由参数 `memberId` 是 `TeamMember.id` | ADR §5 已改为成员 userId |
| owner 套餐 fan-out 由各 Stripe 处理器调用 | 七个调用方都经 `pushUserSnapshot` | fan-out 放进 `pushUserSnapshot`（ADR §4/§5 已改） |

## 本地验证总顺序

1. aster-cloud：`pnpm exec tsc --noEmit -p tsconfig.json && pnpm lint && pnpm test:run && pnpm check:locales:strict`。
2. aster-api：纯 JUnit 定向 + 带容器的 `io.aster.guard.* / io.aster.billing.* / io.aster.security.apikey.*`，最后全量 `:replay:test :test`。
3. Task 10 的 podman 全栈四项验收。
