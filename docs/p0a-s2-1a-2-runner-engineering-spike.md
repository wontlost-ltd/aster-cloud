# P0-A S2-1a-2 runner 工程 spike：cloud 侧 attested JVM runner 落地

**状态**: SPIKE（工程决策，非实现；executor 已共享 S2-1a-0/-1 上线，本 spike 定 runner 落地边界 + 最大架构缺口，Codex 策略审通过后拆子 spike/plan）
**★与母 spike 区分**: [[p0a-s2-1a-runner-engineering-spike]] 是 executor 提取母 spike（S2-1a-0/-1 已落）；本 `-2-` 是 executor 共享后的 **runner 落地** spike。
**日期**: 2026-07-20
**关联**: [[p0a-s2-1-attested-runner-spike]]（β 母 spike，Codex 6 轮 97；§8 分阶段 S2-1a/b/c；用户拍板形态 B ephemeral Job/on-prem k3s/方案三 finalization receipt/首档 PLATFORM_EXECUTION_VERIFIED）、S2-1a-0/-1（共享 ReplayExecutionCore + executor 提取，PR#150/#151 上线 byte-identical）、S2-0（cosign admission，PR#91 上线）
**目标**: 定「cloud 侧 attested JVM runner」的落地边界——**executor 半可复用，但周边（runner main/打包/镜像/SPIRE/cloud→cluster 触发/签名信封）全须新建**，且暴露 β 母 spike 假设未覆盖的最大现实缺口。

---

## 0. ★★最重要结论（先说，三仓实证——重塑 β 架构假设）

**executor 半今天真可复用；「attested runner」的周边几乎全须从零建。** 而**最大缺口是 β 母 spike 隐含假设的「cloud verifier 启 K8s Job」没有落地基**：

**★★1. aster-cloud 跑在 Cloudflare Workers，不在 k3s 集群内，零 K8s API 访问（load-bearing，主导本 spike）**：`wrangler.toml`/`@opennextjs/cloudflare`/`next 16` 实证；aster-api deployment.yaml:203 明记「aster-cloud BFF 部署 Cloudflare，不在 k3s」。package.json **零** `@kubernetes/client-node`。→ **cloud→cluster 启 Job 无任何 substrate**（CF Worker 拿不到 kubeconfig/SA token，够不到 `kubernetes.default.svc`，只能经 Cloudflare Tunnel 公网 HTTPS）。β 母 spike §6「verifier 按 transition 启双端 Job」**假设 cloud 能直接启 Job——现实不成立**。

**★★2. SPIRE/SPIFFE 100% 缺席**（k3s 全仓 grep spire/spiffe 零命中）→「attested」的 adjective 在集群里**无地基**，是独立平台从零建（母 spike「GitOps-deployable」结构真但完全未实现）。

**★★3. signed ReplayMetadata 不存在**（aster-replay-core 无任何 crypto，只 canonical hash + status）→ workload-bound 签名信封 + 密钥管理 + 与 SPIRE/cosign identity 绑定**全须建**。

**★现实倾向（非替你拍板）**：β 母 spike 的「cloud verifier 直启双端 Job」须改为 **cloud（CF Worker）经公网 HTTPS 调一个 in-cluster「runner-launcher」服务，由它经 SA RBAC 建 Job**——这是信任边界/延迟权衡下的**首选** substrate（**非唯一**——β 队列轮询也可行；γ CF Worker 直连 K8s 因信任边界否决非因不可能）。这重塑了信任边界（launcher 是新 TCB 成员，被攻破威胁模型见 §3b），本 spike §3 展开。

---

## 1. 已实证：EXISTS（可复用）vs MUST BE BUILT（三仓，2026-07-20）

