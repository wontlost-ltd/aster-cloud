# Slice-2b 设计岔口分析（brainstorm 决策包）

> 输入：`p0a-s2-1a-2-slice2b-factbase.md`（地面事实）+ `runner-engineering-spike.md` §2/§3/§3b/§6（设计意图）。
> 目的：把 Slice-2b 的开放决策收敛成一轮用户拍板。doc 已定的默认**采纳不问**；genuinely-open 的**列给用户**。

## 已由设计文档拍板的默认（采纳，不再问用户）
- **runner Job namespace = 新建 runner ns**（`runner-engineering-spike.md:156`）：隔离 launcher/runner RBAC 与 aster-cloud BFF ns；须贴 `policy.sigstore.dev/include=true` 标签 + 加 ArgoCD destinations。文档称「plan 阶段工程细节，非架构拍板项」。
- **全局并发 default = 1**，容量验收（§2 契约）通过后才升 2（`:52-58`）。
- **resources 信封实测驱动**（峰值 RSS + p95 冷启动 + 代表性 corpus），非固定数（§2）。128Mi/512Mi 确认对 GraalVM 太小。
- **launch substrate = 形态 α**（in-cluster Go launcher，SA+BatchV1 RBAC，cloud 经 CF Tunnel HMAC 调）（`:153`）。
- **launcher 是新 TCB 成员**（§3b）：只编排不产证据、镜像 cosign-verified admission、审计。MVP 无签名=不抗 launcher 攻破（诚实边界）。
- **allowed-images.yaml 3rd entry = 人工 commit**（push-ruleset 保护，非 auto-PR）。

---

## FORK C（承重）：launcher 如何把 RunnerRequest JSON 送进 runner 容器 stdin
硬约束：batch/v1 Job 无原生 stdin；`RunnerMain` 硬从 `System.in` 读（`RunnerMain.java:26,41`），忽略 env/args；runner 镜像 entrypoint `/app/bin/runner`，非 root，readOnlyRootFilesystem 意图。

### 方案
| 机制 | request 字节如何到 System.in | RBAC/镜像改动 | 失败模式 |
|---|---|---|---|
| **(a) Job pod + pods/attach** | Job pod `stdin:true,stdinOnce:true,tty:false`；launcher 待 pod Running 后开 pods/attach（SPDY/WS）写 stdin | `pods/attach: create`（**remote-exec 级**广权限）；无镜像改动 | ★attach race：attach 须在容器 readValue 前接上，否则 EOF→parse 错；断连无 replay=半 JSON 损坏，无幂等重试；stdout/stderr 合流；30s SLA 下脆弱 |
| **★(b) initContainer 写 emptyDir 文件 + Job-spec command 覆写 `exec /app/bin/runner < /work/request.json`** | request 经 initContainer 落 emptyDir(/work)，主容器 shell 重定向文件进 stdin | `batch/jobs:create,get,watch,delete`+`configmaps:create,delete`+`pods,pods/log:get,list,watch`；**runner 镜像不改**（重定向是 Job-spec command 覆写非镜像 wrapper） | ConfigMap ≤1MiB（etcd）；per-invocation ConfigMap 须 owner-ref 到 Job 级联 GC 防泄漏；须 /bin/sh（alpine 有 ash ✓）；emptyDir 在 RO-rootfs 下仍可写（同 migrate-job /tmp tmpfs ✓） |
| **(c) env 传 request + 改 RunnerMain stdin 空则读 env** | request 作 pod env var；RunnerMain 新增分支读 env | 最小 RBAC；**改 aster-api RunnerMain**，污染 stdin 契约 | env ~1MiB 上限；★arm64 Task-0 parity 门喂 **stdin**，env 是第二未测输入路径→parity 门测 stdin/生产走 env=分叉风险（正是 MVP 要抓的）；违反「runner 读 stdin 不读 env/args」不变量 |

### 推荐 = (b)
理由：唯一**不改 runner 镜像、不动 stdin 契约、全异步可重试**的机制。stdin 重定向是 Job-spec `command:` 覆写（合法 k8s，镜像字节不变）；JSON 仍到 `System.in`=parity 门 stdin 路径与生产**同一代码路径**，不引入 (c) 的未测第二路径分叉（正合 MVP 目的：抓打包/镜像/launcher/Job-env 分叉而**不自引入**）。与 readOnlyRootFilesystem 兼容（emptyDir /work 同 migrate-job tmpfs）。整个 Job 是重试单元（backoffLimit/restartPolicy:Never），无 attach 的 live-stream race。
不选 (a)：`pods/attach:create` 是 remote-shell 级权限，扩大 launcher 爆炸半径（§3b 要**最小化**新 TCB 成员权限）；attach 合流+race+无重试。
不选 (c)：唯一改 aster-api 且 fork 输入契约——对「证无分叉」的里程碑是净损。

