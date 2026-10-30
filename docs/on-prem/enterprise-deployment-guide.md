# Aster Cloud 企业级部署指南

<!-- glossary:block id=enterprise-deployment-guide-aster-cloud-paragraph-1 -->
本文档面向企业平台团队、SRE、安全团队和审计团队。客户日常 license 操作请参考 `docs/on-prem/license-management.md`。
<!-- /glossary:block -->

## 1. 概览与威胁模型

<!-- glossary:block id=enterprise-deployment-guide-1-paragraph-2 -->
Aster Cloud on-prem 运行在客户环境。Aster SaaS 端负责签发 license、发布签名 revocation manifest 和提供支持。
<!-- /glossary:block -->

核心信任边界：

<!-- glossary:block id=enterprise-deployment-guide-1-list-item-3 -->
- license payload 使用 Ed25519 license key 签名
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-1-list-item-4 -->
- revocation manifest 使用独立 Ed25519 revocation key 签名（two-key separation）
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-1-list-item-5 -->
- on-prem 镜像只内嵌 public trust bundle，**不包含私钥**
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-1-list-item-6 -->
- revocation endpoint 可公开访问；真实性来自签名，不来自 endpoint 访问控制
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-1-list-item-7 -->
- license/revocation **不是遥测通道**，不上传客户代码、策略、用户数据或使用量
<!-- /glossary:block -->

威胁矩阵：

<!-- glossary:block id=enterprise-deployment-guide-1-paragraph-8 -->
| 威胁 | 控制 |
|---|---|
| license payload 被篡改 | Ed25519 签名校验 |
| revocation manifest replay | version 单调递增 + cache anti-rollback |
| revocation 网络长期不可达 | 25h fresh / 7d grace / grace-expired → read-only |
| SaaS signing key 泄露 | Vault/KMS 托管 + license/revocation key 分离 + audit |
| signing-api Witness 旁路 | 独立 service 唯一持有 transit/sign 权限 + dual JWT |
| on-prem admin 误操作 | admin gate + audit log + read-only gate |
| 续期遗忘 | 30/14/7/1 days Slack 提醒 cron |
<!-- /glossary:block -->

## 2. 前置条件

<!-- glossary:block id=enterprise-deployment-guide-2-list-item-9 -->
- K3S 或兼容 Kubernetes 1.29+
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-2-list-item-10 -->
- PostgreSQL 15+
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-2-list-item-11 -->
- Vault 或等价 KMS（生产签名必经）
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-2-list-item-12 -->
- cert-manager（mTLS 证书自动化）
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-2-list-item-13 -->
- Prometheus + Grafana（监控告警）
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-2-list-item-14 -->
- 日志系统：Loki / OpenSearch / Splunk
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-2-list-item-15 -->
- 出站 HTTPS 到 Aster revocation endpoint
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-2-list-item-16 -->
- 定期备份 Postgres 和 Kubernetes Secret
<!-- /glossary:block -->

## 3. K3S 部署阶段

### 阶段 1：创建命名空间

```bash
kubectl create namespace aster-cloud
kubectl label namespace aster-cloud app.kubernetes.io/part-of=aster
```

### 阶段 2：准备 Postgres database

```sql
CREATE DATABASE aster_cloud;
CREATE USER aster_cloud WITH PASSWORD '<strong>';
GRANT ALL PRIVILEGES ON DATABASE aster_cloud TO aster_cloud;
```

### 阶段 3：配置 Secret

```bash
kubectl -n aster-cloud create secret generic aster-cloud-env \
  --from-literal=DATABASE_URL='postgres://aster_cloud:***@postgres:5432/aster_cloud' \
  --from-literal=NEXTAUTH_SECRET='***' \
  --from-literal=CRON_SECRET='***' \
  --from-literal=LICENSE_KEY='aster-ent-v2-...'
```

### 阶段 4：运行数据库迁移

```bash
kubectl -n aster-cloud run migrate --rm -it \
  --image=docker.io/wontlost/aster-cloud:<version> \
  --env-from=secretRef:name=aster-cloud-env \
  -- pnpm db:migrate
```

### 阶段 5：部署 application