| 领域 | EXISTS（复用） | MUST BE BUILT |
|---|---|---|
| executor core | `ReplayExecutionCore` 三阶段 API（execute/buildDecisionTrace/computeReplayMetadata，无 Quarkus/CDI）+ `DynamicCnlExecutor` + records；干净 `java-library` | runner `main()`、非 CDI `ReplayExecutor` 实现（~15 行仿 `ReplayExecutorAdapter`）、toolchainId 复现（4 常量+1 env） |
| 打包 | — | `application`/shadow-jar gradle task（**今天无**，replay-core 只 `id 'java-library'`）、最小 arm64 JRE Dockerfile |
| CI/签名 | aster-api `deploy.yml` build→arm64-verify→cosign-sign→image-pin-PR 模式 | 新 runner 签名 workflow + 新 OIDC identity |
| admission | S2-0 CIP 模式（2 CIP+allowlist+drift-guard）已上线 | 新 runner allowlist entry + 2 CIP + kustomization + ns label |
| attestation | — | **SPIRE/SPIFFE 100% 缺席**，从零 |
| signed metadata | `ReplayMetadata`（仅 hash） | 签名/attestation 信封（replay-core 无 crypto） |
| cloud 触发 | HTTP `evaluateForCapture`（rule-regression-runner.ts:946） | **整个 Job-launch 机制**——aster-cloud CF Worker 零 K8s 访问 |
| cluster/Job | `migrate-job.yaml` 模板（ttl/backoff/restartPolicy Never/非 root/readOnlyRoot）、arm64 确认 | GraalVM-尺寸资源封套；无 node pool/taint；内存 headroom |

### executor 入口（runner main 复现，实证）
- `ReplayExecutionCore.execute(ReplayExecutionRequest, ReplayExecutor)`→`buildDecisionTrace`→`computeReplayMetadata(toolchainId, ...)`（三阶段，`PolicyEvaluationResource:522-603` 是参考序列，`new ReplayExecutionCore()` 无注入）。
- runner 供**非 CDI `ReplayExecutor` 实现**（仿 `ReplayExecutorAdapter` 40 行，委托 `DynamicCnlExecutor.executeWithTenantContext`）+ `new DynamicCnlExecutor(moduleGraphResolver, modulesEnabled)`（**无 import 用 `new DynamicCnlExecutor()` null resolver**）。
- `ReplayExecutionRequest` 收 raw vocab/aliasSet（index 建在 core，byte-parity 单源）。

### module 解析缺口
executor 任何用 `import` 的 policy 需 `ModuleGraphResolver`（aster-api DB-backed）。standalone runner **要么限 import-free（首版 fail-closed，用户拍板可接受），要么须 module 解析 feed**（受签 ModuleClosure，另 spike）。

---

## 2. 内存/容量现实（Codex 铁律预防——实证，非假设）

- 节点 **4× A1.Flex 1 OCPU/6GB，跑在 54-76% 内存**（`apps/aster-lang/cloud/deployment.yaml:23-30`）；`maxUnavailable` 被迫 0→1 因内存压力排不下 surge pod。aster-api 自身 `-Xmx384m`/`limits 512Mi`。
- ★`DynamicCnlExecutor` 注释明警 GraalVM polyglot **2GB heap/并发 4 会 OOM**；SHARED_ENGINE 正为避免 per-request Truffle init。
- → **短生命周期 runner Job 每次冷启 fresh GraalVM Engine = 内存重**，在已 54-76% 满的节点上：runner Job 须紧资源 request/limit + **首版全局并发默认 1；容量验收（§2 契约）通过后才允许升至 2**（承母 spike「单 Job 单 execution」）+ 可能须**独立节点池/taint**（现无，须建）或错峰。**这是真容量风险非假设**。
- `migrate-job.yaml` 是可复用 Job 模板（ttlSecondsAfterFinished/backoffLimit/restartPolicy Never/automountServiceAccountToken false/非 root/readOnlyRoot+tmpfs）——但其 128Mi/512Mi 封套**对 GraalVM JVM 太小**，须放大。

