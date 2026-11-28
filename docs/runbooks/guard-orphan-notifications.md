# Guard 孤儿通知：开关、上线门槛、预发验证与回滚（ADR 0065）

Guard 对账（aster-api，每 5 分钟一轮）发现新的 **critical** 孤儿动作时，cloud 定时任务 `guard-orphan-notify` 从 aster-api 的跨租户只读通知源拉取「每个租户水位之后的新增」，给该租户的团队 owner / admin（个人租户即本人）各写一条站内通知 `guard.orphans_detected`。`member` / `viewer` 永不收。决定与取舍见 aster-api `docs/adr/0065-guard-orphan-tenant-notifications.md`。

## 1. 开关

两个平台开关都在管理后台 `/admin` 的平台开关卡片里，**缺省都关**，改动写审计日志：

| 键 | 卡片行 | 作用 |
|---|---|---|
| `guard.orphan_notifications.enabled` | Guard 孤儿通知（站内） | 总开关。关闭时定时任务第一步就返回 `ran: false`，不调用 aster-api、不读写状态表 |
| `guard.orphan_notifications.email.enabled` | Guard 孤儿通知（邮件） | 第二阶段（PR-C3）才接入发信；当前打开也没有任何行为。将来仅 SaaS、且站内开关也开时生效 |

开关值有 60 秒的单实例缓存：关闭后最多一个 tick 内停止。

## 2. 定时任务

| 项 | 值 |
|---|---|
| 任务名 / 路由 | `guard-orphan-notify` / `POST /api/cron/guard-orphan-notify`（`Authorization: Bearer $CRON_SECRET`） |
| cron | `2-59/5 * * * *`（每 5 分钟、错开 2 分钟；`*/5` 已被 `guard-deploy-sync` 占用） |
| 去重 | `CronJobLease` 按「以 :02 为起点的 5 分钟窗口」去重；同一窗口重复触发返回 `ran: false, reason: already-*` |
| 心跳 | `HEALTHCHECKS_GUARD_ORPHAN_NOTIFY_URL`（start / success / fail）；开关关闭时照常上报 success |
| 依赖 | `ASTER_API_INTERNAL_URL`、`ASTER_PLAN_GATE_HMAC_KEY`（缺 key 时 tick 在发请求前失败，心跳 fail） |

每个 tick：以 `now − 7 天 − 5 分钟` 翻页拉取租户索引 → 对 `maxId` 超过水位的租户（至多 50 个、并发 4）拉取增量汇总 → 现查收件人 → 同一事务写通知行并以比较后写推进水位。每租户安静期 1 小时：期内的新增不推进水位，期满后合并成一条。

## 3. 打开站内开关前的硬门槛

逐条核对，任一不满足都不要打开：

