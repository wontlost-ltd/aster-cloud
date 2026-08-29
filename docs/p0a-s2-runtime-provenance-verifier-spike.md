# P0-A S2 架构 spike：runtime provenance verifier（层3）——首个可签字 PASS 的路径与其硬约束

**状态**: SPIKE（决策文档，非实现；待你拍板信任根策略后再落 epic）
**关联**: [[p0a-m15-runtime-provenance-spike]]（m1.5 六层信任模型 + S0/S1）、[[p0a-signability-policy]]、[[p0a-toolchain-trust-decision]]（Item 4 六层）、S1 三 PR（层5，已上线）
**目标**: 让 `isSignablePass` 有条件转 `true`——产出**首个 CCO 可签字的绿色 PASS**。当前 `deriveUnsignableReasons`（rule-regression-runner.ts:1512-1517）对任何 `status===PASS` 报告**恒加** `TOOLCHAIN_PROVENANCE_UNVERIFIED` → 恒 UNSIGNABLE，无可翻 true 开关。

---

## 0. ★★最重要的诚实结论（先说，因为它决定一切）

**在当前节点硬件上，「硬件级、防伪造」的层3 provenance 不可达。**

- 节点集群 = 4× OCI `VM.Standard.A1.Flex`（**Ampere ARM64**，Armv8.2-A，`k3s/apps/aster-lang/cloud/deployment.yaml:24` 实证）。
- Ampere Altra **无 Arm CCA/Realm**（CCA 需 Armv9-A + RME）、**无 TrustZone 远程 attestation 暴露给租户 VM**、**无 vTPM**；OCI 的 confidential VM（SEV-SNP）**只在 x86 E 系列**，不在 A1 ARM shape。
- 故**没有 CPU 厂商级、执行者无法伪造的信任根**可用。

**在此硬件上层3 能做到的天花板 = SPIRE（软件 attestation）**，其信任根 = **k8s 控制面 / 集群运营方**。★Codex 复审修正：**不是**「只能用 k8s_psat」——SPIRE 还有 `x509pop`/`tpm_devid`/`join_token`/自定义 attestor；准确说法是「**当前 A1 配置无现成的硬件隔离级 node attestor**，`k8s_psat` 是最低成本的 k8s 原生选择」。用 `k8s_psat` 时根 = kube-apiserver SA token 签名密钥。这与现有 Vault k8s-auth **共享 k8s 控制面这一上游权威**（非同一最终签名密钥——SPIRE 签自己的 SVID/CA 链，Vault 签 Vault token）。SPIRE 比「进程自签」强（短期轮转 X.509 SVID、标准化 workload 身份），但**对「集群运营方被攻破/作恶」不设防**——运营方控制面/SPIRE 注册项/调度权 → 能构造受 SPIRE 接受的 node/workload 身份。

★**一条我漏写的更强节点身份路径（Codex 补）**：**OCI Instance Identity**——OCI 为每台 Compute instance 签发 Oracle CA 签的唯一 X.509 instance identity 证书。经自定义 SPIRE attestor / 谨慎评估的 `x509pop` 可把节点根从「只信 k8s」提到「**Oracle 证明这是某台 OCI instance**」。但它**只证「请求来自某 OCI instance」**——不证节点 boot/runtime measurement、不证 Pod 实际镜像、不证 aster-core 真被调用、不证 aster-api 未被攻破、不证返回内容与真实执行一致。故它是更强的**节点身份**，**不是**所需的硬件 workload attestation 根。

**★★最关键的诚实收窄（Codex 抓的我的自我欺骗）**：SPIRE/SVID 证明 **workload 身份**，**不证明 workload 对响应内容诚实**。**被攻破的 aster-api 进程持有自己的 SVID/私钥**（或能经 Workload API 取证书 / 请 sidecar 代签），→ 它能用**合法** workload 身份签署**假的** `runtimeToolchainId`、假 hash、甚至根本没执行的结果。所以 SPIRE 的保障是「这份签名由获准某 SPIFFE ID 的 workload 签出」，**不是**「该 workload 正确执行了目标 artifact 且声明真实」。**默认下 SPIRE 连「防 aster-api 进程被攻破」都做不到**——除非签名组件**独立观察/执行**核心计算（见 §4「只签 body 不够」）。