★**容量验收契约（Codex——非拍脑袋，实测驱动，S2-1a-2 门）**：
- **「并发」定义清**：是单进程内 execution 数 还是集群同时 Job 数？——**默认全局并发先取 1**（母 spike「单 Job 单 execution」）。
- **request/limit 用实测定**：峰值 RSS + p95 冷启动 + 代表性 corpus 决定，非猜。
- **内存预算分清**：JVM heap + direct/native + **Truffle/GraalVM 元空间与 code cache** 余量（executor 注释警 2GB/并发4 OOM，须留足）。
- **失败模式测**：OOM、eviction、排队背压、Job 清理（ttl）。
- ★**先实证「普通 Zulu JRE 25 + Truffle/GraalVM 依赖能在 arm64 容器真跑」**（不能仅由依赖关系推断——GraalVM polyglot 在标准 JRE 上跑可能需特定 flag/JIT 支持；aster-api 用的是同栈但整套 Quarkus 打包，runner 最小镜像须真跑一次证明）。这是 S2-1a-2 首个技术风险验证点。

---

## 3. ★核心架构决策 1：cloud→cluster launch substrate（最大缺口）

β 母 spike「verifier 直启双端 Job」在 CF-Workers 现实下**不成立**。三个候选（拍板）：

### 形态 α：in-cluster runner-launcher 服务（推荐）
- 集群内新起一个小服务（有 SA + BatchV1 RBAC），暴露 HTTPS API（经 Cloudflare Tunnel）；aster-cloud（CF Worker）**调它**（HMAC/mTLS 认证，复用现有 InternalCaller 模式）；launcher 经 SA 建 digest-pinned runner Job，收集证据回传。
- **优点**：CF Worker 只需公网 HTTPS（够得到）；K8s 凭据留集群内不出边缘；Job 编排/RBAC 集中。
- **★信任影响（诚实）**：launcher 是**新 TCB 成员**——它决定启哪个 runner digest、转发哪个 challenge、收哪份证据。launcher 被攻破 = 可启假 runner / 篡改证据路由。故 launcher 须：自身受 attestation（SPIRE/最小镜像 cosign-verified admission，复用 S2-0）+ 不自产证据（只编排，证据由 runner SVID 签，verifier 独立验）+ 审计。这与母 spike「β 只防 aster-api 攻破不自动防 runner 自身攻破」一脉——launcher 同理须加固。
- **代价**：新服务 + RBAC + Tunnel 路由 + 认证。

### 形态 β：K8s CronJob/controller 轮询队列
- cloud 把 replay 请求写一个队列（DB/对象存储）；集群内 controller 轮询→建 Job。
- **优点**：cloud 无需同步等；解耦。**缺点**：延迟（轮询）；队列成新信任面（谁能写队列=谁能触发 runner）；challenge 时序（母 spike 要 challenge 一次性）复杂化。

### 形态 γ：给 CF Worker 直接 K8s 访问
- **★因信任边界/运维否决（非「技术不可行」——Codex 纠正）**：CF Worker **技术上能**存 secret（`wrangler.toml` 已用 Worker secrets/HMAC），也**能**经隧道暴露 kube-apiserver + 配受限凭据。但：(a) 边缘持 K8s 凭据 = 凭据出集群，泄露面大；(b) 暴露 apiserver 到公网/隧道 = 集群攻击面剧增；(c) CF Worker 环境限制（无长连/受限运行时）使 K8s client 运维差。**因信任边界不可接受 + 运维代价极差而否决，非因不可能**。

**★推荐 α**（in-cluster launcher）——★**非「唯一可行」（Codex 纠正——β 队列也可行）**，而是**信任边界与延迟权衡下的首选**：α 同步、challenge 时序简单、凭据留集群；β 队列解耦但引入轮询延迟 + 队列成新触发信任面。α 首选，β 作降级/异步备选。launcher 加固见 §3b（launcher 被攻破的**威胁模型骨架 + 必须绑定清单**，非「已完整」）。