### 信封 vs 诊断分离（子问题）
RunnerMain 写 envelope 到 **stdout 最后一行**、诊断到 **stderr**（`:45,48,50`），但 kubelet 的 pods/log 合流。**勿 `2>/dev/null`**（毁掉排查 OOM/冷启动/locale-SPI 的诊断=正是 parity 门要找的分叉）。
读协议：launcher 读全 Pod log，取**最后一行能解析为合法 RunnerEnvelope JSON**（有 `outcome`∈{SUCCESS,ERROR}）。RunnerMain 保证 envelope 单行且是最后 stdout 行→「最后合法 envelope JSON 行」确定性 + 保留全诊断。配 **exit code 作 SUCCESS/ERROR/序列化失败权威**（`:53`，0/1/3，从 pod status 读）→ 日志截断/不可解析 fail-closed 到 unavailable。

### ★用户须决（Fork C 残留）
1. **request 送进 initContainer：per-invocation ConfigMap vs initContainer env var vs projected volume。** ConfigMap 最干净（owner-ref GC）但每次 replay 加一 etcd 对象 + `configmaps:create,delete` RBAC；env 免额外对象但硬上限（~1MiB ARG_MAX）不可 owner-ref-GC。**取决于 source+input 现实最大尺寸（factbase 未定）——先定尺寸预算再选载体。**
2. **无 attach 的同步流下 30s 超时**（`runner-launcher-client.ts:56`）现覆盖 Job 调度+GraalVM 冷启+执行+读日志。节点已 54-76% 满、并发=1 时 30s 够吗？还是 launcher 快返 unavailable 让 cloud 视 runner 为 best-effort？（倾向：spike 已默认并发=1 且警冷启动重——用户确认 SLA 信封。）

---

## FORK A：image-lock 拓扑（runner digest pin 放哪）
crux：image-lock pin 的是 **ArgoCD 部署的** workload，但 runner 镜像由 **launcher 运行时**部署，非 ArgoCD kustomize build。runner Job 不在任何 kustomization `resources:`→`cloud/` 的 runner images-transformer 条目**惰性**（什么都不改写，只满足脚本 kcount==1）。

### 方案
| 拓扑 | pinned digest 如何到 launched Job | 代价 | 失败模式 |
|---|---|---|---|
| **(a) 种 3rd 条进 cloud/{image-lock,kustomization}** | **不自动到**——transformer 只改写 resources: 引用的镜像，runner Job 不是；launcher 须另处读 digest | 最低：匹配已上线 workflow（无 LOCK_PATH override→default cloud/），今天解阻 Slice-2a | **语义错+惰性 transformer**：cloud/ 的 runner 条目什么都不改写，只过 kcount==1；后人见 cloud/ pin 会误以为 ArgoCD 部署它——并没有。铁律不由此文件强制=装饰性 pin |
| **(b) 新建 apps/aster-lang/\<runner-ns\>/{image-lock,kustomization}** + workflow image-pin 步加 LOCK_PATH/KUSTOMIZATION_PATH override | 仍不自动到 Job，但 pin 落 runner 自己 ns 目录，与消费它的 launcher 语义同位 | 中：新目录（无先例）+ workflow env override（脚本支持但硬 default cloud/）+ ArgoCD AppProject destinations 加新 ns | 同惰性 transformer 除非 launcher Deployment（在该 kustomization resources 里）引用 runner digest——但它不引用（launcher 把 runner 当**子 Job** 跑），transformer 仍改写不了 runner 镜像 |
| **★(c) runner digest 落 launcher 自己 config（values/env，image-pin PR bump 它）；image-lock/kustomization 只 pin launcher 镜像** | launcher 从挂载 config 读 runner digest，Job 创建时构 `...aster-replay-runner@sha256:<pinned>` | 中：image-pin 脚本对 runner 的双写目标变 launcher-config 文件（或 launcher Deployment env 的小 patch），非惰性 transformer | **唯一让 pin 真绑 launcher 所跑的拓扑。** 失败模式：两 runner digest 源（image-lock provenance 条 + launcher-config 运行时值）须锁步——需脚本已有的双文件一致校验；漂移则 launcher 跑陈旧 runner 而 image-lock 声称否 |

