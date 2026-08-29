# 计划：runner-topology go-live lane + verify-image-pin :121 载体 diff 修复

**日期**: 2026-07-24
**决策**: 用户拍板「Build the runner-topology lane (drop pause)」（Codex 红队修正 Option A）
**范围**: k3s verifier（新 topology lane）+ verify-image-pin.sh 既有 bug 修 + launcher deployment 上线拓扑

---

## 背景（为什么）

full B 后 launcher go-live PR（加回 deployment 到 resources + replicas 0→1 + 删 deploy-policy deferral）
**无法合入**：任何碰 `deployment.yaml`(RUNNER_DEPLOY_PATH) 或 `kustomization.yaml`(RUNNER_KUST_PATH) 的 PR
被 detection 判 `pin_flavor=runner` → strict → check-pr-shape 要求 **Bot 作者 + image-pin/* 分支 +
改 image-lock**（check-pr-shape.sh:47/59/82）。人工 go-live PR 必被拒。且 kustomization/deployment
semantic-diff 只许改 digest/env-value，禁改 replicas/resources。

**Codex 红队关键修正（放弃 pause）**：
1. **pause 多余**：kustomization 已有真实签名 launcher digest（ad84d70b）。deployment 用 canonical
   name → transformer 把全零占位重写成真签 digest → **合法通过 admission（真签名，非 no-match 逃逸）**。
2. **pause 有害**：把 `no-match-policy: allow` fail-open 制度化为部署模式，审计误述"signed"实为
   "unverified no-match"，给后人"换 repo 绕签名"先例。
3. **真解 = runner-topology lane**：新增受审 PR 类型，断言 pin 数据不变 + 原子校验 go-live 迁移。

---

## 交付物

### PR-1（k3s verifier）— runner-topology lane + :121 bug 修

**A. verify-image-pin.sh :121 载体 semantic-diff bug 修**（安全，独立可先做）
- 现状：image-lock entry 未变（digest/sourceSha 同 base）→ line 134 `continue`，**跳过** env-binding
  deployment semantic-diff（line 203-221，在循环内、continue 之后）。Bot PR 若 image-lock 不变但改
  deployment（replicas/securityContext）→ 载体 diff 从不跑。
- 修：载体一致性 + 载体 semantic-diff 必须**独立于"digest 是否变化"执行**。把 continue（line 134）
  改为只跳过 cosign/freshness（重验签只在 digest 变时需要），但**始终**跑载体 semantic-diff。
- ★kustomization semantic-diff（line 79-96）在循环外，本就每次跑，不受影响；只 env 路径有洞。

**B. 新 runner-topology lane（detection 语义分流）**
- detection 现状：碰 deployment/kustomization → 一律 pin_flavor=runner。
- 改为按**语义**分流（读 base+head 数据判断改了什么）：
  1. image-lock / kustomization.images digest / RUNNER_IMAGE_DIGEST env 变化 → 现有 image-pin strict lane（不变）。
  2. deployment（image name/replicas）/ kustomization resources / deploy-policy 变化，**且 pin 数据全不变**
     → **runner-topology lane**（普通受审人工 PR，非 Bot/非 image-pin 分支）。
- topology lane 校验器（从可信 base 读脚本，head 读数据）强制：
  - image-lock 完全不变（byte/semantic）。
  - kustomization.images name+digest 完全不变。
  - RUNNER_IMAGE_DIGEST env value 完全不变。
  - 只允许显式 go-live 状态迁移白名单：replicas 0→1；resources 加 deployment.yaml+external-secrets.yaml；
    删 deploy-policy launcher deferred；deployment 其余字段归一化后与 base 全等（除 image name 占位→canonical）。
  - **head 渲染断言**：`kubectl kustomize` 输出里 launcher 恰出现 1 次 + 镜像 == `docker.io/wontlost/aster-runner-launcher@<当前 pinned digest>` + 不出现 pause + head deploy-policy 已无 launcher deferred。
  - **ExternalSecret/Vault 前置**：deployment 引用 aster-runner-launcher-hmac；仅切 replicas 不构成完整 go-live，须校验 external-secrets 在 resources + Vault path 存在（或明确标记为 ops 带外前置）。
- **不扩大普通 image-pin PR 文件白名单**（Codex 铁律：Bot 不得获得改 replicas/拓扑/豁免策略的能力）。

**C. 测试**
- :121 修：Bot PR image-lock 不变 + 改 deployment → 载体 diff 仍跑 → 拒（反例）。
- topology lane：合法 go-live PR（replicas 0→1 + resources 加 + 删 deferral，pin 不变）→ 通过。
- topology lane 反例：go-live PR 偷改 kustomization.images digest → 拒（pin 数据变，越 lane）。
- topology lane 反例：go-live PR 偷改 RUNNER_IMAGE_DIGEST → 拒。
- topology lane 反例：head 渲染出 pause 或 launcher digest≠pinned → 拒。
- topology lane 反例：删 deferral 但 launcher 未真渲染 → 拒（当次 head 校验，非 base）。

### PR-2（k3s manifests）— launcher deployment 上线拓扑（走 topology lane）
- deployment.yaml 加回 kustomization resources（+ external-secrets.yaml，需 Vault 前置就绪）。
- deployment.yaml image 全零占位 → canonical name（让 transformer 重写成 pinned 真 digest）。
- replicas 0→1。
- deploy-policy.yaml 删 launcher deferredImages 条。
- ★依赖 ops 前置：Vault secret/apps/aster-runner-launcher 就绪 + Cloudflare tunnel 路由 + admission smoke-test。
- 本 PR 走**新 topology lane**验证（PR-1 合后才能过）。

---

## 交付顺序（铁律）
PR-1（verifier lane）**必须先合** → 否则 PR-2 topology PR 无 lane 可走、被旧 detection 判 strict 拒。

## 破坏性 / 迁移
- :121 修：纯收紧（更多校验），不破坏合法 image-pin PR（它们本就该过载体 diff）。
- topology lane：纯增量新路径，现有 image-pin/cloud lane 零改动。
- deploy-policy.yaml deferredImages 语义修正（Codex 注：现描述"移出 resources"，Option 下应为"受控 image mapping 暂无消费者"——但既然放弃 pause 走真 digest，launcher 上线后不再 deferred，此语义争议消解）。

## 交叉审查（禁止自审）
Claude 生成 → Codex 审。每 sub-task 独立 Codex 复审。重点：
- topology lane 能否被滥用绕过 pin 强制（改拓扑同时偷改 pin）？
- :121 修是否引入合法 image-pin PR 回归？
- head 渲染断言是否真原子（当次证 launcher by-digest，不留"下次强制"缝）？
- detection 语义分流的边界（既改 pin 又改拓扑的混合 PR 落哪个 lane？必须 fail-closed）。

## ★★Codex 红队硬化设计（2026-07-24，PR-1B 校验器铁律）

实证 Critical bypass（我本地 kubectl kustomize 复现）：kustomization images transformer 按 `.name` 覆写
digest；攻击者若把 deployment container image 行改成**别的 name**（`ghcr.io/evil/backdoor@sha256:...`）
→ transformer 不匹配 → **渲染出攻击者镜像**。或保留 launcher 诱饵容器 + 加第二 evil 容器 → 单纯
「launcher 出现」断言被绕。故 render 断言必须**闭世界对象级**，非字符串 grep。

**PR-1B 校验器铁律（全满足才 pass）**：
1. **detection = 完备互斥枚举** `none|cloud-pin|runner-pin|runner-topology|invalid`：
   - image-lock touched → runner-pin（**绝不** topology）。
   - runner 受控文件 rename/delete、读取/解析失败、字段缺失、重复匹配 → invalid（fail-closed）。
   - pin 数据严格不变 + changed-path shape 满足 topology 候选 → runner-topology。
   - pin 数据变但 image-lock 未改 → invalid。cloud+runner 同命中 → invalid。
   - ★进入 runner-topology 后校验器**重新独立验全部不变量**，不信 detection 比较结果。
   - ★**恰好一 lane** 断言（成功 lane 数==1）；invalid/解析失败/未知枚举 → explicit failure（非 no-op）。
2. **topology shape 门**（比人工 PR 更窄，因是 strict pin 门的受控例外）：changed files **精确**为
   {kustomization.yaml, deployment.yaml, deploy-policy.yaml} 三者**全命中**、无其它 path、无 rename/delete。
   external-secrets.yaml 文件本身不改（只加入 resources）。
3. **pin 数据不变（结构化，非字符串）**：
   - image-lock.yaml base==head（整文件 semantic）。
   - kustomization.images **整数组**精确不变（name/newName/digest/顺序/数量/重复/额外字段全锁）。
   - deployment 的 `RUNNER_IMAGE_DIGEST` env：指定 Deployment 指定 container 恰 1 次、base==head、==base image-lock runner digest。
   - ★**deployment container image 行 base==head 精确相同**（不可变；go-live 不需改它，transformer 覆写 digest）。
4. **允许的 topology delta 白名单**（结构化精确）：
   - kustomization resources multiset delta 恰 = +deployment.yaml +external-secrets.yaml（各 1 次；拒重复/远程 URL/删除/替换）。
   - deployment replicas 恰 0→1（单独验，不归一化）。
   - deploy-policy 恰删 1 条 `image==docker.io/wontlost/aster-runner-launcher`（version/其它 entries/reason 不变；拒删全部/改名规避/加泛化豁免）。
   - deployment 其余字段（securityContext/其它 env/probe/SA/command/args/mounts/annotations…）base==head，含容器数/env 数 cardinality 检查。
5. **闭世界 render 断言**（kubectl kustomize head 树，对象级）：
   - 恰 1 个 apps/v1 Deployment（ns aster-runner，name runner-launcher）；恰 1 regular container（name runner-launcher，image **精确==** `launcher@<base pinned digest>`）；initContainers==0；ephemeralContainers==0。
   - **所有 PodSpec image 收集成 multiset，精确 == 预期集合**（不止「预期出现过」）。
   - head 渲染对象身份集 == base 对象身份集 + {Deployment/aster-runner/runner-launcher, ExternalSecret/aster-runner/aster-runner-launcher-hmac}（identity=apiVersion/kind/namespace/name）。
   - 禁额外 Deployment/Job/CronJob/DaemonSet/StatefulSet（除非 base 既有且渲染前后全等）。
   - ExternalSecret 渲染恰 1：name/ns 对、target.name==aster-runner-launcher-hmac、data[].secretKey==hmac-key、remoteRef 符合预期。
   - deployment 唯一 HMAC 引用精确：env name ASTER_RUNNER_LAUNCHER_HMAC_KEY + secret name aster-runner-launcher-hmac + key hmac-key。
6. **鲁棒性**：YAML 解析失败/重复文档/重复映射键/重复匹配/alias/类型变化一律拒（防比较器与 kustomize 解释分歧）。

**长期缺口（Codex 记，独立后续）**：`verify-rendered-by-digest.yml` 只覆盖 cloud 不覆盖 runner。go-live 后
须加**永久 runner render guard**覆盖所有 `apps/aster-lang/runner/**` 人工 PR（否则未来人工 PR 改 runner
deployment/image/resource graph 时 verify-image-pin 走 no-op，pin 安全只依赖 topology 一次性校验器历史结果）。

## 范围外
- Vault secret / Cloudflare tunnel provision（ops 带外，Vault 已确认 provisioned 2026-07-24）。
- S2-1b SPIRE + workload signing。
- no-match-policy: allow → deny 收紧（Codex 建议的长期加固，独立工作项）。
- 永久 runner render guard（Codex 记的长期缺口，go-live 后独立 PR）。
