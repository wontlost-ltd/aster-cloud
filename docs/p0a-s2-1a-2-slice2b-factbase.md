# Slice-2b 地面事实库（in-cluster launcher + k3s 编排 + admission 种子）

> 由 Explore agent（只读，28 工具调用）实证采集，每条带 file:line 证据。这是 Slice-2b spike 的输入。
> 设计源：`p0a-s2-1a-2-runner-engineering-spike.md` §3/§3b/§6 + `-cf-integration-spike.md` §3-E + `-cf-research-factbase.md` §E。
> 已定决策：E1=Go launcher / 独立 HMAC key / tunnel dashboard-managed。

**★关键框架修正**：F 侧契约的权威源不止 stub。Slice-2a 还上线了 `runner-launcher-client.ts`（真 `launchRunnerJob`）、`runner-parity.ts`、`api-signing.ts` 里的 `signRunnerLauncherHeaders`。这三者才是权威契约，stub 只是**接收方参考实现**。

---

## SECTION A — k3s image-lock 种子（即时 fail-closed 缺口）

### A1. image-lock.yaml entry schema
`k3s/apps/aster-lang/cloud/image-lock.yaml:20-29`。每 entry 4 字段：`image`（全限定 `docker.io/...`）、`digest`（`sha256:<64hex>`）、`sourceSha`（github.sha）、`runId`（引号字符串）。现有 2 条（aster-api、aster-cloud-migrate）。**须种 3rd 条** `docker.io/wontlost/aster-replay-runner`。★脚本只**改写**已存在 entry 的 digest/sourceSha/runId，**从不插入** → 必须先手工种一条占位 entry（至少 `image:` 键行）。

### A2. kustomization.yaml images 段 + 「两文件都要」硬门
`k3s/apps/aster-lang/cloud/kustomization.yaml:39-43`。每 entry 2 字段：`name`（配 image-lock 的 `image`）、`digest`。无 `newName`（本仓只按 name+digest pin，不重命名）。

`aster-api/scripts/ci/open-image-pin-pr.sh`：
- L61-62：image-lock `count = .images | select(.image==IMAGE) | length`，`!=1` 报错 exit 1。
- L65-66：kustomization `kcount` 同理 `.images[].name`，`!=1` exit 1。
- L71-78：只 **yq 改写** 已存在 entry 的 digest/sourceSha/runId，**不创建**。

### ★A2-CONFIRMED FAIL-CLOSED 根因
已上线 runner workflow `aster-api/.github/workflows/aster-replay-runner-deploy.yml:265-266` 调：
```
bash scripts/ci/open-image-pin-pr.sh docker.io/wontlost/aster-replay-runner image-pin/aster-replay-runner
```
**无 LOCK_PATH/KUSTOMIZATION_PATH env override**（job env block L259-263 只设 GH_TOKEN/DIGEST/SOURCE_SHA/RUN_ID）。→ 脚本 default（L26-27）到 `apps/aster-lang/cloud/{image-lock,kustomization}.yaml`，找不到 runner image（count==0），**exit 1**。这就是「image-pin fails-closed 因信任根未种」的缺口。种子 = 往 `cloud/` 两文件加 runner entry（占位 digest）。

### ★A3. 关键设计岔口 — runner image-lock entry 该放哪
- `image-lock.yaml` 全仓**仅一处**：`apps/aster-lang/cloud/`（find 单命中）。非 per-namespace，是单个 cloud-scoped 文件服务 aster-cloud workload。
- `apps/aster-lang/` 下 kustomization.yaml 仅 `cloud/`+`observability/`。`lsp/` 无 kustomization（不被 ApplicationSet 发现）；`policy/` 空。
- 脚本 LOCK_PATH/KUSTOMIZATION_PATH **可参数化**（env，L26-27）但硬 default 到 `cloud/`。
- ApplicationSet 从 `apps/aster-lang/<dir>/` 派生 namespace `aster-<dir>`。