部署 Deployment、Service、Ingress。确认：
<!-- glossary:block id=enterprise-deployment-guide-5-application-list-item-17 -->
- `/api/cron/*` 路由仅允许 cron secret 调用
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-5-application-list-item-18 -->
- `/api/admin/*` 仅允许 admin session
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-5-application-list-item-19 -->
- `/api/admin/metrics` 仅允许 Prometheus scrape
<!-- /glossary:block -->

### 阶段 6：配置 cron 触发

<!-- glossary:block id=enterprise-deployment-guide-6-cron-paragraph-20 -->
Cloudflare Workers 自动触发 wrangler.toml 中声明的 cron。其他环境用 K8s CronJob：
<!-- /glossary:block -->

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: license-revocation-refresh
  namespace: aster-cloud
spec:
  schedule: "0 */6 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: cron
              image: curlimages/curl:8.10.1
              command:
                - sh
                - -c
                - >-
                  curl -fsS -X POST
                  -H "Authorization: Bearer $CRON_SECRET"
                  http://aster-cloud:3000/api/cron/license-revocation-refresh
              envFrom:
                - secretRef:
                    name: aster-cloud-env
          restartPolicy: OnFailure
```

on-prem 需要为下表中「on-prem 需调度」为「是」的每个任务各建一个同样结构的 CronJob。只需替换 `metadata.name`、`schedule`
和 URL 路径，统一用 `POST` 并带 `Authorization: Bearer $CRON_SECRET`。
同一窗口重复触发由数据库租约去重；`domain-vocabulary-bulk-worker` 靠任务行认领互斥。
所以 CronJob 重试或与手动 curl 撞在一起都是安全的。
清单与 `src/lib/cron-registry.ts` 逐项一致，由 `src/__tests__/lib/cron-registry-onprem-doc.test.ts` 校验。
「否」的任务只在 SaaS 有意义，on-prem 路由直接返回 404，不必调度。

| 调度（UTC） | 路由 | on-prem 需调度 | 作用 |
|---|---|---|---|
| `30 4 * * *` | `/api/cron/user-purge` | 是 | 软删超过 30 天的账号物理删除 |
| `0 5 * * *` | `/api/cron/risk-tier-decay` | 否 | 注册风险分级衰减（SaaS 专属） |
| `0 */6 * * *` | `/api/cron/license-revocation-refresh` | 是 | 刷新 license 吊销列表 |
| `0 8 * * 1` | `/api/cron/license-renewal-warning` | 是 | license 续期提醒 |
| `15 3 * * *` | `/api/cron/telemetry-retention-gc` | 否 | 遥测留存清理（SaaS 专属） |
| `45 3 * * *` | `/api/cron/domain-vocabulary-retention` | 是 | 降级用户的领域词汇 90 天后归档 |
| `0 4 * * *` | `/api/cron/execution-retention-gc` | 否 | 按套餐清理执行日志（SaaS 专属） |
| `15 4 * * *` | `/api/cron/two-factor-code-gc` | 否 | 回收过期两步验证码（SaaS 专属） |
| `45 4 * * *` | `/api/cron/policy-trash-cleanup` | 是 | 回收站 30 天过期清理与孤儿访问记录回收 |
| `25 * * * *` | `/api/cron/cleanup-nonces` | 是 | 回收内部调用签名用过的过期 nonce |
| `* * * * *` | `/api/cron/domain-vocabulary-bulk-worker` | 是 | 领域词汇异步批量导入的队列消费者（不调度则任务一直停在 queued） |

### 阶段 7：烟测

```bash
curl -fsS https://aster.example.com/api/health
curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
  -X POST https://aster.example.com/api/cron/license-revocation-refresh
```

<!-- glossary:block id=enterprise-deployment-guide-7-paragraph-21 -->
打开 `https://aster.example.com/admin/license` 验证 `verified-active`。
<!-- /glossary:block -->

## 4. License ceremony reference

<!-- glossary:block id=enterprise-deployment-guide-4-license-ceremony-reference-paragraph-22 -->
License signing ceremony 由 Aster 内部执行。流程：
<!-- /glossary:block -->

<!-- glossary:block id=enterprise-deployment-guide-4-license-ceremony-reference-list-item-23 -->
- `aster-deploy/docs/license-key-ceremony.md`
<!-- /glossary:block -->