---

### 3b. ★launcher 被攻破威胁模型（Codex——「自身 attested+审计」只证启动时用获准镜像，不约束运行时被攻破的 launcher）

「launcher 自身 cosign-verified admission」只证 **launcher 启动时用了获准镜像**，**不约束一个运行时已被攻破的 launcher**。被攻破的 launcher 能：
- **启假 runner digest**（启一个未获准/被篡改的 runner）；
- **丢弃/重排/替换 challenge**（母 spike 要 challenge 一次性 + 绑执行）；
- **路由/替换证据**（把 A 的证据当 B 的回传，或回放旧证据）；
- **改传给 runner 的 launch 参数**（source/input/toolchain 目标）。

**★什么能约束、什么不能（Codex 第2轮——须绑完整 execution tuple，非只 input hash）**：
- **runner SVID 对 execution envelope 的内层签名** = launcher **无法伪造**（无 runner 私钥）→ verifier 独立验 SVID + envelope 绑定。这是核心保护，但**不充分**。
- **须绑「完整 execution tuple」**（仅绑 input hash 仍容跨租户/跨请求/baseline-current 证据嫁接）：`tenantId + transition/report/case id + baseline|current role + RunnerArtifactManifest hash + source/input/toolchain hash + challenge + audience/requestId`——全进 verifier 侧 commitment，runner envelope 签同一 tuple。
- **launch 参数不因 imageID 就可信**（launcher 控制）：
  - **imageID 须可信观察路径**（非 launcher 自报）+ 闭合 `SVID ↔ SPIFFE selectors ↔ Pod UID ↔ actual imageID`——**此闭包的机制定义以母 spike [[p0a-s2-1-attested-runner-spike]] §5「实例关联」为准**（SPIRE selectors / controller receipt / mTLS 平台映射三选一）；本 §3b 只指出 launcher 攻破场景须依赖该闭包，不另立机制。防 launcher 用可控 SA/label 启任意 Pod 冒 runner 身份。
  - **imageID ≠ launch spec 可信**：还须绑 command/args/env/**JVM flags**/mount/SA/sidecar/initContainer/SPIRE socket/securityContext——归一为 verifier 派生的 **`launchSpecDigest`** 或受信 admission/controller receipt。
  - **challenge/授权/幂等键**：verifier 侧按 tenant/request **原子一次性消费 + 过期约束**（launcher 丢/换/回放 → 未消费/不匹配/过期 → 拒）。
**★结论（收窄——不称「完整威胁模型」，Codex）**：这些绑定**齐全并落地后**，launcher 降为「不可信编排者」（能扰可用性，其伪造尝试被 verifier 拒）。但「不能让假证据 finalized」**不只靠 S2-1b 签名**——还依赖 **S2-1c 的 finalization 唯一入口**（母 spike §7 `verifyRunnerEvidenceBundle→...→isFinalizedSignablePass`）真按 tuple 验。**本 §3b 是威胁模型的骨架 + 必须绑定清单，非「已完整」**；完整验证在 S2-1b（签名+SVID/imageID/launchSpec 派生）+ S2-1c（finalization 消费）联合落地。MVP（§4 无签名）**完全不具备**这些——不抗 launcher 攻破（诚实）。

## 4. ★核心架构决策 2：attestation 根（SPIRE 从零 vs 简化首版）

**★单一真相源（Codex——避免与母 spike 双写）**：SPIRE/workload-bound 签名的**阶段归属与派生链定义**以母 spike [[p0a-s2-1-attested-runner-spike]] §8 为准（S2-1b = SVID 内层签 + verifier 派生链；S2-1c = finalization receipt）。本 §4 只补 **CF-Workers 现实新增的 runner 落地视角**（SPIRE 缺席的地基缺口 + MVP 为何先不含它），不重新定义阶段边界。