**评估（证据支撑，标为设计决策）**：
- **(a) 种进 `cloud/`**：匹配已上线 workflow、今天即可解阻 Slice-2a image-pin。但**语义错**——runner Job 是 launcher 建的临时 Job（在计划中的独立 runner ns），非 aster-cloud kustomize build 的一部分。`cloud/kustomization.yaml` 的 `images:` transformer 只改写该 kustomization `resources:` 列的资源（namespace/deployment/migrate-job——**runner Job 不在其中**），所以 runner entry 只是满足脚本 `kcount==1` 的**惰性 transformer 条目，什么都不改写**。
- **(b) 建 `apps/aster-lang/<runner-ns>/{image-lock,kustomization}.yaml`**：干净，但须新建目录 + workflow image-pin 步加 LOCK_PATH/KUSTOMIZATION_PATH override 指向它。此位置**不存在，须创建**。无先例（无第二个 image-lock）。
- 设计文档不解此岔（`runner-engineering-spike.md:156` 显式把 runner Job ns 推到 plan 阶段：「默认倾向新建 runner ns … 此为 plan 阶段工程细节」）。→ **spike 须决**。

### A4. allowed-images.yaml — runner 3rd entry + 保护
`k3s/.github/image-pin/allowed-images.yaml:18-32`。每 entry 4 字段：`image`、`sourceRepo`、`workflowFile`、`sourceRef`。verifier 建 cert-identity = `https://github.com/{sourceRepo}/.github/workflows/{workflowFile}@{sourceRef}`。runner 3rd entry（对齐已上线 cosign identity `aster-replay-runner-deploy.yml:136`）：
```yaml
  - image: docker.io/wontlost/aster-replay-runner
    sourceRepo: aster-cloud/aster-api
    workflowFile: aster-replay-runner-deploy.yml
    sourceRef: refs/heads/main
```
**★push-ruleset 保护 CONFIRMED**（L5-8 头注「这是信任根…受 push ruleset 保护，禁 image-pin PR 修改，只走人工流程」；L11「表里没有的镜像出现在 image-lock → 直接拒」）。→ **人工 commit，非 auto-PR**。

---

## SECTION B — Launcher Deployment + RBAC

### B5. 硬化模板 + RBAC 现状
最佳硬化模板 = cloudflared `k3s/apps/infrastructure/cloudflare-tunnel/deployment.yaml`：
- Pod securityContext（L29-35）：runAsNonRoot / runAsUser 65532 / fsGroup 65532 / seccompProfile RuntimeDefault。
- Container securityContext（L62-67）：allowPrivilegeEscalation false / readOnlyRootFilesystem true / capabilities.drop [ALL]。
- 专用 SA（L87-97）`automountServiceAccountToken: false`。

**★launcher RBAC 是 cluster-first**：cloudflared SA **无** API access（L25-26 注 + L88）。launcher 要反过来（`automountServiceAccountToken: true` + 真 Role）。
**全仓无任何 Role/RoleBinding manifest**（`grep -rln rbac.authorization.k8s.io apps/` 零命中；argocd/projects 里的 Role/RoleBinding 是 `namespaceResourceWhitelist` 声明非真对象）。→ launcher 的 `SA + Role(batch/jobs: create,get,list,watch,delete + pods: get,list,watch + pods/log: get) + RoleBinding` 是**净新，集群首个建 Job 的 SA**。AppProject whitelist（`aster-lang.yaml:32-33,44-47,53-57`）允许 ServiceAccount/batch.Job/batch.CronJob/rbac.Role/rbac.RoleBinding——策略允许但无 manifest。安全一等件（§3b 威胁模型）。

### B6. Runner Job 模板（mirror 源）+ resources 信封
`k3s/apps/aster-lang/cloud/migrate-job.yaml`：
- `ttlSecondsAfterFinished: 86400`(L27)、`backoffLimit: 2`(L31)、`restartPolicy: Never`(L37)、`automountServiceAccountToken: false`(L38)。
- Pod securityContext(L39-45)：runAsNonRoot / uid-gid-fsGroup 1000 / seccomp RuntimeDefault。
- Container securityContext(L70-75)：allowPrivEsc false / readOnlyRootFS true / cap.drop [ALL]。
- tmpfs(L77-83)：emptyDir sizeLimit 64Mi @ /tmp。
- **★resources(L63-69)：requests cpu 50m/mem 128Mi，limits cpu 500m/mem 512Mi。**

**★128Mi/512Mi 对 GraalVM 太小**（engineering-spike:53,171 + factbase:43 均警告 OOM）。文档给的是**实测驱动**信封非固定数：§2(L55-60)「request/limit 用实测定：峰值 RSS + p95 冷启动 + 代表性 corpus 决定，非猜」；预算须覆盖「JVM heap + direct/native + Truffle/GraalVM 元空间与 code cache 余量」。**无固定推荐数** = §2 容量验收门须实测设。并发 default=1 直到容量验收通过（§2/§7.4）。runner Job 也须 `automountServiceAccountToken: false`（它不调 k8s API，只 launcher 调）。