**含义**：S2 若走 SPIRE，最诚实的定位是「**受控平台身份 attestation**（cluster-operator-rooted，且默认不防被攻破的 app 自签谎言）」，**不是**「密码学/硬件级不可伪造」，**也不是**「防进程攻破」（除非加独立执行/测量）。这决定 signability 口径——见 §4。

---

## 1. 已实证现状（两 Explore agent + 我直接核对）

| 层 | 现状 | 证据 |
|---|---|---|
| 层1 唯一性 | ✅ build/core=真值（S0 已上线） | ToolchainIdentityProvider |
| 层2 artifact authenticity | 🟡 **CI/PR 时** cosign 验签 digest（digest-pin epic）——但**不在集群 admission/runtime 强制** | k3s image-lock.yaml + verify-image-pin.sh:163；★运行时无 admission 重验签，运营方可跑任意 digest |
| **层3 runtime binding** | ❌ **完全缺**。aster-api evaluate 响应**无签名**（`EvaluationResponse` 无 signature 字段，全仓 evaluate 路径零非对称签名，只有 inbound HMAC）；`runtimeToolchainId` 是**自报 config 串** | PolicyEvaluationResource.java:612-638；ToolchainIdentityProvider.java:26（读 aster.runtime.build） |
| 层4 execution binding | 🟡 **inbound 有**（request nonce + UsedNonce 防重放 + 5min 窗，InternalCallerFilter canonical `method\npath\nts\nnonce\nbodySha256\ntenant\nrole`），但**响应无 nonce/绑定** | api-signing.ts:30；UsedNonce.java:97 |
| 层5 transition authorization | ✅ S1 已上线（签名 upgrade-manifest） | regression-upgrade-manifest.ts |
| SPIFFE/SPIRE / mesh / admission-签名 | ❌ **全缺**（grep 零命中）；但 SPIRE **可 GitOps 部署**（ArgoCD platform ApplicationSet，ARM 兼容） | k3s grep 零；platform.yaml:12 |
| cloud 侧自建 runner 能力 | ❌ 无。回归 replay **严格远调 aster-api**（`evaluateForCapture`→`/evaluate-source?replayCapture=true`）；cloud 有 aster-lang-ts browser 引擎但**只用于 demo/编辑器**，不产 ReplayMetadata | rule-regression-runner.ts:946；package.json:53 |

**关键**：签名要落地，必须**新建**——aster-api 零非对称签名基建，cloud 零 attested 执行能力。

---

## 2. 层3 子方案（诚实标注每个的信任根 + 到第几层）

回放执行现在在 **aster-api**（cloud 远调）。层3 签名有两个落点：

