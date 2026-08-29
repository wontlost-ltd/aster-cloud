# S2-1a-2 Slice-2b 设计：in-cluster runner launcher + k3s 编排

> 承 `2026-07-20-s2-1a-2-slice2a-design.md`（Slice-2a 已上线）。
> 决策依据：`p0a-s2-1a-2-slice2b-factbase.md`（地面事实）+ `p0a-s2-1a-2-slice2b-design-forks.md`（岔口分析）+ `p0a-s2-1a-2-runner-engineering-spike.md` §2/§3/§3b/§6（设计意图）。
> 所有 6 岔口已拍板（4 doc-settled + 2 open + Fork A 载体细化）。

## Goal（一句话）
让 Slice-2a 已签名的 runner 镜像被 in-cluster Go launcher 经 digest-pinned Kubernetes Job 真编排：cloud（CF Worker）经 Cloudflare Tunnel HMAC 调 launcher → launcher 建 runner Job → 收 ReplayMetadata 回传，并把 k3s 信任根种子补齐使 image-pin 链闭合。

## 诚实边界（铁律，承 §3b/§4）
- **本 slice 无签名 = 无 attestation 安全增量**：不抗 aster-api 攻破、不抗 launcher 攻破、不解锁签字。它建 **runner 编排骨架 + 集成 parity**，为 S2-1b（签名）铺路。称 **integration/orchestration milestone**，不称 attestation 增量。
- **launcher 是新 TCB 成员**（§3b）：只编排不产证据（证据仍由 runner 产、S2-1b 才签）；launcher 镜像 cosign-verified admission；审计。MVP 完全不具备 §3b 完整绑定（imageID 可信观察/challenge 原子消费/SVID 签）——那是 S2-1b/-1c。
- **parity 证集成正确性非算法独立性**（§4）：runner 与 aster-api 跑同一份 executor 代码，byte-parity 近乎定义性；差分门守的是「打包/镜像/launcher/Job 环境未在共享代码外引入分叉」。

---

## 架构：拆两 slice（Fork E 拍板）

### 为什么拆
2b-launch 是新 TCB 子系统（Go 服务 + 首个建 Job 的 SA + 跨边界 HMAC + Tunnel 路由），须从容走独立安全审查（Fork F）。2b-seed 是 k3s-only 信任根种子 + runner-ns 脚手架，机械/低风险。拆开让种子先落（含 push-ruleset 保护的人工 commit），launch 独立成篇。

### ★Fork A×E 耦合的诚实结论
Fork A 拍板 = **runner digest 落 launcher Deployment 的 `RUNNER_IMAGE_DIGEST` env**（launcher 读它构 `docker.io/wontlost/aster-replay-runner@${digest}`），image-pin 脚本加**第三写目标** patch 该 env value。**故 launcher 必须存在，image-pin 链才闭合**——2b-seed 单独**不能**让 Slice-2a image-pin 转绿。2b-seed 的诚实价值 = 种信任根（image-lock 3rd 条 + allowed-images 3rd 条 + admission 标签 + runner-ns 脚手架），使 2b-launch 上线时 pin 链一次闭合。**不假装 2b-seed 独自转绿 Slice-2a**（诚实边界）。

---

## Slice 2b-seed（k3s 信任根种子 + runner-ns 脚手架）

### 交付物
1. **allowed-images.yaml 3rd 条**（`k3s/.github/image-pin/allowed-images.yaml`，**人工 commit**，push-ruleset 保护）：
   ```yaml
     - image: docker.io/wontlost/aster-replay-runner
       sourceRepo: aster-cloud/aster-api
       workflowFile: aster-replay-runner-deploy.yml
       sourceRef: refs/heads/main
   ```
   对齐已上线 cosign identity（`aster-replay-runner-deploy.yml:136` 的 identity-regexp）。