母 spike 定 β 达 `PLATFORM_EXECUTION_VERIFIED` 靠 SPIRE workload-bound 签名（母 spike §5/§8-S2-1b）。但本仓实证 **SPIRE 100% 缺席**，从零建是大工程。故本 spike 视角下的分层：

### 首版（S2-1a-2 = runner **integration/parity milestone**，★非 attestation 安全增量——Codex 纠正）
- runner 镜像嵌共享 executor + 独立重执行 + 产 ReplayMetadata。
- **暂不 SPIRE 签名**——证据**不喂 signability gate**（原报告仍 UNSIGNABLE）。
- ★**诚实价值收窄（Codex——不夸大「证 byte-parity」）**：母 spike 已论证 runner 与 aster-api **跑同一份代码**（S2-1a-1 共享 executor）→ byte-parity 近乎**定义性**，不是新证明。故 MVP 差分门证的是**集成正确性**（runner 的 main/打包/Dockerfile/launcher 编排/Job 环境**没在共享代码外引入分叉**——如 locale SPI 装载/JVM flag/内存/冷启动 GraalVM 状态差异），**不是** executor 算法独立性（那要 TS 二引擎，母 spike 已定 TS 是非签字级 differential checker）。
- ★**MVP 不提供任何 attestation 安全性**：无签名 → **不抗 aster-api 攻破、不抗 launcher 攻破、不解锁签字**。它建的是 **runner 骨架（main/打包/镜像/CI/admission/launcher/Job）+ 集成 parity 门**，为 S2-1b（签名才有安全增量）铺路。**称它 runner integration/parity milestone，不称 attestation 增量**。

### S2-1b（SPIRE + workload-bound 签名，才达 PLATFORM_EXECUTION_VERIFIED）
- SPIRE 平台部署（GitOps ApplicationSet，从零）+ runner SVID 内层签 envelope（母 spike §5）+ verifier 派生链（§6）。**这步才解锁签字**（配 S2-1c finalization receipt）。

★**诚实分层**：S2-1a MVP 建 runner 骨架 + **验证共享代码外的集成 parity**（检测打包/镜像/launcher/Job 环境分叉，非证算法独立性——见 §4 收窄），**不碰 SPIRE/签名**（那是 S2-1b）；否则一刀塞 SPIRE+签名+launcher+镜像 = 不可控大工程。

---

## 5. runner 镜像 + CI + admission（S2-0 模式复用，实证）

- **打包**：aster-replay-core 加 `application` plugin + `mainClass`（或 shadow-jar），产 runnable fat-jar（**今天无**）。
- **Dockerfile**：新最小 arm64 JRE 25 镜像（`azul/zulu-openjdk-alpine:25-jre` 仿 Dockerfile.jvm 但**无 Quarkus/Postgres/Redis**）+ fat-jar + GraalVM polyglot/truffle runtime deps。**必须真 arm64**（deploy.yml 有 arm64-content verifier 防 QEMU 误标，runner CI 须同）。
- **CI 签名 workflow**：仿 `aster-api/.github/workflows/deploy.yml`（build→arm64-verify→cosign keyless sign→image-pin-PR），新 OIDC identity（如 `.../aster-replay-runner-deploy.yml@refs/heads/main`）。★runner 在 aster-api 仓（settings.gradle include），故 workflow 在 `aster-cloud/aster-api` 仓。
- **admission（复用 S2-0）**：k3s 加 `wontlost/aster-replay-runner` 的 allowlist entry + 2 CIP（digest-verify keyless + reject-tag static:fail）+ kustomization。★**runner Job 须跑在贴 `policy.sigstore.dev/include=true` 的 ns**（现只 aster-cloud ns 贴且手工非 Git）——runner Job 的 ns 须确保贴标签，否则 admission 静默不生效（母 spike 已警）。

---

## 6. 推荐分阶段（诚实，承母 spike §8）

