# 0015 — 团队作用域 API key 与 owner 共享配额池

Status: Proposed（设计已确认，待实施）
Date: 2026-10-08
Companions: `aster-api/docs/adr/0040-action-guard.md` §4.2（四眼）、§10（经过验证的角色来源）；`aster-guard/README.md`「本地端到端」

## 背景

aster-api 通过 `POST /api/internal/apikey/verify` 向本仓校验 API key，本仓返回
`{ tenantId: user.id, userId: user.id, role: 'owner' }`：每把 key 都是持有者自己的
单用户租户。2026-10-08 在本地 podman 全栈（aster-api + aster-cloud + Postgres + Redis）
上实测 Action Guard 的审批流程：

- 请求方与审批方用同一用户的两把 key → `userId` 相同，四眼拒绝（403 segregation_of_duties）；
- 用不同用户的 key → `tenantId` 不同，租户隔离拒绝（404 approval_not_found）。

结论：**用本仓签发的 key 永远无法完成四眼审批**，ADR 0040 的审批面在 SaaS 上不可用。

与此同时本仓已有团队模型（`Team`、`TeamMember`，角色 owner/admin/member/viewer），
团队策略在 aster-api 里本来就以 `tenant = teamId` 执行（`policy.teamId || policy.userId`）。
即个人 key 看不到团队策略在 aster-api 侧的执行数据，租户语义在两条路径上并不一致。

相邻的既有缺陷一并记录，本 ADR 一起修：

- 配额与功能门槛全部按 **key 持有者个人**的套餐计算（`validateApiKey` 要求个人 plan ≠ free；
  aster-api `ApiQuotaGuard.check` 以 userId 取快照/计数器/precheck）。团队 key 若沿用此逻辑，
  free 套餐成员会被拦，而 owner 的 Pro 套餐形同虚设。
- `pushApiKeySnapshot` 在生产代码中**没有任何调用方**：key 的创建与吊销都不会通知 aster-api。
- 成员被移出团队、所有权转移、团队删除都不触碰 key。

## 决策

### 1. 数据模型

`ApiKey` 新增可空列 `teamId text` 与索引 `ApiKey_teamId_idx(teamId)`。

- `teamId IS NULL` ⇒ 个人 key，语义与今天完全相同；现有全部 key 不受影响。
- `teamId` 非空 ⇒ 团队 key，由团队成员**为自己**创建（`userId` 仍是创建者）。
- 不存角色：角色在每次解析时从 `TeamMember` 现查，成员被移出即失效。
- 不加外键（与 `ApiKey.userId`、`TeamMember.teamId` 现状一致）；团队删除由路由显式吊销团队 key。

`ApiCallRecord` 新增可空列 `quotaOwnerId text` 与索引
`ApiCall_quotaOwnerId_period_idx(quotaOwnerId, periodMonth, status)`。旧行保持 NULL，统计时按
`COALESCE(quotaOwnerId, userId)` 归池（见 §4）。

迁移 `drizzle/0049_api_key_team_scope.sql`（手写，`IF NOT EXISTS`，`--> statement-breakpoint`
分隔；`_journal.json` 的 `when` 必须大于 1789342699256）：

```sql
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "teamId" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ApiKey_teamId_idx" ON "ApiKey" USING btree ("teamId");
--> statement-breakpoint
ALTER TABLE "ApiCallRecord" ADD COLUMN IF NOT EXISTS "quotaOwnerId" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ApiCall_quotaOwnerId_period_idx" ON "ApiCallRecord" USING btree ("quotaOwnerId", "periodMonth", "status");
```

### 2. 单一身份解析器

新建 `src/lib/api-key-identity.ts`，是 key → 身份映射的**唯一**实现：

```ts
export type ApiKeyIdentity =
  | { valid: true; apiKeyId: string; userId: string; tenantId: string; quotaOwnerId: string;
      role: TeamRole; plan: Plan; subscriptionStatus: string | null }
  | { valid: false; reason: 'not_found' | 'revoked' | 'expired' | 'orphan_key'
                          | 'team_not_found' | 'membership_revoked'; revokedAt?: Date; expiredAt?: Date };

export async function resolveApiKeyIdentity(keyHash: string): Promise<ApiKeyIdentity>;
export async function resolveApiKeyIdentities(keys: ApiKeyRow[]): Promise<Map<string, ApiKeyIdentity>>; // 批量，供 snapshot/full
```

