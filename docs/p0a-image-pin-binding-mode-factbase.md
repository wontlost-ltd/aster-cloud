# image-pin binding-mode + verifier 泛化 地面事实库（full B spike 输入）

> 由 Explore agent 只读实证（22 工具调用），每条 file:line。full B = image-pin 脚本加 binding-mode 枚举 + 扩 k3s 可信 verifier 覆盖 runner env-binding 路径。

## ★最重要发现（先读）：CONFIRMED 信任缺口
`k3s/.github/workflows/verify-image-pin.yml:60-71` 的 touches_pin 检测**只 grep 硬编码 cloud 路径**（`apps/aster-lang/cloud/image-lock.yaml` line 29/63 + literal `cloud/kustomization.yaml` line 64）。runner PR 改 `apps/aster-lang/runner/*` → touches_lock=false → no-op 分支（:74-77）→ App-minted check-run 发 **conclusion=success**（:185-199）→ **merges UNVERIFIED**（无 cosign verify/无 freshness/无 shape-check/无 digest 一致性）。
★**launcher image-pin #102 已走此 no-op 路径合入**——即已上线的 launcher digest 是 pinned 但**未经可信 verifier 验证**。full B 是闭合真安全洞非润色。

## SECTION A — open-image-pin-pr.sh（aster-api）
- **A1(a) 破 runner 的 gate**：`:113-115` kcount==1（`.images | map(select(.name==IMAGE)) | length`）——runner 不在 runner/kustomization → kcount=0 → exit 1。image-lock count==1 gate 在 `:110-111`。
- **A1(b) patch_targets()（:35-58）**：(1)image-lock 写 digest/sourceSha/runId（:38-42 match .image）(2)kustomization 写 digest（:44-46 match .name，**无条件跑**）(3)可选 ENV_PATCH（:49-57，两者都设才跑，验 `[$SELECTOR]|length==1` 后 `(SELECTOR).value=DIGEST`）。
- **A1(c) XOR guard**：主流程 `:63-70`（--source-only guard :61 后、clone/写前），只设其一 exit 2。
- **A1(d) 路径读**：ENV_PATCH_* `:30-31`（default 空）；LOCK_PATH `:75`（default cloud）；KUSTOMIZATION_PATH `:76`（default cloud）；IMAGE/BRANCH `:72-73`。
- **binding-mode 须改的行**：`:113-115`（kcount gate）+ `:44-46`（无条件 kustomization 写）+ `:127`（diff-check 含 KUSTOMIZATION_PATH）+ `:143`（git add 含 kustomization）+ 近 `:30-31/:75-76` 加 `PIN_DEPLOY_BINDING` 读（default `kustomization` 保零改动）。env 模式：跳 kcount + 不写 kustomization + 要求 ENV_PATCH_* present。
- **A2 回归测试** `open-image-pin-pr-thirdtarget.bats`（实为纯 bash 断言脚本）：Test1 无 ENV_PATCH→image-lock+kustomization 写、**deployment 字节级零改动**（:89 sha256）；Test2 有 ENV_PATCH→patch env+image-lock+kustomization；Test3 selector 0 命中→fail-closed；Test4 只设其一→exit 2。★须保 Test1 零改动 + 加 PIN_DEPLOY_BINDING=env 分支覆盖（跳 kcount+不写 kustomization）。
- **A3 workflow 调用**：runner `aster-replay-runner-deploy.yml:257-274`（LOCK/KUSTOMIZATION 指 runner + ENV_PATCH_PATH=runner/deployment.yaml + SELECTOR=`.spec.template.spec.containers[0].env[]|select(.name=="RUNNER_IMAGE_DIGEST")`）——**今天 :115 kcount=0 exit 1**。launcher `aster-runner-launcher-deploy.yml:149-162`（无 ENV_PATCH，launcher 在 runner/kustomization:39 → kcount=1 工作）。→ runner=env 模式，launcher+3 静态镜像=kustomization 模式。