**S2-1a-2（runner integration/parity milestone：骨架 + 集成 parity，★无 attestation 安全性、不解锁签字）**：
1. runner `main()` + 非 CDI ReplayExecutor + fat-jar 打包（aster-replay-core 加 application/shadow）。
2. 最小 arm64 Dockerfile + CI 签名 workflow + runner CIP（S2-0 模式）。
3. **in-cluster runner-launcher 服务**（形态 α）+ SA RBAC + Tunnel 路由 + cloud→launcher HMAC 认证。
4. cloud `evaluateForCapture` 增「调 launcher 启 runner Job + 收 ReplayMetadata」路径（暂不签名，不喂 gate）。
5. **集成 parity 差分门**（机制=逐字节比对，声明=集成 parity 非算法独立性，见 §4）：runner 产的 ReplayMetadata 与 aster-api 生产的**逐字节比对**（同一份 executor 代码，理应 100%；任何分叉即 runner 打包/镜像/launcher/Job 环境在共享代码外引入了差异，差分门守此回归）。
6. GraalVM 内存封套调优 + 首版并发默认 1（容量验收通过后才升 2）+ import-free fail-closed。
**先出这步详细 spike/plan**（仍大工程，但不含 SPIRE/签名）。

**S2-1b（SPIRE + workload-bound 签名）**：SPIRE 平台部署 + runner SVID 签 + verifier 派生链——**才解锁签字**。

**S2-1c（finalization receipt gate + 两档 policy）**：母 spike §7 唯一链。

**ModuleClosure 协议 spike**（runner 侧受签 module 解析）：首版 import-free fail-closed 后补。

**S2-2（γ-SEV，长期）**：银行档抗运营方。

---

## 7. 决策点（★用户已拍板 2026-07-20）

1. **launch substrate（§3）**：✅ **拍板 = 形态 α in-cluster runner-launcher 服务**（集群内小服务持 SA+BatchV1 RBAC，cloud 经 Cloudflare Tunnel HMAC 调它建 digest-pinned runner Job）。β 队列作降级/异步备选；γ（CF Worker 直连 K8s）因信任边界/运维否决（非技术不可行）。
2. **首版是否含 SPIRE/签名（§4）**：✅ **拍板 = MVP 先建骨架 + 集成 parity 差分门，不碰 SPIRE**（S2-1a-2 = runner integration/parity milestone，不解锁签字、不含 attestation 安全性；SPIRE+签名统一归 S2-1b）。
3. **launcher 信任加固**：✅ **拍板蕴含**（跟随 α + §3b 威胁模型骨架）= launcher 只编排不产证据（证据仍 runner SVID 签，S2-1b）+ launcher 镜像 cosign-verified admission（复用 S2-0）+ 审计；§3b 完整绑定清单在 S2-1b/-1c 落地。
4. **runner Job ns**：⏳ 待 S2-1a-2 详细 plan 阶段定（默认倾向**新建 runner ns**——隔离 launcher/runner RBAC 与 aster-cloud BFF ns，须贴 `policy.sigstore.dev/include=true` 标签 + 加 ArgoCD destinations；此为 plan 阶段工程细节，非架构拍板项）。
5. **下一步**：✅ **拍板 = 先出 S2-1a-2 runner MVP 详细 spike/plan**（骨架+集成 parity 差分门，α launcher，不含 SPIRE）。

---

## 8. 本 spike 不做什么