| key 类型 | tenantId | userId | role | quotaOwnerId | plan / subscriptionStatus |
|---|---|---|---|---|---|
| 个人（`teamId` NULL） | `userId` | `userId` | `SOLO_TENANT_ROLE`（owner） | `userId` | 持有者本人 |
| 团队（`teamId` 非空） | `teamId` | `userId`（创建者） | `TeamMember.role` | `Team.ownerId` | team owner 的 |

失败顺序：key 不存在 → `not_found`；`revokedAt` 非空 → `revoked`；`expiresAt` 已过 → `expired`；
持有者用户不存在 → `orphan_key`；团队不存在 → `team_not_found`；无 membership → `membership_revoked`。

四个消费者全部改用它，删除各自的映射代码：

1. `src/app/api/internal/apikey/verify/route.ts`
2. `src/lib/snapshot-pusher.ts` `pushApiKeySnapshot`
3. `src/app/api/internal/snapshot/full/route.ts`（批量变体；查询 apiKeys 时带上 `teamId`）
4. `src/lib/api-keys.ts` `validateApiKey`（本仓 `/api/v1/*` 路由）：团队 key 同样做 membership 现查，
   `ApiAuthResult` 增加 `teamId: string | null`；调用方语义不变（以成员身份行动）。
   套餐门槛改为 `hasFeatureAccess(quotaOwnerId, 'apiAccess')`，与 §5 创建时的门槛同一口径。

### 3. 对 aster-api 的契约

verify 响应与 snapshot 推送体（`POST /api/internal/snapshot/apikey/{hash}`）增加 `quotaOwnerId`：

```json
{ "valid": true, "apiKeyId": "…", "userId": "<成员>", "tenantId": "<teamId 或 userId>",
  "quotaOwnerId": "<owner 或 userId>", "plan": "pro", "subscriptionStatus": "active", "role": "member" }
```

无效时 `reason` 新增 `team_not_found`、`membership_revoked`，aster-api 当作普通无效处理（401）。

aster-api 侧（本 ADR 的配套改动，提交到 aster-api 仓）：

- `ApiKeyVerifyResult`、`ApiKeySnapshot` 增加 `quotaOwnerId`；缺省（旧 cloud）回退为 `userId`。
  `ApiKeyVerifierService.fetchFromCloud`、`SnapshotPushResource.pushApiKey`、`SnapshotWarmupService.fullSync`
  读取该字段。
- `ApiKeyAuthFilter.applyResultSync` 写入请求属性 `aster.apikey.quotaOwnerId`；
  `RequestIdentityResolver.quotaOwnerId()` 读出，缺省回退 `performedBy()`。
- `ApiQuotaGuard`：`check(String tenantId, String quotaOwnerId)`——快照键 `aq:user:<quotaOwnerId>`、
  计数器 `aq:counter:user:<quotaOwnerId>:m:<YYYY-MM>`、precheck `?userId=<quotaOwnerId>`、Caffeine 键全部改用
  quotaOwnerId；`recordAsync(String quotaOwnerId, String userId, String tenantId, String apiKeyId,
  String endpointPath, String status, long latencyMs)`——计数器按 quotaOwnerId 自增，usage 请求体新增
  `quotaOwnerId`。`checkRate(tenantId, apiKeyId)` 与 `PlanGateService.lookupPlan(tenantId)` 不变
  （`tenant/[id]/plan` 已把 teamId 解析到 owner 套餐）。
- 三个调用点跟改：`GuardDecisionResource`（check / recordAsync）、`PolicyEvaluationResource.enforceApiQuota`
  与两处 `recordApiCall`。
- 租户隔离与四眼不变：同团队两名成员各持团队 key 时 `tenantId` 相同、`userId` 与 `apiKeyId` 不同，四眼可过。

个人 key 的 `quotaOwnerId == userId`，上述每一处行为与今天逐字节相同。

### 4. owner 共享配额池

owner 付一份套餐就是一个月度池：owner 个人 key 的调用 + owner 名下所有团队的团队 key 调用共用该池。

- `GET /api/internal/api/precheck?userId=<id>`：参数名不变，语义改为「配额 owner」。套餐取该用户；
  用量 = `count(*) FROM "ApiCall" WHERE periodMonth = :period AND status = 'success'
  AND ("quotaOwnerId" = :id OR ("quotaOwnerId" IS NULL AND "userId" = :id))`。