### B7. ArgoCD ApplicationSet + onboarding
`k3s/argocd/applicationsets/aster-lang.yaml:10-15` generator：git files `apps/aster-lang/*/kustomization.yaml`。template 派生：App 名 `aster-{{segments 2}}`、ns 同名、CreateNamespace=true(L57)、prune+selfHeal(L53-55)。
onboarding launcher：建 `apps/aster-lang/<launcher-dir>/kustomization.yaml` + manifests（Deployment/SA/Role/RoleBinding/Service/namespace/external-secrets/network-policy）。目录 → auto App `aster-<launcher-dir>` in ns `aster-<launcher-dir>`。
**★AppProject destinations allowlist 须加新条目**：`k3s/argocd/projects/aster-lang.yaml:12-19` destinations 仅列 aster-cloud/aster-lsp/aster-observability（L13 注「Explicit namespace list, no wildcards for security」）。新 launcher/runner ns **须手加**否则 ArgoCD 拒 sync。`argoproj.io/Application` 已从 whitelist 移除（L81-82，无 app-of-apps 逃逸）。

---

## SECTION C — launcher 契约（Go 服务须实现）

### C8. F 侧契约（已上线 Slice-2a）— launcher 须精确匹配
**endpoint** — `runner-launcher-client.ts:30` `LAUNCH_PATH='/api/v1/runner/launch'`（POST）。
**HMAC canonical** — `api-signing.ts:249-273` `signRunnerLauncherHeaders(method,path,body,tenantId,role)`：
- 独立 key `ASTER_RUNNER_LAUNCHER_HMAC_KEY`（L252-253，未设即 throw）。
- 7 行 canonical(L261)：`method\npath\nts\nnonce\nbodyHash\ntenant\nrole`。ts=unix 秒(L254)。bodyHash=sha256Hex(UTF-8 body bytes)(L258-260)。signature=HMAC-SHA256(L262)。

**headers**（client 写 / launcher 读；stub `runner-launcher-stub.ts:23-31` 读）：
- `X-Internal-Caller: cloud-runner-launcher`（stub 断言非此值→401）。
- `X-Aster-Timestamp`(unix 秒)、`X-Aster-Nonce`。
- `X-Aster-Tenant`(tenantId)、`X-Aster-Role`(role)——**必须在 headers** 供接收方重建 canonical。
- `X-Internal-Signature`(HMAC)、`Content-Type: application/json`。

**launcher 验证（Go 须复刻，from stub 参考接收方）**：
1. ts 窗口 ±300s，`Number.isFinite` 先守（stub L34-37）→ 过期/NaN 401。
2. 重算 bodyHash=sha256(raw body)，重建同 7 行 canonical（L44-46）。
3. 常量时间 HMAC 验（L50-51，用 ASTER_RUNNER_LAUNCHER_HMAC_KEY）→ **不匹配 403**（key 隔离），缺 header/错 caller 401。

**request body (RunnerRequest)** — `runner-launcher-client.ts:62-65` 发：`{tenantId, source, input, locale, functionName, aliasSet}`。（`role` 签名/进 header 但**不在 body**。）
**response envelope (RunnerEnvelope)** — client 解析(L72-81)/stub 返回(L53)：
- 成功 `{outcome:"SUCCESS", replayMetadata:{...}}` HTTP 200。
- runner 业务错 `{outcome:"ERROR", errorCode, message, phase}` **也 HTTP 200**（按 outcome 分类非 HTTP status）。
- replayMetadata（`LaunchReplayMetadata` L15-22）：canonicalInputHash/canonicalOutputHash/canonicalizationVersion/replayabilityStatus/traceHash（5 parity 字段）+ 可选 runtimeToolchainId（诊断，parity 排除）。
- client 失败分类(L25-28)：`{ok:true,replayMetadata}` | `{ok:false,kind:'runner-error',...}` | `{ok:false,kind:'unavailable',reason}`。非 200→unavailable(L71)；throw→unavailable(L84)。env `ASTER_RUNNER_LAUNCHER_URL`(L54 必需)、`ASTER_RUNNER_LAUNCHER_TIMEOUT` default 30000ms(L56)。

