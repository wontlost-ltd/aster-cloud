# image-pin binding-mode + 可信 verifier 泛化 设计

> 依据：`docs/p0a-image-pin-binding-mode-factbase.md`（Explore agent file:line 实证）。
> 用户拍板 3 决策：#102 补验非回滚 / verifier 硬编码 base 侧 selector / 一体设计拆 PR-A(verifier)→PR-B(script)。

## Goal（一句话）
让 runner 镜像 image-pin 按其真实 deploy-truth（RUNNER_IMAGE_DIGEST env，非 kustomization transformer）工作，并**闭合已证实的信任洞**：runner/launcher image-pin PR 当前被 k3s 可信 verifier 漏检（no-op success）→ merges UNVERIFIED。

## 背景：两类 deploy-truth（铁律映射）
- **静态部署镜像**（aster-api / aster-cloud-migrate / aster-runner-launcher）：是 k8s manifest 的容器 `image:` 字段。deploy-truth = kustomization `images:` transformer digest。
- **运行时启动镜像**（aster-replay-runner）：**非**任何静态 manifest 的容器镜像。launcher 运行时经 Deployment env `RUNNER_IMAGE_DIGEST` 构 `docker.io/wontlost/aster-replay-runner@${digest}` Job（Fork A，`job.go:75/86` 无变换）。deploy-truth = 该 env value。
- 铁律：`tested/signed/pinned digest → image-lock → {kustomization images | RUNNER_IMAGE_DIGEST env} → 部署 → CIP admission 重验签`。runner 的中间层是 env 非 kustomization。

## ★核心问题（factbase 实证）
1. **脚本破 runner**：`open-image-pin-pr.sh:113-115` 无条件要求 kcount==1（kustomization 有 .name 条）。runner 不在 kustomization → kcount=0 → exit 1。
2. **★信任洞（更严重，预存）**：`verify-image-pin.yml:60-71` touches_pin 检测**只 grep 硬编码 cloud 路径**（`cloud/image-lock.yaml`+`cloud/kustomization.yaml`）。runner PR 改 `runner/*` → 漏检 → no-op 分支 → App-minted check-run 发 **conclusion=success** → **merges UNVERIFIED**（无 cosign/freshness/shape/digest 一致性）。★**launcher #102 已走此路合入**——launcher digest pinned 但未经可信 verifier 验。

## 设计：两部分（一体设计，PR-A verifier 先 / PR-B script 后）

### Part 1（PR-B，aster-api）：`PIN_DEPLOY_BINDING` 模式枚举
`scripts/ci/open-image-pin-pr.sh` 加**封闭枚举** env `PIN_DEPLOY_BINDING`：
- **`kustomization`（default，保零改动铁律）**：现行为不变——image-lock + kustomization 双写 + 可选第三目标。aster-api/migrate/launcher 用此（不设即默认）。
- **`env`**：image-lock 写 + **ENV_PATCH_* 必需** + **跳 kcount gate（:113-115）+ 不写 kustomization（:44-46）**。runner 用此。
- **互斥 fail-closed**：`env` 模式若设了 kustomization 写相关（本设计 KUSTOMIZATION_PATH 在 env 模式仍读但不作写目标，仅 image-lock 用；须明确 env 模式不做 kcount+不 add kustomization）；`kustomization` 模式若设 ENV_PATCH_* → 现有 XOR guard（:63-70）已管 ENV_PATCH 成对，binding-mode 再加：kustomization 模式禁 ENV_PATCH（避免混用）。
- 改动行（factbase Flag 1）：`:113-115` kcount gate 包 `if [[ binding == kustomization ]]`；`:44-46` kustomization 写包同条件；`:127` diff-check + `:143` git add 在 env 模式不含 KUSTOMIZATION_PATH。近 `:30-31/:75-76` 加 `PIN_DEPLOY_BINDING="${PIN_DEPLOY_BINDING:-kustomization}"` + 校验值 ∈ {kustomization, env}（非法 exit 2）。
- runner workflow（`aster-replay-runner-deploy.yml:257-274`）加 `PIN_DEPLOY_BINDING: env`（保留现 ENV_PATCH_PATH/SELECTOR + LOCK_PATH，去掉对 KUSTOMIZATION_PATH 的依赖或标注 env 模式不用）。
- **回归**：`open-image-pin-pr-thirdtarget.bats` 保 Test1 字节零改动（kustomization 模式静态镜像不变）+ 加 env 模式测：kcount 不跑、kustomization 不写、image-lock+deployment env 都写、非法 binding 值 exit 2、kustomization 模式设 ENV_PATCH 拒。

### Part 2（PR-A，k3s）：可信 verifier 泛化 + env-binding 验证
**★PR-A 先合**：这样 PR-B 让 runner image-pin 真开 PR 时，verifier 已能真验（非 no-op）。