2. **image-lock.yaml 3rd 条种子**（`k3s/apps/aster-lang/aster-runner/image-lock.yaml`，**新目录**——Fork A 拍板落 runner-ns 非 cloud/）：占位 entry（image 键 + UNVERIFIED-SEED sourceSha），供 image-pin 脚本 Phase-2 覆写为真 digest。★保持 verify-image-pin ruleset 对 runner 镜像**evaluate(dry-run)** 直到 launcher 上线（承 image-lock 头注种子说明，避免种子值 fail-closed 卡死）。
3. **runner-ns 脚手架**（`k3s/apps/aster-lang/aster-runner/`）：`namespace.yaml`（贴 `policy.sigstore.dev/include=true` admission opt-in 标签——runbook「贴 namespace 标签=opt-in 主闸」）+ `kustomization.yaml`（被 ApplicationSet 自动发现 → App `aster-runner`）。**先只含 namespace**（launcher manifests 在 2b-launch 加）。
4. **runner 两 ClusterImagePolicy CRD**（`k3s/apps/infrastructure/policy-controller/policies/cluster-image-policy-aster-replay-runner{,.reject-tag}.yaml`，mirror aster-cloud-migrate 两文件）：
   - `wontlost-aster-replay-runner`：keyless verify，glob `index.docker.io/wontlost/aster-replay-runner@sha256:**`，subject `https://github.com/aster-cloud/aster-api/.github/workflows/aster-replay-runner-deploy.yml@refs/heads/main`，mode enforce。
   - `wontlost-aster-replay-runner-reject-tag`：static fail，glob `...aster-replay-runner:**`（闭 tag TOCTOU）。
   - ★2b-seed 加这两 CIP 但**它们对 runner 惰性**（无人拉 runner 镜像直到 launcher）；真生效在 2b-launch。**必须先按 runbook 在临时贴标签 namespace 跑六态 admission smoke-test**，再给 aster-runner 贴 opt-in 标签（label 丢=静默关闭，runbook 警）。
5. **ArgoCD AppProject destinations 加 aster-runner ns**（`k3s/argocd/projects/aster-lang.yaml:12-19`，人工）：否则 ArgoCD 拒 sync。namespaceResourceWhitelist 已允许所有需要的 kind（SA/Role/RoleBinding/Job/Deployment/Service/ConfigMap/Secret/NetworkPolicy），无须改。

### runner-ns 命名
`aster-runner`（ApplicationSet 派生 App `aster-runner` in ns `aster-runner`，与 aster-cloud BFF ns 隔离）。

### 验证（本地实测）
- `kustomize build apps/aster-lang/aster-runner/` 渲染 namespace（含标签）无误。
- yq 校验 image-lock/allowed-images 3rd 条 schema 合法。
- **不**真 apply（等 launcher）；不触发 image-pin 真跑（保持 dry-run）。

---

## Slice 2b-launch（Go launcher 微服务 + 真编排）

### 子系统边界（design-for-isolation）
| 单元 | 职责 | 依赖 | 接口 |
|---|---|---|---|
| **HMAC 验证中间件** | 验 cloud→launcher 的 7 行 canonical HMAC（独立 key ASTER_RUNNER_LAUNCHER_HMAC_KEY），ts 窗口 ±300s，常量时间比对 | ASTER_RUNNER_LAUNCHER_HMAC_KEY | `verify(headers, rawBody) → (tenant, role) | 401/403` |
| **Job 编排器** | 建 digest-pinned runner Job（initContainer 写 request 到 emptyDir + command 覆写 stdin 重定向），watch 到终态，读 Pod log 取 envelope | client-go, RUNNER_IMAGE_DIGEST env, runner-ns | `runJob(RunnerRequest) → RunnerEnvelope | error` |
| **HTTP handler** | `POST /api/v1/runner/launch`：验 HMAC → 调编排器 → 映射 RunnerEnvelope 到 F 契约响应（outcome/replayMetadata|error，业务错也 200） | 上两单元 | 匹配 `runner-launcher-client.ts` 契约 |
| **k8s manifests** | Deployment（硬化 securityContext 镜像 cloudflared 模板）+ SA + Role(batch/jobs+pods+pods/log+configmaps) + RoleBinding + Service + external-secrets + network-policy | runner-ns 脚手架, AppProject destinations | GitOps 部署 |

### Fork C 拍板：stdin 注入 = initContainer + emptyDir + command 覆写
launcher 建的 Job spec（**launcher 运行时构造，非 kustomize 资源**）：
- **per-invocation ConfigMap**（owner-ref 到 Job，级联 GC）持 RunnerRequest JSON。
- **initContainer** 把 ConfigMap 挂载内容 copy 到 emptyDir `/work/request.json`。
- **主容器** `command: ["/bin/sh","-c","exec /app/bin/runner < /work/request.json"]`（覆写 Job spec command，**runner 镜像字节不变**；alpine ash 提供 sh）。emptyDir 在 readOnlyRootFilesystem 下可写（同 migrate-job /tmp tmpfs）。
- **image**：`docker.io/wontlost/aster-replay-runner@${RUNNER_IMAGE_DIGEST}`（从 launcher env 读，Fork A）。
- Job 字段镜像 migrate-job.yaml：ttlSecondsAfterFinished/backoffLimit:2/restartPolicy:Never/automountServiceAccountToken:false/硬化 securityContext/resources（**实测驱动**，§2，非 128Mi/512Mi）。