- ❌ 不写 runner/launcher/SPIRE 任何实现（等拍板）。
- ❌ 不假装 cloud 能直启 K8s Job（CF Worker 零 K8s 访问，须 launcher substrate）。
- ❌ 不假装 SPIRE 已在或「attested」有地基（100% 缺席，从零）。
- ❌ 不假装 MVP 是 attestation 安全增量（无签名=不抗 aster-api/launcher 攻破/不解锁签字；它是 integration/parity milestone，parity 证集成非算法独立性）。
- ❌ 不称 α「唯一可行」（β 队列也可行；α 是权衡首选）；不称 γ「技术不可行」（因信任边界否决）。
- ❌ 不假装「launcher 自身 attested」就防其运行时被攻破（须 verifier 独立验**完整 execution tuple**（tenantId+transition/report/case+baseline/current role+artifact manifest hash+source/input/toolchain+challenge+audience/requestId）+ 可信观察 imageID/launchSpecDigest + runner SVID 签，§3b）。
- ❌ 不复制 executor/parser 到 runner（复用共享 aster-replay-core，S2-1a-1 已保证唯一份）。
- ❌ 不让 runner 跑在未贴 admission 标签的 ns（静默失效）。
- ❌ 不用 migrate-job 的 128Mi 封套跑 GraalVM（OOM）。

## 附：引用路径
`aster-api/aster-replay-core/src/main/java/io/aster/{replay/core/ReplayExecutionCore,policy/parser/DynamicCnlExecutor}.java`、`aster-api/.github/workflows/deploy.yml`、`aster-api/Dockerfile.jvm`、`k3s/apps/infrastructure/policy-controller/`、`k3s/.github/image-pin/allowed-images.yaml`、`aster-cloud/{wrangler.toml,src/services/policy/rule-regression-runner.ts:946}`、`k3s/apps/aster-lang/cloud/deployment.yaml:23`、`k3s/apps/*/migrate-job.yaml`。证据由 Explore agent 三仓实证（CF-Workers 零 K8s/SPIRE 缺席/replay-core library-only 无 main/S2-0 CIP 模式/6GB 节点 54-76% 内存）+ 主 AI 核对。

## 附 B：S2-1a-2 详细 spec 前置事实（Explore agent 三仓 file:line 实证，2026-07-20——供下一份 brainstorming/spec 复用）

**打包（今天全无，须建）**：`aster-replay-core/build.gradle` 只 `id 'java-library'`，**无 `application`/无 shadow 插件、无 `main()`**（grep `public static void main` 零命中）。runner 须加 `application`+`mainClass` 或 shadow-jar 产 fat-jar。→ spec 首个设计问题：`application` plugin vs shadow-jar（阴影冲突/SPI META-INF 合并策略是决策点）。

**★★byte-parity 头号陷阱（已实证）**：locale artifacts（en/zh/de/hi）在 `build.gradle:45-48` 是 **`testRuntimeOnly`**——**不在主运行时 classpath**。runner fat-jar **必须**把 `cloud.aster-lang:aster-lang-locales-{en,zh,de}` + `cloud.aster-lang:aster-lang-hi` 提升为真 `runtimeOnly`，否则非英文 replay 解析失败/静默分叉。SPI = `java.util.ServiceLoader`（`LexiconRegistry.discoverPlugins()`，3 遍重试容多副本竞态），provider 文件 `META-INF/services/aster.core.lexicon.LexiconPlugin`（en=`aster.lang.en.EnUsPlugin`/zh=`ZhCnPlugin`/de=`DeDeLexiconPlugin`/hi=`HiInPlugin`）。fat-jar 打包须保 SPI 文件合并（shadow 的 ServiceFileTransformer 或 application plugin classpath）。

**Truffle-on-stock-JRE（首个技术风险验证点，仍未证）**：`DynamicCnlExecutor.java:96-98` 静态 `SHARED_ENGINE` 已设 `.option("engine.WarnInterpreterOnly","false")`，代码注释「CE 版本无 JIT 是已知情况」→**解释器模式是设计内预期**。但 spec 的 plan 首个任务仍须**实测**：stock `azul/zulu-openjdk-alpine:25-jre`（Dockerfile.jvm 现用同镜像但走 Quarkus fast-jar）+ Truffle fat-jar 在 **arm64 容器**真跑一次并证 byte-identical。本地 JDK 是 Oracle GraalVM 25（有 JIT），**证不了** stock JRE 解释器路径——须 podman 真构建真跑。除 `WarnInterpreterOnly` 外全仓无其他 `-Dpolyglot.*`/`-Dtruffle.*` flag。