### 方案 α：aster-api 响应侧 SPIRE-attested 签名（在执行者环境签）
每节点跑 **SPIRE Agent DaemonSet**（`k8s_psat`），aster-api workload 经挂载的 **Workload API socket** 取 workload SVID（★不是「pod 内装 agent」——拓扑是 per-node agent + workload 挂 socket，别误判部署形态）；一个 **response-signing sidecar / 或 app 内 go-spiffe** 对 `EvaluationResponse`（含 ReplayMetadata）签名，附 SVID。cloud 用 SPIRE trust bundle 验签。
- **信任根**：k8s 控制面（PSAT）。
- **到第几层**：层3（软件根）+ 层4（若签名体含 request nonce + input/output hash + 时间窗）——**但见下，naive 实现连层3 都不算**。
- **★★致命细节（Codex 复审强化）**：SVID 只证「这字节来自 attested workload」，**不证自报 `runtimeToolchainId` 真实**；且**被攻破的 aster-api 持有 SVID 私钥，能签任意谎言**。「SVID selector 绑 image digest + admission」**仍不够**——k8s selector 来自 kubelet/CRI 元数据非硬件独立测量；admission 只证「API 创建时策略允许了某镜像」，不证响应时仍是该执行实体；运营方能改 webhook/注册项/调度；被攻破进程仍能用合法 SVID 签谎言；sidecar 若无法独立观察执行只是代签者。**平台级 α 至少要做到**：(1) verifier 从**可信控制面/CRI 证据**取实际 imageID（**不用** app body 里的 digest）；(2) verifier 用**受信 digest→toolchain manifest 映射**派生 toolchain，**忽略自报串**；(3) 签名组件**独立构造 canonical envelope**（非签任意字节）绑 challenge+input+output+实际 image digest+workload identity+time+audience+版本；(4) **若要防 app 进程造假，签名组件必须独立观察或执行核心计算，不能只接收 app 提交的结果**。★而 (4) 实际把 α **推向隔离执行/验证 sidecar ≈ β**。
- **代价**：aster-api 新增 SPIRE 集成 + **独立取证的**（平台观察 imageID，非硬件 measurement，非代签）response 签名层 + cloud 验签；且需层2 admission 补齐（现无）。

### 方案 β：cloud 侧 attested runner（在 cloud 平台重跑 replay）
cloud 起一个 **pinned-digest 的 aster-core runner**（新建，现无），由 cloud 平台 SPIRE attest，runner 对自己的执行证明签名。
- **信任根**：cloud k8s 控制面（同 α，PSAT）。
- **到第几层**：层3（软件根）——★但**仅当** runner 由平台 attestation 背书（非 runner 自签软件 key，否则退化声明级，见 [[p0a-m15-runtime-provenance-spike]] 自审更正）。
- **★致命工程**：cloud 现**无**权威执行能力（aster-lang-ts browser 引擎不产 ReplayMetadata；且 TS↔Java 有 liftDecimals parity gap，ReplayMetadata.java:26-48）。要 cloud 权威重跑=在 cloud 起 JVM aster-core + 复现整个 ReplayMetadata 契约=**大工程**。
- **★β 的独立价值（Codex 复审修正——我之前说「无优势」是错的）**：对**「集群运营方作恶」**β 与 α 相同（同 PSAT 根，均无防护）；但对**「单独攻破 aster-api 但控制面未失陷」**——β **独立重执行、不接受 aster-api 自报结果**，故能进程隔离、不共享 app 漏洞/运行状态、检测 aster-api 造假 → **显著强于 α**。故：只防部署漂移 → α 更划算；要抗 aster-api 进程攻破 → β/隔离 verifier 才有独立价值；抗集群运营方 → 两者都不行，须 γ-SEV。★**边界（勿过度解读）**：β 只防**「aster-api 被攻破」**，**不自动防「β runner 自身被攻破」**——β 把可信执行的责任转移到隔离 runner，须同样对 runner 做 attestation/加固，别把 β 理解成通用进程攻破防护。

### 方案 γ：硬件根（提供不可伪造所需的**根**，但根≠完整证明）
把 verifier workload 搬到有硬件信任根的节点，attestor 用 CPU/TPM quote。

★**Codex 复审 P0——「SEV-SNP TEE」与「普通 TPM 节点」不可混为一谈，抗运营方能力天差地别**：

- **γ-SEV：AMD SEV-SNP（或同级 TEE，如 Intel TDX）**——内存加密 + guest 与 host/hypervisor 隔离。在适当协议下**可把 host/hypervisor/云运营方排除出 TCB**。但**guest 内的 k8s 管理员 / guest root 是否在 TCB 取决于部署边界**（若 verifier 与管理员共 guest OS，管理员仍能改进程/调密钥——须把 verifier 放进最小化、管理员不可进的 guest 或独立 confidential pod）。
- **γ-TPM：普通 TPM measured boot / quote**——**不足以抗运营方**。它只证**启动链 PCR 状态**、可按 PCR 封存密钥；但**通常不为已启动 guest 内的 verifier 提供持续执行隔离**：guest root / k8s 管理员在合法启动后可改进程、调用已解封密钥、滥用签名路径。除非再叠加 **DRTM + 隔离 verifier + 严格 TPM policy/session（不可被 root 滥用的签名路径）**，否则**只能标「启动完整性」，不能标「抗运营方」**。