- `POST /api/internal/api/usage`：请求体新增可选 `quotaOwnerId`，缺省等于 `userId`；落库到新列。
- 新助手 `src/lib/api-quota-pool.ts` `countOwnerPoolUsage(ownerId, periodMonth)` 封装上述 SQL；
  precheck、`GET /api/internal/api/usage`、`app/api/user/api-usage`（用户用量页）、
  `app/api/cron/api-quota-alerts`（配额告警）四处统一调用，禁止各自写计数。
- 不重复计费：成员 M 的团队调用行为 `(userId = M, quotaOwnerId = O)`，M 的个人池条件
  `quotaOwnerId IS NULL AND userId = M` 不命中它。
- owner 套餐变化（Stripe 回调 `checkout-completed`、`subscription-updated`、`subscription-deleted`、
  `invoice-payment-*`；`cron/auto-downgrade`）全部经由 `pushUserSnapshot(owner)`，它已覆盖共享池上限；
  在其内部新增对 owner 名下每个团队调用 `invalidatePlanCache(teamId)`（助手 `invalidatePlanCacheForOwner(ownerId)`），
  否则 aster-api 的 `lookupPlan(teamId)` 缓存最长 5 分钟内仍按旧套餐限速。

### 5. key 生命周期

`POST /api/api-keys`，请求体 `{ name: string; teamId?: string }`：

- 有 `teamId`：调用者必须是该团队**活跃成员**（任意角色，含 viewer——角色随 key 透传，权限由 aster-api RBAC 判定），
  否则 403 `{ error: 'not_a_member' }`；功能门槛改查 `hasFeatureAccess(team.ownerId, 'apiAccess')`，
  不通过 403 `{ error: 'plan_no_api_access' }`。
- 成功 201 返回 `{ id, key, prefix, name, teamId: string | null, createdAt }`。
- `GET /api/api-keys` 返回调用者创建的全部 key（个人 + 团队），每项含 `teamId`、`teamName`。
- `DELETE /api/api-keys/{id}`：创建者本人吊销（现状），团队管理员吊销成员 key 通过成员移出路径实现。
- 创建、吊销两条路由补上今天缺失的 `pushApiKeySnapshot(hash)`；吊销还调用 `invalidateApiKeyCache(userId)`。

团队生命周期钩子（全部 best-effort：推送失败记 error 日志，不回滚业务事务；解析器现查是兜底）：

| 事件 | 路由 | 动作 |
|---|---|---|
| 成员移出 / 退出 | `DELETE teams/[teamId]/members/[memberId]` | 吊销该成员在该团队的全部 key；逐 key 推送无效快照；`invalidateApiKeyCache(成员 userId)`（路由参数 `memberId` 是 `TeamMember.id`，须取 `targetMember.userId`） |
| 角色变更 | `PUT teams/[teamId]/members/[memberId]` | 重推该成员在该团队的 key 快照；`invalidateApiKeyCache(成员 userId)` |
| owner 套餐变化 | `pushUserSnapshot(owner)` 内部 | 对 owner 名下每个团队 `invalidatePlanCache(teamId)`（放在 `pushUserSnapshot` 里，七个调用方零改动） |
| 所有权转移 | `POST teams/[teamId]/transfer` | 重推该团队全部 key 快照（`quotaOwnerId` 变了）；对每个受影响用户 `invalidateApiKeyCache`；`invalidatePlanCache(teamId)` |
| 团队删除 | `DELETE teams/[teamId]` | 吊销全部团队 key；推送无效快照；逐用户 `invalidateApiKeyCache` |

吊销/移出的实现集中在 `src/lib/api-keys.ts` 新函数 `revokeTeamKeys(teamId, userId?)` 与
`refreshTeamKeySnapshots(teamId, userId?)`，路由只调用，不自己写 SQL。

### 6. UI 与文案

`settings/api-keys/api-keys-content.tsx` 创建表单增加「作用域」选择：个人 / 某团队
（团队列表由页面服务端组件用与 `GET /api/teams` 相同的查询预取，作为 props 传入）；请求体带 `teamId`。
列表新增「作用域」列，显示「个人」或团队名。新增文案键写入 `src/i18n/demo-supplement.ts` 的
en/zh/de/hi 四块：`settings.apiKeys.scope`、`scopePersonal`、`scopeTeam`、`scopeColumn`、
`errorNotMember`、`errorPlanNoApiAccess`；`check:locales:strict` 必须通过。