### Fork C 拍板：envelope 读协议
- launcher 读全 Pod log（**不 2>/dev/null**，保诊断），取**最后一行能解析为合法 RunnerEnvelope JSON**（有 outcome∈{SUCCESS,ERROR}）。
- **exit code 作 SUCCESS/ERROR/序列化失败权威**（RunnerMain 0/1/3，从 pod status 读）：日志截断/不可解析 → fail-closed 到 unavailable。

### Fork A 拍板：runner digest 载体 = launcher env + 脚本第三写目标
- launcher Deployment env `RUNNER_IMAGE_DIGEST`（初值占位 sha256）。
- **`open-image-pin-pr.sh` 加第三写目标**（可选，仅 runner workflow 传）：patch launcher Deployment 的该 env value。须 Codex 审 + 跨仓（aster-api 脚本 + k3s launcher manifest）协调。
- runner deploy workflow 的 image-pin 步加 `LOCK_PATH`/`KUSTOMIZATION_PATH` 指 runner-ns + 新第三目标参数指 launcher deployment。

### F 契约（launcher 须精确匹配，已上线 client 权威）
- endpoint `POST /api/v1/runner/launch`。
- 7 行 canonical `method\npath\nts\nnonce\nbodyHash\ntenant\nrole`，独立 key，X-Aster-Tenant/Role 在 header。
- request body `{tenantId, source, input, locale, functionName, aliasSet}`（role 只在 header）。
- response `{outcome:"SUCCESS", replayMetadata:{5 parity 字段+可选 runtimeToolchainId}}` 200 / `{outcome:"ERROR", errorCode, message, phase}` **也 200** / 非 200 → cloud 侧 unavailable。
- timeout 30s（cloud 侧）：launcher 须在此内返回或让 cloud 判 unavailable。

### Fork F 拍板：安全审查
launcher PR 走**强化 Codex 深审**（如 runner-integrity M1 CCO 深审模式），聚焦 §3b 骨架 + 最小权限：
- SA Role 最小（无 pods/attach、无 cluster-scope、仅 runner-ns）。
- launchRunnerJob 绝不 reject（whole-body try + safeErrorMessage + finally guard）——承 Slice-2a client 契约。
- 无证据自产（launcher 只透传 runner 产的 envelope，不改字段）。
- HMAC key 隔离（不 fall back 到 plan-gate key）。

### 验证（本地实测）
- **HMAC 单元测试**：验真签/拒篡改/拒过期/拒错 caller（Go test，镜像 stub 的 tamper/expiry 用例）。
- **编排器集成测试**：kind 或 k3d 本地集群，真建 runner Job（用 Slice-2a 本地 build 的 runner 镜像），喂固定 corpus，断言 envelope == aster-api 权威 expected（复用 gen-expected corpus，Fork C 的 stdin 路径真跑）。
- **端到端**：本地 launcher + 本地 cloud client（signRunnerLauncherHeaders）真发 HMAC → launcher 真建 Job → 收 envelope → 映射 F 响应；断言 outcome/replayMetadata 5 字段。
- Cloudflare Tunnel 路由 = **带外 dashboard 步**（无 in-repo YAML，C10），文档记录不测。

---

## 跨仓交付顺序（严格）
1. **2b-seed**（k3s）：allowed-images 人工 + runner-ns 脚手架 + AppProject destinations。合入后 runner-ns App 存在（空 namespace）。
2. **2b-launch A**（aster-api）：`open-image-pin-pr.sh` 加第三写目标 + runner workflow 传参。Codex 审。
3. **2b-launch B**（k3s + Go launcher）：launcher 源码 + manifests（image-lock/kustomization/deployment/SA/Role/RoleBinding/Service/external-secrets/network-policy）。强化 Codex 审。
4. **带外**：Cloudflare dashboard 加 tunnel 路由；prod RUNNER_IMAGE_DIGEST 首次由 image-pin 真跑写入（此时链闭合，Slice-2a image-pin 转绿）。

## 迁移/破坏性
- 纯增量：新 ns、新服务、脚本加可选参数（现有 aster-api/aster-cloud-migrate image-pin 路径零改动——第三写目标仅 runner workflow 传）。
- 无历史 artifact 依赖。

## 范围外
- SPIRE/SPIFFE + workload 签名（S2-1b，唯一解锁签字）。
- finalization receipt 唯一入口（S2-1c）。
- 独立节点池/taint（现无；容量验收若要求再建，§2）。
- runner 算法独立性（TS 二引擎，母 spike 已定非签字级）。