- **信任根**：γ-SEV = CPU 厂商 TEE（执行者无法伪造的隔离执行 + 测量）；γ-TPM = TPM 启动测量（仅启动链，**非**运行时隔离）。
- **★共同收窄——quote 本身只证「某测量状态/TEE 存在」，不证「业务响应」**。要真到不可伪造的层3/4，还需：verifier 校验 measurement policy + challenge 放进 attestation `report_data` + **仅向合格 measurement 释放响应签名密钥** + 签名密钥留隔离环境 + 绑 request/output/image/toolchain commitment + 防运营方把合法 quote 与另一次伪造响应拼接 + 明确 guest 内 k8s 管理员是否仍在 TCB。否则运营方能让合规 TEE 产 quote，再由外部恶意 workload 返回结果。
- **准确定位**：**硬件隔离根（SEV 级）+ measured verifier + key release + challenge/response 绑定** 组合才抗运营方；**普通 TPM ≠ 抗运营方**，不是「换任何硬件即真」。
- **代价**：**改硬件/加节点**——当前 Ampere A1 **既无 SEV/TDX 也无对租户暴露的 vTPM**（OCI SEV-SNP 只在 x86 E 系列），故 γ-SEV 需换 x86 confidential shape；γ-TPM 需带 vTPM/物理 TPM 的节点且仍不足以抗运营方。**唯一「防集群运营方作恶」路径 = γ-SEV + 完整协议**。**不推荐作为 MVP**，但**是银行级客户最终要的**——诚实列为长期。

---

## 3. 子方案对比矩阵

| 威胁 / 方案 | α aster-api SPIRE 签响应 | β cloud attested runner | γ-TPM 普通 TPM 节点 | γ-SEV SEV-SNP TEE+完整协议 | 现状(不做) |
|---|---|---|---|---|---|
| 信任根 | k8s 控制面(软件) | k8s 控制面(软件) | TPM 启动测量(仅启动链) | **CPU TEE(隔离执行)** | 无 |
| 防「部署漂移/非特权错误」 | ✅ | ✅ | ✅ | ✅ | ✗ |
| 防「aster-api 进程被攻破自签谎言」 | ✗(除非独立测量/执行→≈β) | **✅(独立重执行, 不信 aster-api 自报)** | 🟡(仅证启动, 运行时可被 guest root 改) | ✅ | ✗ |
| 防「集群运营方作恶」 | ✗ | ✗(同根) | ✗(guest root/管理员仍可滥用) | ✅(须完整协议 + verifier 隔离出管理员) | ✗ |
| 需新建 | SPIRE + aster-api **独立取证**签名层(平台观察 imageID) + cloud 验签 + **层2 admission** | SPIRE + **cloud 权威 aster-core runner(大)** | vTPM 节点 + DRTM/隔离 verifier + 严格 TPM policy | **换 x86 confidential shape** + measured verifier + key-release + challenge 绑定 | 无 |
| 硬件可行(当前 Ampere A1) | ✅ | ✅ | ❌(无对租户暴露 vTPM) | ❌(无 SEV/TDX, 需 x86 E 系列) | — |
| 解锁签字口径 | 「平台 artifact-bound(独立取证 imageID), 非硬件级, 默认不防进程攻破」 | 「平台 attested + 抗 aster-api 攻破(独立执行)」 | 「启动完整性, **非**抗运营方」 | 「硬件 measured, 抗运营方」 | 恒 UNSIGNABLE |

---

## 4. signability 口径的诚实抉择（★核心决策）