1. **detection 泛化**（`verify-image-pin.yml:60-71`）：touches_pin 检测除 cloud 路径外，加识 `apps/aster-lang/runner/image-lock.yaml`（+ runner deployment/kustomization）。runner PR 改 runner/* → touches_lock=true → 走 strict path。strict fetch（:87-96）+ verify call（:132-137）+ render（:142-161）须 runner-path aware（按改的 image-lock 目录派生对应 deployment/kustomization 路径）。
2. **env-binding 验证**（`verify-image-pin.sh`）：新增 binding-mode 感知。对 `env`-bound 镜像（runner）——
   - ★**verifier 硬编码 base 侧 selector + deployment 路径**（用户决策②，不信 PR/workflow 传值）：`DEPLOYMENT="apps/aster-lang/runner/deployment.yaml"`，`SELECTOR='.spec.template.spec.containers[0].env[] | select(.name == "RUNNER_IMAGE_DIGEST") | .value'`（从可信 base checkout 侧固定，防恶意 selector 绕验）。
   - 读该 env value，断言 `== ` 本次 cosign-验过的 image-lock runner digest（替代 :151-158 的 kustomization-digest 检查——runner 无 kustomization 条，改验 env value 一致）。
   - 保 cosign verify（:163-174）+ freshness（:178-191）对 runner/image-lock。
   - **deployment.yaml semantic-diff allowlist**（类比 kustomization :70-88）：归一化 `RUNNER_IMAGE_DIGEST` env value 为 `__NORM__`，要求 deployment 其余 JSON 与 base 字节相等——image-pin PR 只许改这一个 env value，Deployment 其它一律不许动（防夹带）。
   - verifier 如何知一镜像是 kustomization 还是 env 绑定：按 allowed-images 加字段（如 `deployBinding: kustomization|env`）或按目录/镜像名映射。★spec 决：**allowed-images.yaml 加 `deployBinding` 字段**（单源可信声明，verifier 据此选验证路径；runner=env，其余=kustomization）。
3. **shape-check 泛化**（`check-pr-shape.sh:57-70`）：env 模式 runner PR 的 whitelist = `runner/image-lock.yaml` + `runner/deployment.yaml`（非 cloud lock+kustomization）。workflow 传对应 env（`IMAGE_LOCK_PATH`/新增 `DEPLOYMENT_PATH`）。
4. **不动**：`verify-cip-sync.sh`（CIP↔allowed-images，runner 已覆盖）、`verify-rendered-by-digest.yml`（cloud 静态 render guard，结构上无法覆盖运行时镜像）。

### #102 补验（用户决策①）
full B 全上线后，重触发 `aster-runner-launcher-deploy.yml`（同 digest sha256:36aa07f1 或新 build）——这次 verifier detection 已认 runner/ 路径 → launcher image-pin PR 走 strict path 真 cosign+freshness 验。#102 的未验证状态被下一次真验证覆盖（不回滚 #102，只补验）。★注意：launcher 是 kustomization 绑定（它在 runner/kustomization 有条），故其验证走 kustomization-digest 路径（已有），只是 detection 之前漏了它。

## allowed-images.yaml `deployBinding` 字段（新单源声明）
每 image entry 加 `deployBinding: kustomization|env`（默认 kustomization）。runner entry 标 `env`。verifier 据此对每个 image-lock 变更 entry 选验证路径。★这是可信 base 侧单源，非 PR head——防篡改。verify-cip-sync 不受影响（它只读 image/sourceRepo/workflowFile/sourceRef，忽略 deployBinding）。

## 迁移/破坏性
- `PIN_DEPLOY_BINDING` default kustomization → aster-api/migrate/launcher 零改动（Test1 守）。
- verifier 泛化：对 cloud PR 行为不变（cloud 路径仍识别+验），只**新增**识别 runner 路径。
- allowed-images 加字段：纯增量（verify-cip-sync 忽略）。
- 交付顺序铁律：**PR-A（verifier）先合 → PR-B（script）后**——反序会有窗口期（脚本能开 runner PR 但 verifier 仍 no-op → 未验证合入）。

## 验证（本地实测，无 CI 外包）
- **Part 1**：`bash open-image-pin-pr-thirdtarget.bats` 全绿（Test1 零改动 + env 模式新测）。
- **Part 2**：构造 runner image-pin PR fixture（改 runner/image-lock + runner/deployment env），本地跑 `verify-image-pin.sh`（env 模式）：断言 env value==image-lock digest 过；篡改 deployment 其它字段→semantic-diff 拒；恶意 selector 无效（verifier 用硬编码 selector）；cloud PR 仍走 kustomization 路径不变。`check-pr-shape.sh` 对 runner deployment 放行、对夹带文件拒。
- **端到端（合入后）**：PR-A 合 → PR-B 合 → 重触 runner-deploy → runner image-pin PR 走 strict path 真验证转绿 → RUNNER_IMAGE_DIGEST 写真 digest → 解阻 launcher go-live。

## 交叉审查（禁止自审）
Claude 生成 → Codex 深审。重点：(1) binding-mode 互斥是否 fail-closed 无绕过；(2) env 模式零改动铁律（静态镜像路径字节不变）；(3) verifier selector 硬编码 base 侧防篡改；(4) deployment semantic-diff allowlist 只许 env value 变防夹带；(5) detection 泛化不漏 runner 也不误判 cloud；(6) PR-A/PR-B 顺序保证无未验证窗口。

## 范围外
- 不改 CIP/admission（那验运行时签名，本设计验 pre-merge digest 一致+freshness）。
- 不改 verify-cip-sync / verify-rendered-by-digest。
- launcher go-live 的后续门（Vault 已备 / 加回 deployment+external-secrets / replicas 0→1 / tunnel / smoke-test）——本 spec 只解 runner digest 门。