客户需保存：
<!-- glossary:block id=enterprise-deployment-guide-4-license-ceremony-reference-list-item-24 -->
- licenseId
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-4-license-ceremony-reference-list-item-25 -->
- expiresAt
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-4-license-ceremony-reference-list-item-26 -->
- support contact (`support@aster-lang.cloud`)
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-4-license-ceremony-reference-list-item-27 -->
- revocation endpoint URL
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-4-license-ceremony-reference-list-item-28 -->
- trust bundle fingerprint（启动日志可见）
<!-- /glossary:block -->

## 5. signing-api 部署 reference

<!-- glossary:block id=enterprise-deployment-guide-5-signing-api-reference-paragraph-29 -->
生产签名必经 Vault/KMS 或 signing-api。**禁止**在 SaaS Web 进程持久化私钥。
<!-- /glossary:block -->

参考：

<!-- glossary:block id=enterprise-deployment-guide-5-signing-api-reference-list-item-30 -->
- `aster-deploy/services/license-signing-api/`
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-5-signing-api-reference-list-item-31 -->
- `aster-deploy/services/license-signing-api/k8s/`（K3S raw manifests）
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-5-signing-api-reference-list-item-32 -->
- `aster-deploy/services/license-signing-api/helm/`（Helm chart，可分发给客户）
<!-- /glossary:block -->

关键控制：
<!-- glossary:block id=enterprise-deployment-guide-5-signing-api-reference-list-item-33 -->
- signing-api 独立 namespace `aster-license-signing`
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-5-signing-api-reference-list-item-34 -->
- Vault policy 只允许 `transit/sign/license-signing-*` 和 `transit/sign/revocation-signing-*` update
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-5-signing-api-reference-list-item-35 -->
- 所有签名请求写 audit log（JSONL + Prometheus + Slack）
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-5-signing-api-reference-list-item-36 -->
- break-glass 操作需要 dual JWT (Operator + Witness)
<!-- /glossary:block -->

## 6. SaaS-side revocation endpoint setup

配置：
<!-- glossary:block id=enterprise-deployment-guide-6-saas-side-revocation-endpoint-setup-list-item-37 -->
- DNS：`license.aster-lang.cloud`
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-6-saas-side-revocation-endpoint-setup-list-item-38 -->
- CDN：`Cache-Control: public, max-age=3600, must-revalidate`
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-6-saas-side-revocation-endpoint-setup-list-item-39 -->
- ETag：`"v<version>"`
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-6-saas-side-revocation-endpoint-setup-list-item-40 -->
- TLS：public CA
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-6-saas-side-revocation-endpoint-setup-list-item-41 -->
- Body：signed JSON manifest
<!-- /glossary:block -->

<!-- glossary:block id=enterprise-deployment-guide-6-saas-side-revocation-endpoint-setup-paragraph-42 -->
on-prem 客户**只信任 manifest 签名**。CDN / DNS / TLS 是可用性 + 传输保护，不是数据根信任。
<!-- /glossary:block -->

## 7. Monitoring

导入 Grafana dashboard：

<!-- glossary:block id=enterprise-deployment-guide-7-monitoring-list-item-43 -->
- `docs/on-prem/grafana-license-dashboard.json`
<!-- /glossary:block -->

建议告警：

```yaml
- alert: AsterLicenseRevocationStale
  expr: aster_license_cache_age_seconds > 90000
  for: 30m
  labels:
    severity: warning
  annotations:
    summary: Revocation cache older than 25h

- alert: AsterLicenseGraceExpired
  expr: aster_license_cache_age_seconds > 604800
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: License revocation grace window expired (read-only mode)

- alert: AsterLicenseReadOnlyGateActive
  expr: rate(aster_license_read_only_gate_total[5m]) > 0
  for: 1m
  labels:
    severity: critical
  annotations:
    summary: Admin write operations blocked by license gate
```

## 8. Disaster recovery

<!-- glossary:block id=enterprise-deployment-guide-8-disaster-recovery-paragraph-44 -->
| 场景 | 恢复动作 |
|---|---|
| license signing key 轮换 | 发布新 trust bundle，旧 key 设为 verify-only，6 个月后 retired |
| revocation key 疑似泄露 | retired 旧 key，发布新 bundle，全量重签 manifest |
| Vault 不可用 | 暂停 publish，保留最后有效 manifest |
| signing-api crash | 恢复 pod，核对 audit log 无缺口 |
| on-prem Postgres 恢复 | 备份恢复后立即执行 revocation refresh |
| revocation endpoint DNS 切换 | client 7d grace 内自动恢复；超时手动 refresh |
<!-- /glossary:block -->