1. **生产 aster-api 已提供通知源**。从能访问 aster-api 的地方（与 cloud `ASTER_API_INTERNAL_URL` 同一地址）发一个不带签名的请求，必须是 `401`；`404` 表示 aster-api 还是旧版本：

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST "$ASTER_API_BASE/api/internal/guard/orphan-feed/tenants" \
     -H 'Content-Type: application/json' -d '{}'
   ```

   `403` 表示 aster-api 侧没有配置 `aster.plan-gate.hmac-key`（fail-closed），同样不能开。
2. **cloud 迁移 0070 已应用**（`drizzle/0070_guard_orphan_notify_state.sql`）：

   ```sql
   SELECT to_regclass('"GuardOrphanNotifyState"'), to_regclass('"GuardOrphanEmailState"');  -- 两列都不为空
   ```
3. **预发 Worker 的触发器里有 `2-59/5 * * * *`**：Cloudflare 控制台 → Workers → 该 Worker → Settings → Triggers → Cron Triggers。若 Cloudflare 不接受这种写法，停下来回到 ADR，不要私自改成别的表达式。
4. **生产规模的通知源查询计划（plan R12）**：在生产库（只读副本即可）对数据量最大的租户跑一次，确认没有大范围扫描：

   ```sql
   EXPLAIN (ANALYZE, BUFFERS)
   SELECT tenant_id, MAX(id) FROM guard_orphan_actions
    WHERE status = 'OPEN' AND severity = 'critical' AND detected_at >= now() - interval '7 days'
    GROUP BY tenant_id ORDER BY tenant_id LIMIT 501;

   EXPLAIN (ANALYZE, BUFFERS)
   SELECT kind, COUNT(*), MIN(detected_at), MAX(detected_at), MAX(id)
     FROM guard_orphan_actions
    WHERE tenant_id = '<OPEN 行最多的租户>' AND status = 'OPEN' AND severity = 'critical'
      AND detected_at >= now() - interval '7 days' AND id > 0
    GROUP BY kind;
   ```

   若第二条在 `id > :afterId` 上扫描大量行，先另立任务加部分索引 `(tenant_id, id) WHERE status = 'OPEN' AND severity = 'critical'`，再开开关。
5. **两侧 `ASTER_PLAN_GATE_HMAC_KEY` 一致**（Worker secret 与 aster-api ExternalSecret）。这把 key 现在也保护跨租户通知源：泄露时可一次枚举全部租户的 critical 孤儿计数，轮换须两侧同时进行（见 [secrets-rotation.md](secrets-rotation.md)）。

## 4. 预发验证（ADR 0065 §4 第 3 步）

在预发用一个测试团队执行，以真实 cron 驱动。准备：团队里至少一个 owner、一个 admin、一个 member；用 **member** 身份创建一个团队 API key，导出为 `$MEMBER_KEY`；用 admin 身份创建一个团队 API key，导出为 `$ADMIN_KEY`；`$ASTER_API_BASE` 指向预发 aster-api。不要把 key 写进命令历史以外的任何地方，验证完立即在团队设置里吊销。

1. 管理后台打开「Guard 孤儿通知（站内）」。
2. 以 member key 上报一条不带 `decisionId` 的副作用：

   ```bash
   curl -s -X POST "$ASTER_API_BASE/api/v1/guard/side-effects" \
     -H "Authorization: Bearer $MEMBER_KEY" -H 'Content-Type: application/json' \
     -d "{\"effects\":[{\"effectId\":\"staging-orphan-$(date +%s)\",\"source\":\"staging-check\",\"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"action\":{\"name\":\"staging.delete_record\"}}]}"
   # 期望 {"accepted":1,"duplicates":0}
   ```
3. 等下一轮对账（≤ 5 分钟）后确认孤儿已产生，记下 `id`：

   ```bash
   curl -s -H "Authorization: Bearer $MEMBER_KEY" \
     "$ASTER_API_BASE/api/v1/guard/reconciliation/orphans?status=OPEN&severity=critical"
   # 期望出现 kind = side_effect_without_decision
   ```
4. **验收：10 分钟内**（从上报算起）owner 与 admin 的铃铛各出现一条「<团队名> 出现新的 Guard 严重发现：1 条」（英文界面为 New critical Guard findings in …），点开进入 `/governance/reconciliation?tenant=…&severity=critical`；**member 不收**。
5. 在治理页（或 `POST $ASTER_API_BASE/api/v1/guard/reconciliation/orphans/<id>/ack`，admin key，body `{"comment":"…"}`）确认该孤儿；等安静期（1 小时）过后再按第 2 步上报一条。**验收：第二条通知计数为 1（只计新增）**。
6. 第二条通知发出后的 1 小时内连续上报两条。**验收：安静期内不出现新通知；期满后的第一个 tick 合成一条，计数为 2**。
7. 收尾：确认剩余孤儿、吊销两把测试 key；按需关闭开关。

核对通知行（预发库）：

```sql
SELECT id, "userId", data->>'newTotal' AS new_total, data->>'maxOrphanId' AS max_orphan_id, "createdAt"
  FROM "Notification" WHERE kind = 'guard.orphans_detected' AND data->>'tenantId' = '<测试团队 id>'
 ORDER BY "createdAt";