## SECTION B — k3s 可信 verifier（安全核心）
- **B4 verify-image-pin.sh（196 行）**：args `<allowed> <base-lock> <head-lock> [head-kust] [base-kust]`（:30-34，脚本本身路径**从 args 传非硬编码**，硬编码在 workflow）。校验：image allowlist（:125-130）；digest/sourceSha shape（:145-146 拒 UNVERIFIED-SEED/全零）；★**kustomization digest==image-lock digest**（:151-158，传 HEAD_KUSTOMIZATION 时；**对 runner 敌意**——runner 无 .name match → kust_digest 空 → :154 fail-closed）；kustomization semantic-diff allowlist（:70-88 只许 images[].digest 变）；cosign verify（:163-174）+ freshness（:178-191 latest-only sourceSha==HEAD）。**无任何 RUNNER_IMAGE_DIGEST/deployment/env 概念**（grep 零命中）=缺口。
- **B5 check-pr-shape.sh（73 行）**：whitelist（:57-70）default cloud（:25-26，可 IMAGE_LOCK_PATH/KUSTOMIZATION_PATH env 覆盖但 **workflow 不传**→effective cloud only）。runner 改 runner/deployment.yaml → `*)` catch-all die（:65）**若 shape-check 跑**；但 B6 detection 不 fire 故实际**从不到达**（silently no-op）。
- **B6 verify-image-pin.yml detection（:60-71）**★CRITICAL：grep 硬编码 cloud（见顶）。runner PR MISSED→no-op success→UNVERIFIED merge。strict path（:79-161 fetch head/check-shape/cosign/freshness/render）对 runner 从不执行。strict fetch 也 cloud 硬编码（:87-96）。
- **B7 verify-cip-sync.sh（121 行）**：只 allowed-images↔CIP 契约（2N），runner 已覆盖（allowed-images:38-41+CIP 文件）。**full B 不动**。

## SECTION C — runner digest 绑定链
- **C8 launcher Go env→image ref 无变换**：`main.go:26-29` 读 `os.Getenv("RUNNER_IMAGE_DIGEST")`（空则 Fatal）→ `main.go:46` 注入 K8sOrchestrator.Digest → `orchestrator.go:25-27` runJob 透传 → `job.go:13`（repo const）+`:75/:86` `fmt.Sprintf("%s@%s", runnerImageRepo, digest)`。**env 值精确=image ref digest**（job_test.go:36 断言）。CIP admission 重验签名但**只证"获准身份签"非"最新/正确 digest"**——freshness+identity 预合并绑定正是缺失的 env-path verifier 须提供。
- **C9 verify-rendered-by-digest.yml**：只 `paths: cloud/**`（:16-17）+ 只渲 cloud（:31）+ controlled 只 aster-api/aster-cloud-migrate（:36）。**不覆盖 runner/launcher**（runner 从不作静态镜像渲染）。static-image render guard，正交，full B 不动。

## full B 须 ADD/MODIFY 汇总
1. **脚本**：`open-image-pin-pr.sh` 加 `PIN_DEPLOY_BINDING=kustomization|env`（default kustomization 保零改动）——env 模式 :113-115 跳 kcount + :44-46 不写 kustomization + 要求 ENV_PATCH_* present + :127/:143 不含 kustomization。runner workflow 传 `PIN_DEPLOY_BINDING=env`。
2. **k3s verifier detection**：`verify-image-pin.yml:60-71` grep 扩识 runner 路径（+ :87-96 fetch + :132-137 verify call + :142-161 render + check-pr-shape:57-70 whitelist 传 runner 路径）。
3. **k3s verify-image-pin.sh env-binding 分支**：env 模式镜像——(a) 从 runner/deployment.yaml 用同 selector 读 RUNNER_IMAGE_DIGEST value；(b) 断言 == cosign-验过的 image-lock runner digest；(c) 保 cosign+freshness 对 runner/image-lock；(d) deployment.yaml semantic-diff allowlist（类比 kustomization :70-88，只许该 env value 变）。
4. **回归**：保 Test1 零改动 + 加 env 模式 + 3 静态镜像路径不变。
5. **不动**：verify-cip-sync.sh / verify-rendered-by-digest.yml。