层3 达成后，`deriveUnsignableReasons`（:1512-1517）增 m1.6 分支：provenance 证据齐 → **不加** `TOOLCHAIN_PROVENANCE_UNVERIFIED` → PASS 报告可 SIGNABLE。但**「证据齐」的强度 = 信任根强度**，故 signability 语义必须诚实分级：

★**Codex 复审：不要只加一个模糊的 `SIGNABLE_PLATFORM_ATTESTED` 枚举**（将来「平台档能不能签」会二次歧义）。拆**两条正交轴**：

- **`attestationAssurance`（证据强度，客观事实）**——★Codex 复审 P1：原四档把「信任根强度」「artifact binding」「execution/content 完整性」三个正交属性压进一序，尤其 `PLATFORM_ARTIFACT_BOUND` 同时背「镜像绑定」+「抗进程造假」（是两回事）。**拆成五档**：
  - `DECLARED`——自报（现状）。
  - `PLATFORM_IDENTITY`——SVID 证 workload **身份**。★**不证跑的是哪个 artifact，也不证内容诚实**——故即便某弱 policy 接受它作身份诊断，**也不无条件移除** `TOOLCHAIN_PROVENANCE_UNVERIFIED`（它没解决层3 toolchain provenance）。
  - `PLATFORM_ARTIFACT_BOUND`——平台**观察到的** image binding：平台证据（可信控制面/CRI，★由集群平台提供，**非硬件 measurement**，勿称「独立测量」）把**实际响应 workload 绑到受信 image digest**。★**但不保证该进程输出诚实**（被攻破进程仍可用合法身份 + 合规镜像签谎言）。
  - `PLATFORM_EXECUTION_VERIFIED`——由**独立 runner/verifier 重执行或独立观察**核心计算，**抗目标 app 主动造假**（β / 隔离 verifier 才达到；α 同进程代签达不到）。
  - `HARDWARE_EXECUTION_BOUND`——完整 TEE 协议（γ-SEV）把响应绑到测量环境 + 执行 commitment，**抗运营方**。
  - ★**Codex 第 3 轮 P1——这些能力不是天然全序**（β 独立重执行若没验自己 actual image 不天然 artifact-bound；TEE 抗 host 但受测应用自身仍可能有漏洞；`HARDWARE_EXECUTION_BOUND` 不自动在所有维度严格强于 `PLATFORM_EXECUTION_VERIFIED`）。故**要么把五档定义为严格累计 profile（每高档必须满足所有低档验收条件——`HARDWARE_EXECUTION_BOUND` 须同时满足 identity+artifact binding+execution verification），要么落地为 capability claims 集合**（`workloadIdentityVerified`/`artifactBound`/`independentExecutionVerified`/`hardwareOperatorExcluded`，policy 声明所需 claims，**不做 `assurance >= level` 的裸序号比较**）。实现时二选一，本文用五档命名 profile 仅作决策沟通。
- **`signingPolicy / profile`（哪个客户/监管口径接受哪档，产品决策）**。

★**Codex 复审 P1——`attestationAssurance` 必须由 verifier 依实际验真的证据 + **固定版本的 assurance schema** 派生，绝不作为报告/证据里的可信输入字段**（与自报 toolchain 同等对待，自报 `HARDWARE_EXECUTION_BOUND` 必须忽略）。派生规则示例：验成功 SVID→`PLATFORM_IDENTITY`；验成功 imageID + 受信 digest 映射→`PLATFORM_ARTIFACT_BOUND`；独立执行证明→`PLATFORM_EXECUTION_VERIFIED`；验成功 TEE 协议→`HARDWARE_EXECUTION_BOUND`。

★★**Codex 第 3 轮复审 P0（我本轮引入的矛盾）——assurance 派生绝不能依赖当前 signing policy**，否则「policy 参与派生 assurance → assurance 再与 policy 比较定 SIGNABLE」形成循环 + 破坏两轴正交。**正确单向链**：`已验证证据 → verifier 按固定版本 schema 派生 assurance/capability（与 policy 无关）→ effective signing policy 消费该结果 → 派生 SIGNABLE`。assurance schema 的 ID/版本也进 report commitment，避免将来重定义档位改变历史报告含义。