**runner main 形状（全签名实证，可直接写 spec 接口块）**：
- `ReplayExecutionCore`：`public final class`，**隐式 no-arg 构造**；三阶段 `execute(ReplayExecutionRequest, ReplayExecutor) → ExecutionPhaseResult` / `buildDecisionTrace(ReplayExecutorResult, TraceAccess.DrainResult, boolean) → DecisionTrace` / `computeReplayMetadata(String toolchainId, Object context, ReplayExecutorResult, DecisionTrace, TraceAccess.DrainResult) → ReplayMetadata`。
- `ReplayExecutor` 接口（runner 供实现，仿 aster-api `ReplayExecutorAdapter`）：`execute(String tenantId, String source, Object context, String functionName, String locale, IdentifierIndex vocabIndex, boolean legacyEvaluateSentinel, Map<SemanticTokenKind,List<String>> aliasSet, boolean aliasesTrusted) → ReplayExecutorResult`；★异常**原样透传不 wrap**（接口 doc 强制，保 4 类 HTTP 映射一致）。
- `DynamicCnlExecutor` 双构造：`()` = `this(null,false)`；`(ModuleGraphResolver, boolean modulesEnabled)`。首版 import-free fail-closed → 用 no-arg（null resolver）。
- `ReplayExecutionRequest` 收 raw vocabulary/aliasSet（index/aliasSet 建在 core，byte-parity 单源）。

**cloud 触发点（launcher hook 处）**：`rule-regression-runner.ts:942-979` **私有** `evaluateForCapture(params)` → `PolicyApiClient.evaluateSource(source, input, {replayCapture:true})`（`policy-api.ts:384-426`）→ `POST /evaluate-source?replayCapture=true`。认证 = `signInternalCallerHeaders`（`api-signing.ts:100-128`，**7 行换行 canonical** `method\npath\nts\nnonce\nbodyHash\ntenant\nrole`，unix 秒，secret `ASTER_PLAN_GATE_HMAC_KEY` 同 aster-api Vault `apps/aster-api-plan-gate.hmac-key`，header `X-Internal-Caller: cloud-bff`）——**launcher 复用此 HMAC 方案**。★注意：`/evaluate-source` 受 aster-api `InternalCallerFilter` + `RequestSignatureFilter`（per-tenant）双层 HMAC 保护（承 [[p0a-e2e-local-verification]] 两层陷阱）。

**k3s 复用/新建**：`migrate-job.yaml` 模板（`ttlSecondsAfterFinished:86400`/`backoffLimit:2`/`restartPolicy:Never`/`automountServiceAccountToken:false`/`runAsNonRoot`/`readOnlyRootFilesystem`/`drop:[ALL]`/tmpfs emptyDir）**可仿但 128Mi/512Mi 封套对 GraalVM 太小须放大**；`allowed-images.yaml`（version:1/oidcIssuer/images[{image,sourceRepo,workflowFile,sourceRef}]）是**受 push ruleset 保护的信任根**，runner 上线须**人工加第 3 条 entry**（非自动 PR）。★build vs runtime JDK 厂商不一致（CI=Temurin 25 via setup-java；Dockerfile.jvm 运行时=Azul Zulu 25-jre）——runner spec 须显式定死运行时 JDK 厂商+版本烘进镜像（承母 spike「运行时闭包烘制品非可变 env」）。

**★下一步（brainstorming → spec，非直接 plan/实现）**：本 spike 是工程决策文档；S2-1a-2 MVP 是跨子系统大工程（runner 打包 + Dockerfile + CI/cosign + k3s admission + in-cluster launcher + cloud 触发 + 集成 parity 门），须走 brainstorming（逐一拍板：application vs shadow-jar / launcher 独立服务 vs 扩展现有集群内组件 / parity 差分门在 CI 如何跑）→ spec → writing-plans → subagent-driven 实现。