## 9. Audit retention

<!-- glossary:block id=enterprise-deployment-guide-9-audit-retention-paragraph-45 -->
| 数据 | 默认保留 | SOC2 建议 | 说明 |
|---|---|---|---|
| admin license revoke | 7 年 | 7 年 | 合同与安全证据 |
| revocation publish | 7 年 | 7 年 | 可重建 public manifest 历史 |
| on-prem refresh event | 90 天 | 1 年 | 运维排障 |
| signing-api request | 7 年 | 7 年 | 密钥使用证据 |
| license verification metric | 30 天 | 90 天 | Prometheus retention |
<!-- /glossary:block -->

## 10. SOC2 control mapping

<!-- glossary:block id=enterprise-deployment-guide-10-soc2-control-mapping-paragraph-46 -->
| Control | 证据位置 | 采集方式 |
|---|---|---|
| CC6.1 access control | admin audit log | `SELECT * FROM AuditLog WHERE action LIKE 'license.%'` |
| CC6.6 encryption / key mgmt | Vault transit config | Vault policy screenshot + ceremony 录屏 |
| CC7.2 monitoring | Grafana dashboard | dashboard export + alert history |
| CC8.1 change management | drizzle migrations | Git PR + CI run history |
| A1 availability | cron logs | log query for `license-revocation-refresh` outcome |
<!-- /glossary:block -->

## 11. Customer onboarding checklist

<!-- glossary:block id=enterprise-deployment-guide-11-customer-onboarding-checklist-list-item-47 -->
- [ ] 创建 Kubernetes Secret 含 `LICENSE_KEY` `CRON_SECRET` `DATABASE_URL`
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-11-customer-onboarding-checklist-list-item-48 -->
- [ ] 配置出站 HTTPS firewall 到 `license.aster-lang.cloud`
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-11-customer-onboarding-checklist-list-item-49 -->
- [ ] 部署 application + cron triggers
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-11-customer-onboarding-checklist-list-item-50 -->
- [ ] 执行 `/api/cron/license-revocation-refresh` 首次冷启动
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-11-customer-onboarding-checklist-list-item-51 -->
- [ ] 打开 `/admin/license` 确认 `verified-active`
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-11-customer-onboarding-checklist-list-item-52 -->
- [ ] 导入 Grafana dashboard
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-11-customer-onboarding-checklist-list-item-53 -->
- [ ] 配置告警接收人
<!-- /glossary:block -->
<!-- glossary:block id=enterprise-deployment-guide-11-customer-onboarding-checklist-list-item-54 -->
- [ ] 验证 read-only gate（人为破坏 license 后所有 admin mutate 应被 503）
<!-- /glossary:block -->

## 12. Troubleshooting matrix

<!-- glossary:block id=enterprise-deployment-guide-12-troubleshooting-matrix-paragraph-55 -->
| 状态 / 错误 | 检查项 | 修复 |
|---|---|---|
| `missing` | `LICENSE_KEY` 未配置 | 更新 Secret 并重启 |
| `malformed` | license 格式或日期错误 | 联系 support 重签 |
| `signature-invalid` | payload 被改或 trust bundle 不匹配 | 检查镜像版本和 license 来源 |
| `signature-untrusted-key` | trust bundle 缺 key | 升级镜像 |
| `verified-expired` | license 到期 | `support@aster-lang.cloud` 续约 |
| `verified-revoked` | license 被撤销 | 联系客户成功团队 |
| `network-grace` | endpoint 暂时不可达 | 检查 proxy / firewall / DNS |
| `network-grace-expired` | 7 天未成功检查 | 恢复网络后手动 refresh |
| `license-read-only-mode` | admin write gate 生效 | 先修复 license 状态再重试 |
| `concurrent-refresh-in-progress` | 多个 refresh 并发 | 正常 — advisory lock 去重；不需处理 |
<!-- /glossary:block -->