`SIGNABLE` 的语义改为：「**在明确记录的 signing policy 下，报告的（verifier 派生的）attestationAssurance 达到该 policy 要求的档**」。这样：
- 普通回归门禁（威胁模型只防部署漂移 + 非特权进程错误）→ policy 可接受 `PLATFORM_ARTIFACT_BOUND`（α-独立取证 imageID/β 够）。★但**不能低到 `PLATFORM_IDENTITY` 就翻 SIGNABLE**——那没证明跑的是哪个 artifact，层3 未达成。
- 要抗 aster-api 进程造假 → policy 要求 `PLATFORM_EXECUTION_VERIFIED`（β/隔离 verifier）。
- 银行政策明确要求「防运营方伪造」→ policy 要求 `HARDWARE_EXECUTION_BOUND`，α/β **不得**在该 policy 下翻 SIGNABLE，只能等 γ-SEV。

★这与 Item 4 F/S1 一脉相承——**不假装**：宁可诚实标 `attestationAssurance` 档 + 记录 signing policy，也不把软件根 SVID 说成硬件级。**每档接受哪个 policy 是产品/合规决策，你拍板。**

★铁律（承 S1）：m1.6 的 provenance 证据必须是**独立可验签的签名**（读路径重新验签，mirror S1 的 isStoredManifestVerified），**不是**报告自报的 toolchain 字段（Codex 复审致命 1：自报字段当开关=自证漏洞）。且必须绑 **baseline 与 current 两侧**都 attested（跨升级需两端 provenance）。

---

## 5. 推荐（诚实、分阶段）

**S2-0（先做，零签字解锁，补层2 runtime 强制）**：k3s 加 **cosign policy-controller / Kyverno admission**——运行时强制「只跑 image-lock 里 cosign-verified 的 digest」。这补上层2 现有的 runtime 缺口（现只 PR 时验签），是**任何**层3 的地基（层3 要绑「跑的 image」，得先保证跑的 image 可信）。独立价值、不解锁签字、GitOps 可部署。

**S2-1（层3 软件根 MVP）**：SPIRE（platform ApplicationSet）+ **独立取证的** response 签名（签名组件从**可信控制面/CRI** 取实际 imageID——平台观察，非硬件 measurement、用**受信 digest→toolchain manifest 映射**派生 toolchain 忽略自报串、**独立构造 canonical envelope**——非签 app 传的 body）+ cloud 验签（mirror S1 trust-bundle + isStoredManifestVerified 读路径重新验签）+ m1.6 gate。**档位取决于做到哪步**（★Codex 第 3 轮 P1 修档位矛盾——是否独立执行决定能否到 `PLATFORM_EXECUTION_VERIFIED`，**不是**决定能否到 `PLATFORM_ARTIFACT_BOUND`）：未独立取证并验 actual imageID → 只 `PLATFORM_IDENTITY`（未证跑哪个 artifact，层3 未达成）；已完成平台观察的 image binding 但未独立执行 → `PLATFORM_ARTIFACT_BOUND`。
- ★若要抗 aster-api 进程攻破 → 签名组件须独立执行核心计算 → **推向 β（隔离 verifier），达 `PLATFORM_EXECUTION_VERIFIED`**。α「同进程 sidecar 代签」最多到 `PLATFORM_ARTIFACT_BOUND`（且需独立取 imageID），不达 execution-verified。
- 依赖 S2-0（admission 强制 image digest）。**是否解锁 SIGNABLE 取决于该档满足哪个 signing policy（§4）。**

**S2-2（硬件根，长期，方案 γ-SEV）**：银行级客户要「防运营方伪造」时——加 x86 SEV-SNP confidential shape + **完整 TEE 证明协议**（measured verifier + key-release + challenge 绑定 + verifier 隔离出 guest 管理员），达 `HARDWARE_EXECUTION_BOUND`。**需硬件投资 + 你定客户要求**。★普通 TPM 节点**不**在此档（只到启动完整性，不抗运营方，见 §2 γ-TPM）。