### 7. 失效语义与安全边界

- aster-api verify 结果本地缓存 60 s，Redis `aq:apikey:<hash>` 快照 TTL 1 h。成员移出后：
  推送成功 ⇒ 立即失效；推送失败 ⇒ 本地缓存 60 s 内到期后走 verify 现查并被拒；
  **仅当** 该 key 恰有一份 Redis 快照且推送失败时，最长 1 h 内仍被接受。此为已知上限，与现状
  （吊销根本不通知）相比是收敛而非扩大。
- 团队 key 的 `role` 来自 membership 现查，aster-api 用它无条件覆盖 `X-User-Role`，持 viewer key
  不能自带 ADMIN 头提权（与个人 key 的既有保护一致）。
- `X-User-Business-Role` 仍是 ADR 0040 §9 所述的可信 BFF 标签，不在本 ADR 范围；
  团队角色可作为 ADR 0040 §10「经过验证的角色来源」的后续基础。

### 8. 测试与验收

本仓（vitest，`pnpm test:run`）：

- `api-key-identity.test.ts`：个人 / 团队 / 团队不存在 / membership 缺失 / owner 套餐取值 / 批量解析。
- `apikey-verify-route.test.ts` 补成功路径：个人 key、团队 key、`membership_revoked`。
- `snapshot-pusher.test.ts`、`snapshot-full-route.test.ts`：断言 `tenantId`/`role`/`quotaOwnerId` 新口径。
- `usage-route.test.ts` + 新 `precheck-route.test.ts`：共享池计数 SQL（新行、旧 NULL 行、成员不被双算）。
- `api-keys.test.ts`（lib 与路由）：`teamId` 校验、403 两种、列表含 `teamName`、吊销推送。
- 新 `team-lifecycle-keys.test.ts`：四个钩子各自调用的吊销/重推/失效。
- `fail-closed-all-routes.test.ts` 的 mock 补 `teams`/`teamMembers` 与新算子。

aster-api（JUnit）：`ApiKeyVerifyResultTest`（`quotaOwnerId` 回退）、`ApiKeyAuthFilterTenantOverwriteTest`
（属性透传）、`ApiQuotaGuard` 相关测试改按 quotaOwnerId 取键、`GuardDecisionResourceQuotaTest`。

验收（本地 podman 全栈，`aster-guard/scripts/e2e-local.mjs`）：

1. 两名团队成员各用本仓签发的团队 key：ALLOW → PENDING → APPROVED → ALLOW 四步全过。
2. free 套餐成员持 Pro owner 团队的 key：不被 403 `plan_no_api_access` / 配额拦截；其调用计入 owner 池。
3. 成员被移出后再用团队 key：401。
4. 现有个人 key 的 verify 响应、配额键、租户与改前逐字段相同。

### 9. 发布顺序与兼容性

1. 先跑迁移 0049（只加可空列与索引，可重复执行）。
2. aster-api 与本仓的部署顺序无约束：aster-api 对缺失的 `quotaOwnerId` 回退 userId；
   旧 aster-api 忽略多出的字段。
3. 现有 key 无需迁移数据；`ApiCall` 旧行通过 `COALESCE` 归池，不做回填。

## 后果

- 四眼审批在 SaaS 上可用；团队策略与团队 key 在 aster-api 侧共享同一租户数据。
- key → 身份的映射只剩一处实现；四个消费者行为一致。
- key 创建/吊销/成员变动开始实时通知 aster-api，修掉了 `pushApiKeySnapshot` 从未被调用的缺陷。
- 配额口径从「持有者个人」变为「配额 owner」，个人 key 不变，团队 key 计入 owner 池。
- 成本：`ApiKey`/`ApiCall` 各一列一索引；verify 路径多一次 membership 查询（团队 key 时）。

## 被否决的替代方案

- **隐式映射**（用户恰属一个团队就返回 teamId）：会改变所有现有 key 的租户，多团队用户无解。
- **aster-api 改按 tenantId 计配额**：计数器按团队分池，破坏共享池；每个团队都要独立快照；
  `lookupPlan` 冷启动 fail-open，取不到 owner。
- **每团队独立配额池**：owner 多建团队即可倍增配额，与按 owner 计费的模型矛盾。
- **在 key 上冻结角色**：角色变更需要改写 key，且与 membership 失同步；现查更简单也更安全。