### C9. runner stdin/stdout I/O — launcher 须接的线
`aster-api/runner/src/main/java/io/aster/replay/runner/RunnerMain.java`：
- **stdin**：`MAPPER.readValue(in, RunnerRequest.class)`(L41) 从 `System.in`(L26/31) 读。
- **stdout**：`out.println(MAPPER.writeValueAsString(envelope))`(L48) 写 envelope 为 **stdout 最后一行**；诊断日志走 **stderr**(L45/50)。
- **exit**：SUCCESS 0 / ERROR 1(L53) / 序列化失败 3(L51)。
`RunnerRequest.java:12-19` 6 字段 `@JsonIgnoreProperties(ignoreUnknown=true)`：tenantId/source/Object input/locale/functionName/Map<String,List<String>> aliasSet。**与 cloud client body 字节对齐**（client 的 role 只在 header，RunnerRequest 容忍 body 缺它）。
`RunnerEnvelope.java:12-25` `@JsonInclude(NON_NULL)`：outcome("SUCCESS"|"ERROR")/replayMetadata(仅成功)/errorCode(PARSE/EXECUTION/MODULE/INTERNAL)/message/phase(parse|execute|trace|metadata)。**与 C8 F 侧字节一致**。
Dockerfile:26 `ENTRYPOINT ["/app/bin/runner"]`，arm64 `azul/zulu-openjdk-alpine:25-jre`(L4)，非 root `USER runner`(L23)。

**★launcher 须接的确切 I/O（承重集成答案）**：runner 从 **stdin** 读请求、写 envelope 到 **stdout 最后一行**——**不读 env/args**。故 Go launcher 须：
1. 建 digest-pinned Job（image `...aster-replay-runner@sha256:...`，entrypoint `/app/bin/runner`）。
2. **把 RunnerRequest JSON 送进容器 stdin**。★batch/v1 Job **无原生 stdin 注入**——真设计点须 spike 决（候选：attach subresource 走 stdin / wrap entrypoint 从挂载文件或 env 读再 pipe 给 /app/bin/runner / initContainer 写共享 emptyDir 供 runner 读）。**无 in-repo 先例**；migrate-job 只 env 交付。Job 模板支持 env，但 RunnerMain **硬读 stdin 忽略 env**。此 stdin 交付是未决 wiring。
3. watch Job 到终态；读 **Pod logs**（须 `pods/log: get`）取**最后 stdout 行**，解析 RunnerEnvelope，映射到 C8 的 `{outcome, replayMetadata|error}` HTTP 响应。★Pod logs 默认合并 stderr+stdout——launcher 须隔离最后 stdout 行（另一 wiring caveat）。

### C10. Cloudflare Tunnel — 无 in-repo 路由
**CONFIRMED 无 in-repo tunnel ingress config**。`k3s/apps/infrastructure/cloudflare-tunnel/` 只有 application/deployment/external-secrets/kustomization/network-policy.yaml——**无 config.yaml、无 ingress ConfigMap**。Deployment 跑 `tunnel run --token $(TUNNEL_TOKEN)`（token-based 远管 tunnel），路由在 Cloudflare Zero Trust dashboard 非 git。→ **launcher HTTPS 路由（`/api/v1/runner/launch` → in-cluster launcher Service）是带外 dashboard 步，无 in-repo YAML 可 PR**。

---

## Spike 须决的横切岔口（汇总）
1. **★A3 image-lock 位置**：种 `cloud/`（匹配已上线 workflow、语义错、惰性 transformer）vs 建 `apps/aster-lang/<runner-ns>/` + 改 workflow LOCK_PATH。文档推到 plan。
2. **★B5 RBAC cluster-first**：launcher SA+Role+RoleBinding 是集群首个建 Job 的 SA；无 manifest 可 mirror（仅 whitelist 允许）。安全一等件（§3b）。
3. **★B6 resources**：128Mi/512Mi 确认太小；文档无固定替代数——实测驱动（§2 容量门）。并发=1 直到容量验收过。
4. **★B7 destinations**：AppProject destinations（aster-lang.yaml:12-19）须加新 launcher/runner ns，否则 ArgoCD 不 sync。
5. **★C9 stdin 注入**：RunnerMain 硬读 stdin；batch/v1 Job 无原生 stdin——真未决 wiring，无 in-repo 先例。
6. **★A4 + admission**：allowed-images.yaml push-ruleset 保护（人工 entry）。runner Job namespace 须手工打标 `policy.sigstore.dev/include=true`（grep 确认 git 缺、仅 aster-cloud 手打，见 POLICY_CONTROLLER_RUNBOOK.md）否则 admission 静默 no-op。
7. SPIRE/SPIFFE：**100% 缺**（k3s apps/argocd grep 零命中）——证 MVP 无 attestation；Slice-2b 范围外。