---

## 6. 必须你拍板的决策点

★Codex 复审 P2：只让你拍**三件真正的产品/合规选择**，其余（两轴建模、S2-0 admission）是**架构必要项**，不包装成「可选拍板」——否则你选「不做」时整条证明链无定义。

**你拍这三件（三者共同决定「首个付费试点用哪个 signing policy profile、能否出绿 PASS」）：**
1. **首个付费试点是否要求抵抗「aster-api 进程被攻破自签谎言」？** 若**是** → 必须 β/隔离 verifier（独立重执行，达 `PLATFORM_EXECUTION_VERIFIED`）；若**否**（只防部署漂移 + 非特权错误）→ α-独立取证 imageID 够（达 `PLATFORM_ARTIFACT_BOUND`，成本更低）。
2. **是否要求抵抗「集群/guest 运营方作恶」？** 若**是** → 必须 γ-SEV（换 x86 confidential shape + 完整 TEE 协议，达 `HARDWARE_EXECUTION_BOUND`，当前 Ampere 出不了绿 PASS）；若**否** → α/β 软件根即可。★普通 TPM **不**满足此项。
3. **对应 signing policy 明确接受哪档 evidence profile？**（§4 五档）——把 1、2 的答案落成一个**记录在案、服务端派生、防降级**的 policy。这是 S2 现在能否解锁签字的**总开关**：policy 要 `HARDWARE_EXECUTION_BOUND` → 现在硬件出不了绿；要 `PLATFORM_ARTIFACT_BOUND`/`PLATFORM_EXECUTION_VERIFIED` → S2-1/β 可解锁。

**架构必要项（非「可选」，实现时默认按此做，仅告知你）：**
- **两正交轴建模**（`attestationAssurance` × `signingPolicy`，§4）——`SIGNABLE` = 「记录的 policy 下 verifier 派生的 assurance 达标」。这是消歧的必要建模，不是可选。
- **S2-0 admission 强制 image digest**——它是 artifact-deployment policy（**不是** runtime binding 证明），补层2 runtime 地基、是任何层3 的前置地基，默认先做。
- **OCI Instance Identity**——可选增强节点身份（Oracle CA 证节点是某 OCI instance），但**不**给 workload measurement，价值有限；除非独立评估认为值得，否则不纳入首版。

---

## 7. m1.6 铁律（实现时必须满足——Codex 复审补全）