SELECT * FROM "GuardOrphanNotifyState" WHERE "tenantId" = '<测试团队 id>';
```

## 5. 观测

手动触发一次可以直接看到报告（同一窗口已跑过时返回 `already-done`，等下一个窗口）：

```bash
curl -s -X POST "$CLOUD_BASE/api/cron/guard-orphan-notify" -H "Authorization: Bearer $CRON_SECRET"
```

| 字段 | 含义 |
|---|---|
| `tenantsIndexed` / `pages` | 租户索引返回的租户数 / 页数 |
| `tenantsWithNew` | `maxId` 超过水位的租户数 |
| `noticesCreated` / `recipients` | 本 tick 发出通知的租户数 / 写入的通知行数 |
| `deferredQuiet` | 因安静期推迟的租户数（水位不动） |
| `deferredBacklog` | 超过每 tick 50 个上限、顺延到下一轮的租户数 |
| `summaryFailed` | 增量汇总请求失败的租户数（这些租户水位不动，下一轮重试） |
| `casLost` | 比较后写失败（并发 tick）的租户数；偶发无害 |
| `noRecipients` | 没有 owner / admin 的租户数（只推进水位，`console.warn`） |
| `emailed` | 第二阶段的邮件数；当前恒为 0 |
| `maxLagSeconds` | 本 tick 已发通知里「最早检出」到现在的最大秒数 |
| `oldestPendingSeconds` | 被推迟或处理失败的租户里最老的待通知时长（秒）；`pendingSince` 在租户水位推进、或租户不再有水位之上的 OPEN critical 孤儿（例如已全部确认）时清除，不会因此残留误报 |

需要人工排查的信号：

- **`oldestPendingSeconds > 86400`**：有租户的新增超过一天没有发出。它同时覆盖「安静期 / 积压一直推迟」和「该租户的增量汇总持续失败」两种情况。超过 7 天的积压会落出回看窗口而**不再通知**，必须在此之前处理。`pendingSince` 只在该租户的水位推进、或它不再有水位之上的 OPEN critical 孤儿时才清除（每 tick 对不再是候选的租户统一清理）。不调接口也能直接查：

  ```sql
  SELECT "tenantId", now() - "pendingSince" AS pending_for
    FROM "GuardOrphanNotifyState" WHERE "pendingSince" IS NOT NULL ORDER BY "pendingSince" LIMIT 20;
  ```
- **`summaryFailed` 连续多个 tick 非 0**：Worker 日志里连续出现 `[cron:guard-orphan-notify] N tenant summary request(s) failed`。查 aster-api 是否 5xx / 超时，以及 `guard_orphan_feed_requests_total{outcome}`。
- **心跳 fail / 租约 `failed`**：整个 tick 失败，`CronJobLease.error_message` 给出原因：

  ```sql
  SELECT window_start, status, error_message FROM "CronJobLease"
   WHERE job_name = 'guard-orphan-notify' ORDER BY window_start DESC LIMIT 12;
  ```

  | `error_message` | 含义与处理 |
  |---|---|
  | `orphan feed 0 hmac_not_configured` | cloud 缺 `ASTER_PLAN_GATE_HMAC_KEY` |
  | `orphan feed 401 …` | 两侧 key 不一致或时钟偏差超过 5 分钟；aster-api 侧 `outcome="unauthorized"` 同步上涨 |
  | `orphan feed 403 …` | aster-api 未配置 `aster.plan-gate.hmac-key` |
  | `orphan feed 404 …` | aster-api 版本不含通知源（门槛 1 未满足） |
  | `orphan feed 400 invalid_query` | `detectedSince` 越过收紧带（时钟偏差或 tick 超长），检查两侧时钟 |
  | `orphan feed 0 unreachable` | `ASTER_API_INTERNAL_URL` 不通或超时（单请求 8 秒） |

失败的 tick 不改任何状态，下一轮按水位补发；只要在 7 天内恢复就不丢通知。

## 6. 回滚

管理后台关闭「Guard 孤儿通知（站内）」即可：下一个 tick 起返回 `ran: false`，不再调用 aster-api。状态表与已发通知无害，保留不删；重新打开后从原水位继续，不会重发已通知的孤儿（关闭期间超过 7 天的新增不会再通知）。aster-api 的通知源可以保留，没有调用方时没有任何行为。

## 7. 本地端到端

`src/__tests__/integration/guard-orphan-notify-e2e.integration.test.ts` 用真实 aster-api 覆盖第 4 节的 1–4 步与「key 不一致时 tick 失败、状态不变」，没有 `E2E_ASTER_API_URL` 时跳过。前置：aster-api 用专用空库、`ASTER_GUARD_RECONCILIATION_CRON='0 * * * * ?'`、`ASTER_GUARD_RECONCILIATION_MIN_INTERVAL=PT0S`，`ASTER_CLOUD_INTERNAL_URL` 指向连着同一 `DATABASE_URL` 的 cloud 服务（校验用例写入的团队 API key），两侧共用一把随机生成的 `ASTER_PLAN_GATE_HMAC_KEY`：

```bash
E2E_ASTER_API_URL=http://localhost:<api 端口> ASTER_PLAN_GATE_HMAC_KEY=<与 aster-api 相同的测试 key> \
LICENSE_E2E=1 DATABASE_URL=postgresql://postgres:postgres@localhost:<pg 端口>/aster_cloud \
  corepack pnpm exec vitest run --config vitest.integration.config.ts guard-orphan-notify-e2e
```

用例约 3–4 分钟（每一步等一轮对账），结束时确认自己的孤儿、删除种子数据并把站内开关写回 `false`。