### 推荐 = (c) 作语义家 + (b) 目录 + (a) 仅临时解阻
铁律=tested==signed==pinned==**what-launcher-runs**。launcher 运行时构 image ref→**launcher 读的 digest 是唯一绑现实的 pin**。image-lock pin ArgoCD 部署物，runner 不是。故：
- **runner digest 真家 = launcher 运行时 config**（c）：launcher 读它构 Job `image:`。唯一让「pinned」与「what-launcher-runs」是**同一事实**而非两事实寄望一致。
- **image-lock 仍加 3rd runner 条**——但干它的**本职**：cosign-verify + 新鲜度 + provenance（+ allowed-images.yaml 3rd 条，人工 commit）。不假装部署 runner。
- **两者落新 runner-ns 目录**（b），非 cloud/——因 cloud/ transformer 对 runner 惰性且误signal 归属。
- image-pin workflow runner 步加 LOCK_PATH/KUSTOMIZATION_PATH override 指新目录；对 runner 镜像的「kustomization」写变 launcher-config digest patch（或脚本加第三写目标）。
(a) 进 cloud/ 仅作 Slice-2a 同日解阻（factbase A2：已上线 workflow 因 cloud/ 无 runner 条 exit 1），须显式标为占位装饰 pin + (c) 作跟踪 follow-up，否则坐实 factbase 已 flag 的语义谎言。

### ★用户须决（Fork A 残留 — 最深岔口）
1. **runner digest 落 launcher ConfigMap/values，还是 build 时烘进 launcher 自己镜像（「launcher 知其 runner」常量）？** 前者=image-pin PR 独立 bump runner；后者=launcher+runner 单一锁步发布（launcher 镜像**即** pin）——对铁律更干净（一件一签）但每次 runner bump 须 launcher 重部署。**真岔口：解耦 runner/launcher 发布节奏，还是熔合。**
2. **同日务实 vs 正确**：现在种 cloud/ 解阻 Slice-2a（接受文档化惰性 pin），还是先做正确 (b)/(c) 拓扑、让 Slice-2a runner image-pin 保持 fail-closed 到 launcher-config 目标存在？
3. **image-pin 脚本是否需第三写目标**（launcher-config digest）超出现双写，还是 launcher-config 是普通 kustomization patch 现有 KUSTOMIZATION_PATH override 够得着？（决定 (c) 是否须改已上线 open-image-pin-pr.sh 还是仅 env override。）

---

## 跨 fork 注
Fork C 推荐 (b) 使 runner Job 成 launcher 建的子 Job（command 覆写）→runner Job 的 image ref 由 launcher 运行时设（Fork A 的 c），runner Job 从不进任何 kustomization resources。两推荐互相加强：runner 是运行时启的 Job，故其输入（stdin via 文件）与身份（pinned digest）都是 launcher 职责非 ArgoCD/kustomize 职责。任何想让 runner Job 成 kustomize 管理资源（使 image-lock transformer 变真）的方案都会与用户已拍板的 launcher-launches-Job 架构（`:153`）打架。

---

## FORK E（slice 范围/顺序 — 纯用户决策）
- **2b-一体**：Go launcher + k3s 种子 + 真编排一个大 PR-set。
- **2b-seed 先行**（推荐拆）：先只解阻 image-pin（种 3 个 k3s 信任根条目 + admission 标签，**无 launcher**），让已上线 Slice-2a 端到端绿；再 **2b-launch**（大 Go launcher 新 TCB 子系统，独立安全审查）。
  - 好处：2b-seed 小/机械/低风险，立刻兑现 Slice-2a 的 build✅sign✅parity✅ 到 image-pin✅；2b-launch 大工程可从容走独立安全审查。
  - ★但注意：若选 Fork A 的 (c)（digest 落 launcher-config），则 image-pin 目标依赖 launcher 存在→2b-seed 与 2b-launch 无法完全解耦（种子进 cloud/ 的 (a) 才能纯解耦）。**Fork A×Fork E 耦合**：选 (a) 解阻→可拆；选 (c) 正确→半耦合。

## FORK F（安全审查时机 — 流程决策）
launcher 是新 TCB 成员（§3b），CLAUDE.md 流程要独立交叉审查。选项：
- launcher PR 走**强化版 Codex 深审**（如 runner-integrity M1 的 CCO 深审 36→72 模式），聚焦 §3b 绑定清单（imageID 可信观察、challenge 原子消费、SA 最小权限、无证据自产）。
- 或额外邀第二会话独立复核（如 S1 计划所述 Codex 超时降级）。