承 S1 的 4 项 + Codex 复审新增，m1.6 provenance 证据必须：
1. **独立可验签**（不是报告自报的 toolchain 字段——Codex 复审致命 1：自报字段当开关=自证漏洞）。
2. **读路径每次重新验签**（mirror S1 isStoredManifestVerified：「行存在≠已验证」）。
3. **绑 baseline + current 两端**（跨升级需两侧都 attested）。
4. **缺失/失败 fail-closed** 保留 `TOOLCHAIN_PROVENANCE_UNVERIFIED`。
5. **历史证据可长期验证**：SVID 是短期证书——必须归档证书链 + 签发时 trust bundle/policy + 验证时间语义（否则数月后不能可靠复验；不能用「当前 trust bundle」重验过去证据）。
6. **canonicalization + domain separation**：签名对象固定版本 + 类型标签 + 字段长度/顺序 + 严格单射编码，**不签任意 JSON body**。
7. **challenge/freshness**：绑 verifier 生成的高熵 nonce（单次消费）+ request ID + iat/exp + audience。
8. **完整 execution binding**：绑 input hash + output hash + policy/golden identity + case ID + **实际 image digest**（从可信控制面取，非自报）+ toolchain manifest digest + workload identity。
9. **信任策略版本**：记录验证时允许的 SPIFFE ID + issuer + image/signing identity + 算法 + policy version。
10. **撤销与轮换语义**：证书过期/issuer 轮换时历史签名如何判定（明确规则）。
11. **防证据替换/混搭**：baseline + current + transition manifest(S1) + report 形成**不可拆换的 commitment**，不能分别验签后任意拼接。
12. **旧 baseline 不可追溯补证**：S2 上线前生成、无当时 provenance 的 baseline **不能事后贴 SVID** 变可信——须重新 capture/freeze，否则续 UNSIGNABLE。
13. **多副本/路由绑定**：证**实际响应副本**，非仅「Deployment 里存在一个合规副本」。
14. **错误分级但统一 fail-closed**：缺证据/证书无效/nonce 重放/未知 issuer/image mismatch/过期 可有不同诊断码，但**都不移除** `TOOLCHAIN_PROVENANCE_UNVERIFIED`。
15. **防 signing policy 降级选择攻击**（Codex 复审 P0）：`SIGNABLE = assurance × policy` 时，**攻击者不得自选低要求 policy**。policy 由**受授权的客户/合同/tenant 配置**决定，**请求方 / 报告 payload 不得指定**；policy ID + 版本 + 参数进入 **report commitment**；policy 变更受授权、审计、防回滚；verifier 用**服务端解析出的 effective policy**，不接受报告自报 policy。否则可把银行报告指定成普通 policy 用低 assurance 翻 SIGNABLE。
16. **`attestationAssurance`/capability 仅由 verifier 依「实际验真的证据 + 固定版本 assurance schema」派生，不依赖当前 signing policy**（Codex 第 2/3 轮 P0/P1）：不能作为证据/报告可信输入字段；自报 `HARDWARE_EXECUTION_BOUND` 与自报 toolchain 同等**必须忽略**；单向链「证据→assurance→policy 消费→SIGNABLE」不得成环；assurance schema ID/版本进 report commitment。
17. **签名密钥能力隔离**（Codex 复审 P1）：明确谁能调用签名操作、signer 是否接受任意 payload（应**否**）、key 是否可导出（应**否**）、是否限制消息类型/audience/协议版本、**被攻破 workload 能否把 signer 当通用 oracle**（应堵死）。签名组件只对**自己独立构造的 canonical envelope** 签名，不对调用方提交的任意字节签名。
18. **可信时间 / 历史证明语义**（Codex 复审 P1）：SVID `iat` 或应用时间**不是**独立可信时间；归档旧 trust bundle 本身**不证明签名发生于密钥失陷之前**。长期复验须选定一种语义：verifier challenge 的在线时间 / 可信时间戳服务 / transparency log inclusion timestamp / 或明确「只证明在 verifier 接受 challenge 的窗口内有效」。★**「verifier 在线时间」仅当**：verifier 本身受信 + 对 challenge/接收时间/证据摘要/验证结果签发**不可替换的 receipt** + receipt 归档（必要时锚定透明日志/可信时间戳）——否则数月后只剩一个 nonce，不能证明它在何时被接受。选较弱语义时同样须存可验证的 verifier acceptance receipt。

## 8. 本 spike 不做什么

- ❌ 不写 SPIRE/签名/m1.6 任何实现（等决策拍板）。
- ❌ 不 bump m1.6（无实现不冻版本）。
- ❌ 不假装软件根 SVID = 硬件级、不假装 SPIRE 默认防进程攻破、不假装「换硬件即不可伪造」（诚实分级）。
- ❌ 不在 admission 强制（层2 runtime）落地前把 α/β 当「真层3」（S2-0 是 artifact-deployment policy，**不是** runtime binding 证明）。

---

## 附：引用路径说明
本文档引用的 `k3s/apps/...`、`aster-api/src/...` 路径为**跨仓库**（k3s = wontlost-ltd/k3s；aster-api = aster-cloud/aster-api），相对本仓（aster-cloud）需 `../k3s/`、`../aster-api/`。证据由 Explore agent 在各仓实证 + 主 AI 直接核对（deriveUnsignableReasons:1512-1517 gate + ToolchainIdentityProvider 自报串 + 节点 Ampere ARM）。
