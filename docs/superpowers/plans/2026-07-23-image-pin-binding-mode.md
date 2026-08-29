# image-pin binding-mode + 可信 verifier 泛化（full B）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现。步骤用 checkbox（`- [ ]`）追踪。

**Goal:** 让 runner 镜像 image-pin 按其真实 deploy-truth（Deployment 的 `RUNNER_IMAGE_DIGEST` env，非 kustomization transformer）工作，并**闭合已证实的信任洞**——runner/launcher image-pin PR 当前被 k3s 可信 verifier 漏检（no-op success）而 UNVERIFIED 合入。

**Architecture:** 两类 deploy-truth 分流。**kustomization-bound**（aster-api / aster-cloud-migrate / aster-runner-launcher）：镜像是容器 `image:` 字段，pin 落 kustomization `images:` transformer digest。**env-bound**（aster-replay-runner）：镜像由 launcher 运行时经 Deployment env `RUNNER_IMAGE_DIGEST` 注入，pin 落该 env value。k3s `allowed-images.yaml`（base 侧、可信、单源）新增 `deployBinding: kustomization|env` 字段，告诉 verifier 每个 image 走哪条验证路径。源仓脚本 `open-image-pin-pr.sh` 新增 `PIN_DEPLOY_BINDING` 封闭枚举 env 选择写入路径。

**Tech Stack:** Bash（`set -euo pipefail`）、yq v4.44.3、jq、cosign v3.1.1、GitHub Actions（`pull_request`，绝不 `pull_request_target`）、纯 bash 断言回归脚本（本机无 bats）。

## Global Constraints

- **交付顺序铁律（不可协商）：PART A（k3s verifier）先合入 main → PART B（aster-api script）后合入。** 反序会有窗口期：脚本先合入后 runner image-pin PR 会开出来，但 verifier 仍 no-op 它们 → UNVERIFIED 合入窗口。本计划 Task 顺序即交付顺序：A1→A2→A3→A4（PR-A）全部合入 main 后，才做 B1→B2→B3（PR-B）。
- **零改动铁律：** `PIN_DEPLOY_BINDING` 默认 `kustomization` → 4 个既有 image-pin 路径（aster-api / aster-cloud-migrate / aster-runner-launcher / cloud）字节不变。B2 的 Test 1 守此。verifier 对 kustomization-bound 镜像行为不变——只**新增** env-bound 分支与 runner 路径识别，cloud/launcher PR 走原路径。
- **verifier 只信 base 侧硬编码 selector/paths，绝不信 PR-head 供值。** `verify-image-pin.sh` env-binding 分支硬编码 `DEPLOYMENT="apps/aster-lang/runner/deployment.yaml"` 与 `SELECTOR='.spec.template.spec.containers[0].env[] | select(.name == "RUNNER_IMAGE_DIGEST") | .value'`，从可信 base checkout 侧固定。防恶意 selector 指向别处绕验。
- **注释与文档用简体中文**，描述意图/约束/用法（承 CLAUDE.md）。
- **无占位符：** 每步含真实内容，无 TODO / "类似 Task N" / "适当处理错误"。
- **本地验证，无 CI 外包：** 两脚本各配 bash 测试 harness，本地跑绿才提交。
- **安全敏感的已上线 CI：** 两脚本都是 live production CI。每处改动 fail-closed（失败即拒，绝不静默放行）。
- **每 Task 交叉审查（禁止自审）：** Claude 生成 → Codex 深审。
- **image 全限定名匹配：** image-lock/allowed-images 用 `docker.io/wontlost/...`（`open-image-pin-pr.sh` 的 `select(.image==IMAGE)`、`verify-image-pin.sh` 的 `select(.image == $img)` 精确匹配 `docker.io/` 前缀）。
- **仓根路径：** PART A 相对 `/Users/rpang/IdeaProjects/k3s`；PART B 相对 `/Users/rpang/IdeaProjects/aster-api`。

## 关键地面事实（file:line 实证，来自 factbase）

- **信任洞（预存，最严重）：** `k3s/.github/workflows/verify-image-pin.yml:60-71` 的 `touches_pin` 检测只 grep 硬编码 cloud 路径（`apps/aster-lang/cloud/image-lock.yaml` + literal `apps/aster-lang/cloud/kustomization.yaml`）。runner PR 改 `apps/aster-lang/runner/*` → `touches_lock=false` → no-op 分支（:74-77）→ App-minted check-run 发 `conclusion=success`（:185-199）→ **merges UNVERIFIED**（无 cosign / freshness / shape / digest 一致性）。launcher image-pin #102 已走此 no-op 路径合入。
- **runner `image-lock.yaml` 有两条 entry：** `docker.io/wontlost/aster-replay-runner`（env-bound）+ `docker.io/wontlost/aster-runner-launcher`（kustomization-bound，在 `runner/kustomization.yaml:images` 有条）。
- **runner `kustomization.yaml:images` 只含 launcher** 一条（runner 镜像**不在**其中——runner 是 env-bound，故 `open-image-pin-pr.sh:113-115` 的 `kcount==1`（按 `.name` 计数）对 runner 必然 `kcount=0` → exit 1）。
- **`RUNNER_IMAGE_DIGEST` env** 在 `apps/aster-lang/runner/deployment.yaml`（`runner-launcher` Deployment，env 列表 index 2：PORT / RUNNER_NAMESPACE / RUNNER_IMAGE_DIGEST）。★该 deployment.yaml 当前**未列入** `runner/kustomization.yaml:resources`（延后到解门 PR）——但 image-pin 脚本第三写目标与 verifier env-binding 分支都按**文件路径直接**读写它（不依赖它在 resources 里），无碍。
- **`verify-cip-sync.sh` 只读** 每 entry 的 `.image/.sourceRepo/.workflowFile/.sourceRef`（+ 顶层 `.oidcIssuer`）——新增 `deployBinding` 字段它不读，不受影响（已核实 `verify-cip-sync.sh:78-121`）。

---

# ══════════ PART A：k3s 可信 verifier（★先合入 main）══════════

> PR-A branch 名建议：`image-pin/binding-mode-verifier`。Task A1→A4 全部合入 k3s main 后，才启动 PART B。

## Task A1: allowed-images.yaml 加 `deployBinding` 字段（信任根单源声明）

**Files:**
- Modify: `/Users/rpang/IdeaProjects/k3s/.github/image-pin/allowed-images.yaml`（4 条 entry 各加一行 `deployBinding`）

**★人工提交说明：** 本文件受 push ruleset 保护（`allowed-images.yaml:5-8` 头注：禁 image-pin PR 修改，只走人工流程）。走 PR（main ruleset `require_pull_request`）即可在同 PR 改本文件——「受保护」是 merge 机制（须过 PR/review）非「须单独 PR」。故本 Task 是 PR-A 内的正常 commit（用显式路径 `git add`），由整个 PR-A 的 review 满足 ruleset。**实际的字段值 diff 已在下方 Step 1 全文给出，subagent 直接改。**

**Interfaces:**
- Consumes: allowed-images entry schema（`image`/`sourceRepo`/`workflowFile`/`sourceRef` 四字段，`allowed-images.yaml:18-51`）。
- Produces: 每 entry 多一个 `deployBinding: kustomization|env` 字段。verifier（Task A2）据此对每个变更 entry 选验证路径。★**显式给全 4 条**（不用「缺省默认 kustomization」——虽然 verifier 会默认，但显式声明清晰、防未来漏配）。

- [ ] **Step 1: 给 4 条 entry 各加 `deployBinding`**

编辑 `/Users/rpang/IdeaProjects/k3s/.github/image-pin/allowed-images.yaml`。四条 entry 现状与改后如下（每条在 `sourceRef` 行之后追加一行 `deployBinding`）：

aster-api 条（`:20-23` 之后）加：
```yaml
    deployBinding: kustomization      # 静态部署镜像：pin 落 cloud/kustomization images transformer
```

aster-cloud-migrate 条（`:29-32` 之后）加：
```yaml
    deployBinding: kustomization      # 静态部署镜像：pin 落 cloud/kustomization images transformer
```

aster-replay-runner 条（`:38-41` 之后）加：
```yaml
    deployBinding: env                # ★env-bound：runner 由 launcher 运行时经 Deployment env RUNNER_IMAGE_DIGEST 注入，pin 落该 env value（非 kustomization）
```

aster-runner-launcher 条（`:47-50` 之后）加：
```yaml
    deployBinding: kustomization      # 静态部署镜像：launcher 在 runner/kustomization images transformer
```

改后完整 `images:` 段应为（供 subagent 逐字比对）：

```yaml
images:
  # ── aster-api 主镜像 ──────────────────────────────────────────────
  - image: docker.io/wontlost/aster-api
    sourceRepo: aster-cloud/aster-api         # 唯一合法源仓（org=aster-cloud，非 wontlost-ltd）
    workflowFile: deploy.yml                  # 唯一合法签发 workflow
    sourceRef: refs/heads/main                # 唯一合法 ref（只信 main 构建）
    deployBinding: kustomization      # 静态部署镜像：pin 落 cloud/kustomization images transformer
    # verifier 据此拼 --certificate-identity：
    #   https://github.com/{sourceRepo}/.github/workflows/{workflowFile}@{sourceRef}
    # 并加 --certificate-github-workflow-{repository,ref,sha} 约束（sha 来自 image-lock）。

  # ── aster-cloud-migrate 迁移镜像 ──────────────────────────────────
  - image: docker.io/wontlost/aster-cloud-migrate
    sourceRepo: aster-cloud/aster-cloud       # 不同源仓 / 不同身份（Q2：分别验签）
    workflowFile: ci.yml
    sourceRef: refs/heads/main
    deployBinding: kustomization      # 静态部署镜像：pin 落 cloud/kustomization images transformer

  # ── aster-replay-runner runner 镜像（S2-1a-2 Slice-2b）─────────────
  # runner 由 in-cluster launcher 运行时启动的临时 Job 运行，源仓同 aster-api
  # 但独立 workflow（aster-replay-runner-deploy.yml）签发。verify-cip-sync 的
  # 2N 契约要求本条与两 runner CIP 同在（3 仓 → 6 CIP）。
  - image: docker.io/wontlost/aster-replay-runner
    sourceRepo: aster-cloud/aster-api         # 唯一合法源仓（org=aster-cloud）
    workflowFile: aster-replay-runner-deploy.yml
    sourceRef: refs/heads/main
    deployBinding: env                # ★env-bound：runner 由 launcher 运行时经 Deployment env RUNNER_IMAGE_DIGEST 注入，pin 落该 env value（非 kustomization）

  # ── aster-runner-launcher 镜像（S2-1a-2 Slice-2b-launch）─────────────
  # in-cluster runner-launcher 微服务镜像，源仓同 aster-api 但独立 workflow
  # （aster-runner-launcher-deploy.yml）签发。★verify-cip-sync 的 2N 契约因本条从
  # 3 仓/6 CIP 升为 4 仓/8 CIP——须与两 launcher CIP 原子同落。
  - image: docker.io/wontlost/aster-runner-launcher
    sourceRepo: aster-cloud/aster-api         # 唯一合法源仓（org=aster-cloud）
    workflowFile: aster-runner-launcher-deploy.yml
    sourceRef: refs/heads/main
    deployBinding: kustomization      # 静态部署镜像：launcher 在 runner/kustomization images transformer
```

- [ ] **Step 2: yq 校验 4 条 deployBinding 值合法且齐全**

Run:
```bash
cd /Users/rpang/IdeaProjects/k3s
yq '.images[] | .image + " => " + (.deployBinding // "MISSING")' .github/image-pin/allowed-images.yaml
yq '[.images[] | select((.deployBinding == "kustomization") or (.deployBinding == "env"))] | length' .github/image-pin/allowed-images.yaml
```
Expected：第一块 4 行——
```
docker.io/wontlost/aster-api => kustomization
docker.io/wontlost/aster-cloud-migrate => kustomization
docker.io/wontlost/aster-replay-runner => env
docker.io/wontlost/aster-runner-launcher => kustomization
```
第二块 `4`（4 条全是合法枚举值，无 MISSING、无非法值）。

- [ ] **Step 3: 跑 verify-cip-sync.sh 确认新字段不破坏 2N 契约（关键回归）**

Run: `cd /Users/rpang/IdeaProjects/k3s && ./scripts/image-pin/verify-cip-sync.sh; echo "exit=$?"`
Expected: `CIP-SYNC OK: 8 个 CIP 与信任根 4 仓契约一致` + `exit=0`。★`verify-cip-sync.sh` 只读 `.image/.sourceRepo/.workflowFile/.sourceRef`（`verify-cip-sync.sh:82-121`），忽略 `deployBinding`——此步证明加字段是纯增量、不触发 CIP 漂移。若非 0，回退检查是否误改了其它字段。

- [ ] **Step 4: Commit**

```bash
cd /Users/rpang/IdeaProjects/k3s
git add .github/image-pin/allowed-images.yaml
git commit -m "feat(image-pin): allowed-images 加 deployBinding 字段（kustomization|env 单源声明）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task A2: verify-image-pin.sh env-binding 验证分支

**Files:**
- Modify: `/Users/rpang/IdeaProjects/k3s/scripts/image-pin/verify-image-pin.sh`（新增 env-binding 分支 + deployment semantic-diff；kustomization 路径不变）
- Test: `/Users/rpang/IdeaProjects/k3s/scripts/image-pin/verify-image-pin-envbind.test.sh`（新建，纯 bash 断言 harness，`FRESHNESS=off` 离线）

**Interfaces:**
- Consumes: `deployBinding` 字段（Task A1）；现有参数 `<allowed> <base-lock> <head-lock> [head-kust] [base-kust]`（`verify-image-pin.sh:29-34`）。
- Produces: 新增两参数 `[head-deployment] [base-deployment]`（位置 6/7，env 模式用；kustomization 模式不传）。env-bound 镜像走 env-value 一致性 + deployment semantic-diff；kustomization-bound 镜像走原 kustomization-digest 一致性（`:148-158` 不变）。★verifier 从 `allowed_json` 读该 image 的 `deployBinding`（默认 `kustomization`），据此分流。

- [ ] **Step 1: 写 env-binding 失败测试（先写测试，红）**

新建 `/Users/rpang/IdeaProjects/k3s/scripts/image-pin/verify-image-pin-envbind.test.sh`：

```bash
#!/usr/bin/env bash
# 验 verify-image-pin.sh 的 env-binding 分支（deployBinding: env）：
#   (1) env-bound 镜像：deployment 的 RUNNER_IMAGE_DIGEST env value == image-lock digest → 过。
#   (2) env value != image-lock digest → fail-closed。
#   (3) deployment 除该 env value 外有其它字段变更（夹带）→ semantic-diff fail-closed。
#   (4) verifier 忽略 PR 供的 selector，只用 base 侧硬编码 selector（恶意 selector 无效）。
# ★离线测：FRESHNESS=off + 无 cosign（用 deployBinding=env 但把 cosign 步骤经 freshness=off 短路
#   不可行——cosign 仍会跑）。故本 harness 用一个**不在 allowed-images 白名单**触发不了 cosign？不行。
#   正解：本 harness 只验 env-binding 的**结构逻辑**（env value 读取 + 一致性 + semantic-diff），
#   用一个 stub allowed-images（含 runner entry deployBinding=env）+ FRESHNESS=off，并让 digest/sha
#   形状合法但 cosign 必然失败——故本 harness 断言的是「env-binding 校验在 cosign 之前 fail-closed」
#   与「env value 一致时能走到 cosign（cosign 失败是预期，不算 env-binding 逻辑失败）」。
# ★因 cosign 对占位 digest 必失败，本 harness 采取「分层断言」：
#   - 期望 PASS 的用例：断言错误输出**不含** env-binding 相关错误（env 一致性/ semantic-diff 均过），
#     只在 cosign 步失败（证明 env-binding 分支放行到了 cosign）。
#   - 期望 FAIL 的用例：断言错误输出**含**指定 env-binding 错误串（在 cosign 之前拦下）。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY="${SCRIPT_DIR}/verify-image-pin.sh"
FAILED=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILED=1; }

# 真实 40-hex sourceSha + 合法 sha256 digest（cosign 会失败，但形状过 shape 校验）。
SHA40="1111111111111111111111111111111111111111"
DIGEST="sha256:$(printf 'a%.0s' $(seq 1 64))"

make_allowed() {  # $1=deployBinding
  cat <<EOF
version: 1
oidcIssuer: https://token.actions.githubusercontent.com
images:
  - image: docker.io/wontlost/aster-replay-runner
    sourceRepo: aster-cloud/aster-api
    workflowFile: aster-replay-runner-deploy.yml
    sourceRef: refs/heads/main
    deployBinding: $1
EOF
}
make_base_lock() {
  cat <<EOF
version: 1
images:
  - image: docker.io/wontlost/aster-replay-runner
    digest: sha256:0000000000000000000000000000000000000000000000000000000000000000
    sourceSha: UNVERIFIED-SEED
    runId: "0"
EOF
}
make_head_lock() {  # $1=digest $2=sourceSha
  cat <<EOF
version: 1
images:
  - image: docker.io/wontlost/aster-replay-runner
    digest: $1
    sourceSha: $2
    runId: "42"
EOF
}
make_deployment() {  # $1=RUNNER_IMAGE_DIGEST value  $2=extra replicas 行(空或 "replicas: 9")
  cat <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: runner-launcher
  namespace: aster-runner
spec:
  ${2:-replicas: 0}
  selector:
    matchLabels:
      app.kubernetes.io/name: runner-launcher
  template:
    spec:
      containers:
        - name: runner-launcher
          image: docker.io/wontlost/aster-runner-launcher@sha256:0000000000000000000000000000000000000000000000000000000000000000
          env:
            - name: PORT
              value: "8080"
            - name: RUNNER_NAMESPACE
              value: aster-runner
            - name: RUNNER_IMAGE_DIGEST
              value: $1
EOF
}

echo "=== Test 1: env value == image-lock digest → env-binding 放行到 cosign（不因 env 逻辑失败）==="
T="$(mktemp -d)"
make_allowed env             > "$T/allowed.yaml"
make_base_lock               > "$T/base-lock.yaml"
make_head_lock "$DIGEST" "$SHA40" > "$T/head-lock.yaml"
make_deployment "$DIGEST" "" > "$T/head-deploy.yaml"
make_deployment "sha256:0000000000000000000000000000000000000000000000000000000000000000" "" > "$T/base-deploy.yaml"
out="$(IMAGE_PIN_FRESHNESS=off bash "$VERIFY" \
  "$T/allowed.yaml" "$T/base-lock.yaml" "$T/head-lock.yaml" "" "" "$T/head-deploy.yaml" "$T/base-deploy.yaml" 2>&1)"
if grep -q "RUNNER_IMAGE_DIGEST" <<<"$out" && grep -qi "env value.*!=\|deployment semantic-diff" <<<"$out"; then
  fail "env 一致时不应报 env-binding 错（实际报了：$(grep -i 'env value\|semantic-diff' <<<"$out" | head -1)）"
else
  pass "env value 一致 → 未触发 env-binding fail-closed（放行到 cosign）"
fi
rm -rf "$T"

echo "=== Test 2: env value != image-lock digest → env-binding fail-closed（cosign 前拦下）==="
T="$(mktemp -d)"
make_allowed env             > "$T/allowed.yaml"
make_base_lock               > "$T/base-lock.yaml"
make_head_lock "$DIGEST" "$SHA40" > "$T/head-lock.yaml"
WRONG="sha256:$(printf 'b%.0s' $(seq 1 64))"
make_deployment "$WRONG" ""  > "$T/head-deploy.yaml"
make_deployment "sha256:0000000000000000000000000000000000000000000000000000000000000000" "" > "$T/base-deploy.yaml"
out="$(IMAGE_PIN_FRESHNESS=off bash "$VERIFY" \
  "$T/allowed.yaml" "$T/base-lock.yaml" "$T/head-lock.yaml" "" "" "$T/head-deploy.yaml" "$T/base-deploy.yaml" 2>&1)"
rc=$?
if [[ "$rc" != "0" ]] && grep -q "RUNNER_IMAGE_DIGEST env value" <<<"$out"; then
  pass "env value 不一致 → 非零退出 + 报 env value 错（fail-closed）"
else
  fail "env value 不一致未 fail-closed（rc=$rc）"
fi
rm -rf "$T"

echo "=== Test 3: deployment 夹带其它字段变更（replicas 0→9）→ semantic-diff fail-closed ==="
T="$(mktemp -d)"
make_allowed env             > "$T/allowed.yaml"
make_base_lock               > "$T/base-lock.yaml"
make_head_lock "$DIGEST" "$SHA40" > "$T/head-lock.yaml"
make_deployment "$DIGEST" "replicas: 9" > "$T/head-deploy.yaml"   # env value 对，但 replicas 被改
make_deployment "sha256:0000000000000000000000000000000000000000000000000000000000000000" "replicas: 0" > "$T/base-deploy.yaml"
out="$(IMAGE_PIN_FRESHNESS=off bash "$VERIFY" \
  "$T/allowed.yaml" "$T/base-lock.yaml" "$T/head-lock.yaml" "" "" "$T/head-deploy.yaml" "$T/base-deploy.yaml" 2>&1)"
rc=$?
if [[ "$rc" != "0" ]] && grep -q "deployment semantic-diff" <<<"$out"; then
  pass "deployment 夹带其它变更 → semantic-diff fail-closed"
else
  fail "deployment 夹带变更未被 semantic-diff 拦（rc=$rc）"
fi
rm -rf "$T"

echo ""
if [[ "$FAILED" == "0" ]]; then
  echo "全部通过（env value 一致性 + semantic-diff allowlist + fail-closed）。"; exit 0
else
  echo "存在失败用例，见上方 ✗。"; exit 1
fi
```

- [ ] **Step 2: 跑测试确认红（脚本尚无 env-binding 分支）**

Run: `cd /Users/rpang/IdeaProjects/k3s && bash scripts/image-pin/verify-image-pin-envbind.test.sh; echo "exit=$?"`
Expected: FAIL——`exit=1`。当前 `verify-image-pin.sh` 不接受第 6/7 参数、不读 `deployBinding`、无 env value 校验，Test 2/3 期望的错误串不会出现（脚本会在别处失败或放行），断言不满足。

- [ ] **Step 3: 在 verify-image-pin.sh 加参数 + env-binding 分支（实现）**

改 `/Users/rpang/IdeaProjects/k3s/scripts/image-pin/verify-image-pin.sh`。

(a) `:29-35` 的 USAGE + 参数块，把 USAGE 与新参数补齐：

原（`:29-35`）：
```bash
USAGE="usage: verify-image-pin.sh <allowed> <base-lock> <head-lock> [head-kustomization] [base-kustomization]"
ALLOWED="${1:?$USAGE}"
BASE_LOCK="${2:?$USAGE}"
HEAD_LOCK="${3:?$USAGE}"
HEAD_KUSTOMIZATION="${4:-}"
BASE_KUSTOMIZATION="${5:-}"
FRESHNESS="${IMAGE_PIN_FRESHNESS:-latest-only}"
```
改为：
```bash
USAGE="usage: verify-image-pin.sh <allowed> <base-lock> <head-lock> [head-kustomization] [base-kustomization] [head-deployment] [base-deployment]"
ALLOWED="${1:?$USAGE}"
BASE_LOCK="${2:?$USAGE}"
HEAD_LOCK="${3:?$USAGE}"
HEAD_KUSTOMIZATION="${4:-}"
BASE_KUSTOMIZATION="${5:-}"
# ★env-binding（deployBinding: env）的部署真相载体（runner Deployment）：head/base 两侧。
#   仅 env-bound 镜像用；kustomization-bound 镜像忽略这两参数（走上面的 kustomization 路径）。
HEAD_DEPLOYMENT="${6:-}"
BASE_DEPLOYMENT="${7:-}"
FRESHNESS="${IMAGE_PIN_FRESHNESS:-latest-only}"

# ★★verifier 硬编码 base 侧 selector（用户决策②：绝不信 PR/workflow 供的 selector，防恶意 selector
#   指向别处绕验）。env-bound 镜像的部署真相恒为 runner Deployment 的 RUNNER_IMAGE_DIGEST env value。
ENV_BIND_SELECTOR='.spec.template.spec.containers[0].env[] | select(.name == "RUNNER_IMAGE_DIGEST") | .value'
```

(b) 在 per-entry 循环里、`digest` 形状校验（`:145-146`）之后、kustomization 一致性（`:148`）之前，读取本 image 的 `deployBinding` 并分流。把原 `:148-158` 的 kustomization 一致性块用 `deployBinding == kustomization` 条件包起来，并新增 `env` 分支。

原（`:148-158`）：
```bash
  # ── Phase 3 keystone：kustomization digest 一致性（部署真相 == 验签真相）──
  # 提供了 head kustomization 时：本镜像在 kustomization.images 里必须存在且 digest 与 image-lock
  # 相等。否则"验签通过的 digest"与"实际部署的 digest"可能不一致 → 打穿 by-digest 保证。
  if [[ -n "$HEAD_KUSTOMIZATION" ]]; then
    kust_digest="$(jq -r --arg img "$image" '.images[]? | select(.name == $img) | .digest // empty' <<<"$kust_json")"
    [[ -n "$kust_digest" ]] \
      || { echo "::error::entry[$i] ${image} 在 kustomization.images 中缺失（部署不会 by-digest 该镜像）"; fail=1; continue; }
    [[ "$kust_digest" == "$digest" ]] \
      || { echo "::error::entry[$i] kustomization digest(${kust_digest}) != image-lock digest(${digest})（部署真相与验签真相不一致）"; fail=1; continue; }
    info "  kustomization 一致性 OK（deploy digest == verified digest）"
  fi
```
改为：
```bash
  # ── 部署真相一致性（binding-mode 分流）──
  # 每个 image 的部署真相载体由 allowed-images 的 deployBinding 决定（可信 base 侧单源，非 PR head）：
  #   kustomization（默认）：kustomization.images[].digest == image-lock digest（静态部署镜像）。
  #   env：runner Deployment 的 RUNNER_IMAGE_DIGEST env value == image-lock digest（launcher 运行时注入）。
  binding="$(jq -r --arg img "$image" '.images[] | select(.image == $img) | .deployBinding // "kustomization"' <<<"$allowed_json")"
  [[ "$binding" == "kustomization" || "$binding" == "env" ]] \
    || { echo "::error::entry[$i] allowed-images deployBinding 非法值：$binding（须 kustomization|env）"; fail=1; continue; }

  if [[ "$binding" == "kustomization" ]]; then
    # ── Phase 3 keystone：kustomization digest 一致性（部署真相 == 验签真相）──
    # 提供了 head kustomization 时：本镜像在 kustomization.images 里必须存在且 digest 与 image-lock
    # 相等。否则"验签通过的 digest"与"实际部署的 digest"可能不一致 → 打穿 by-digest 保证。
    if [[ -n "$HEAD_KUSTOMIZATION" ]]; then
      kust_digest="$(jq -r --arg img "$image" '.images[]? | select(.name == $img) | .digest // empty' <<<"$kust_json")"
      [[ -n "$kust_digest" ]] \
        || { echo "::error::entry[$i] ${image} 在 kustomization.images 中缺失（部署不会 by-digest 该镜像）"; fail=1; continue; }
      [[ "$kust_digest" == "$digest" ]] \
        || { echo "::error::entry[$i] kustomization digest(${kust_digest}) != image-lock digest(${digest})（部署真相与验签真相不一致）"; fail=1; continue; }
      info "  kustomization 一致性 OK（deploy digest == verified digest）"
    fi
  else
    # ── env-binding：runner Deployment 的 RUNNER_IMAGE_DIGEST env value == image-lock digest ──
    # ★用 base 侧硬编码 ENV_BIND_SELECTOR（不信 PR 供的 selector），读 head deployment 的 env value，
    #   断言 == 本次将 cosign-验签的 image-lock digest（env value 即部署真相；launcher 用它构 runner 引用）。
    [[ -n "$HEAD_DEPLOYMENT" ]] \
      || { echo "::error::entry[$i] ${image} 是 env-bound 但未提供 head-deployment（无法校验 RUNNER_IMAGE_DIGEST env value）"; fail=1; continue; }
    [[ -f "$HEAD_DEPLOYMENT" ]] \
      || { echo "::error::entry[$i] head-deployment 不存在：$HEAD_DEPLOYMENT"; fail=1; continue; }
    env_value="$(yq "$ENV_BIND_SELECTOR" "$HEAD_DEPLOYMENT" 2>/dev/null || true)"
    [[ -n "$env_value" && "$env_value" != "null" ]] \
      || { echo "::error::entry[$i] head-deployment 中 RUNNER_IMAGE_DIGEST env 缺失/为空（selector=硬编码 base 侧）"; fail=1; continue; }
    [[ "$env_value" == "$digest" ]] \
      || { echo "::error::entry[$i] RUNNER_IMAGE_DIGEST env value(${env_value}) != image-lock digest(${digest})（部署真相与验签真相不一致）"; fail=1; continue; }
    info "  env-binding 一致性 OK（RUNNER_IMAGE_DIGEST env == verified digest）"

    # ── deployment semantic-diff allowlist（类比 kustomization :70-88）──
    # push ruleset 放开了 runner/deployment.yaml 整文件 → 必须证明 image-pin PR **只改了** 该
    #   RUNNER_IMAGE_DIGEST env value，其它字段（replicas/securityContext/其它 env/probe…）与 base
    #   完全相同。否则攻击者可借 image-pin PR 改部署语义（如 replicas 0→N、放松 securityContext）而 verify 放行。
    # 实现：把两侧 deployment 的该 env value 归一化为占位后，要求全文 JSON 相等（原生 yq→json，类型级严格）。
    [[ -n "$BASE_DEPLOYMENT" ]] \
      || { [[ "$FRESHNESS" == "off" ]] || { echo "::error::entry[$i] env-bound 提供了 head-deployment 但缺 base-deployment → 无法做 semantic-diff（生产必须两侧都传）"; fail=1; continue; }; info "  （freshness=off 单测：跳过 deployment semantic-diff）"; }
    if [[ -n "$BASE_DEPLOYMENT" ]]; then
      [[ -f "$BASE_DEPLOYMENT" ]] || { echo "::error::entry[$i] base-deployment 不存在：$BASE_DEPLOYMENT"; fail=1; continue; }
      env_norm='(.spec.template.spec.containers[0].env[] | select(.name == "RUNNER_IMAGE_DIGEST")).value = "__NORM__"'
      base_dep_norm="$(yq -o=json "$env_norm" "$BASE_DEPLOYMENT" | jq -S '.')"
      head_dep_norm="$(yq -o=json "$env_norm" "$HEAD_DEPLOYMENT" | jq -S '.')"
      if [[ "$base_dep_norm" != "$head_dep_norm" ]]; then
        echo "::error::entry[$i] deployment 除 RUNNER_IMAGE_DIGEST env value 外有其它变更（禁止：image-pin PR 只能改该 env value，不得改 replicas/securityContext/其它 env 等部署语义）"
        diff <(echo "$base_dep_norm") <(echo "$head_dep_norm") | head -40 >&2 || true
        echo "::error::entry[$i] deployment semantic-diff 校验失败 → fail-closed"; fail=1; continue
      fi
      info "  deployment semantic-diff OK（仅 RUNNER_IMAGE_DIGEST env value 变更）"
    fi
  fi
```

★注意：`env_norm` 用 `yq -o=json`（原生，不做 `to_str` 数值转字符串）——与 kustomization semantic-diff（`:68-69` 注释）同理，deployment 无数值型 SHA 问题，类型级比较更严。cosign verify（`:163-174`）与 freshness（`:178-191`）对 runner/image-lock 保持不变——env-binding 只替换「部署真相一致性」这一段，验签+freshness 照旧。

- [ ] **Step 4: 跑测试确认绿**

Run: `cd /Users/rpang/IdeaProjects/k3s && bash scripts/image-pin/verify-image-pin-envbind.test.sh; echo "exit=$?"`
Expected: `全部通过（env value 一致性 + semantic-diff allowlist + fail-closed）。` + `exit=0`。

- [ ] **Step 5: 回归——原 kustomization 路径的既有单测（若有）仍绿**

Run（若仓内有 `verify-image-pin` 的既有测试，跑之；否则用一个 cloud-shape smoke 验 kustomization 分支未破）:
```bash
cd /Users/rpang/IdeaProjects/k3s
ls scripts/image-pin/*.test.sh scripts/image-pin/*.bats 2>/dev/null
# 若存在既有 verify-image-pin 测试，逐个 bash 跑并确认 exit=0；
# 若无，构造一个 kustomization-bound smoke（deployBinding 缺省→kustomization，不传 deployment 参数）：
T="$(mktemp -d)"
cat > "$T/allowed.yaml" <<'EOF'
version: 1
oidcIssuer: https://token.actions.githubusercontent.com
images:
  - image: docker.io/wontlost/aster-api
    sourceRepo: aster-cloud/aster-api
    workflowFile: deploy.yml
    sourceRef: refs/heads/main
    deployBinding: kustomization
EOF
cat > "$T/base-lock.yaml" <<'EOF'
version: 1
images:
  - image: docker.io/wontlost/aster-api
    digest: sha256:e6a7d90bfd7ceff0a70de84c943aeca3cb77b3d86bb0c69d273ae7afa9fce5e3
    sourceSha: fb1b41204f5effd6c22c5d848341ee12d2e48f4f
    runId: "1"
EOF
cp "$T/base-lock.yaml" "$T/head-lock.yaml"   # 无变更 entry → 应 0 变更、exit 0
IMAGE_PIN_FRESHNESS=off bash scripts/image-pin/verify-image-pin.sh \
  "$T/allowed.yaml" "$T/base-lock.yaml" "$T/head-lock.yaml"; echo "kust-smoke exit=$?"
rm -rf "$T"
```
Expected: `image-pin 验签通过（变更 entry 数=0）` + `kust-smoke exit=0`（kustomization 分支：无变更 entry 全跳过，不因新代码 break）。

- [ ] **Step 6: Commit**

```bash
cd /Users/rpang/IdeaProjects/k3s
git add scripts/image-pin/verify-image-pin.sh scripts/image-pin/verify-image-pin-envbind.test.sh
git commit -m "feat(image-pin): verify-image-pin.sh env-binding 分支（RUNNER_IMAGE_DIGEST 一致性 + deployment semantic-diff，硬编码 base 侧 selector）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task A3: check-pr-shape.sh runner whitelist（env 模式 PR 形状）

**Files:**
- Modify: `/Users/rpang/IdeaProjects/k3s/scripts/image-pin/check-pr-shape.sh`（whitelist 支持 runner 形状；cloud 形状不变）
- Test: `/Users/rpang/IdeaProjects/k3s/scripts/image-pin/check-pr-shape-runner.test.sh`（新建，纯 bash 断言）

**Interfaces:**
- Consumes: 现有 env `IMAGE_LOCK_PATH`/`KUSTOMIZATION_PATH`（`check-pr-shape.sh:25-26`，workflow 可覆盖）。
- Produces: 新增 env `DEPLOYMENT_PATH`（可选）——workflow（Task A4）在 runner PR 传 `IMAGE_LOCK_PATH=apps/aster-lang/runner/image-lock.yaml` + `DEPLOYMENT_PATH=apps/aster-lang/runner/deployment.yaml`。设了 `DEPLOYMENT_PATH` 时 whitelist = `{image-lock, deployment}`（runner env 形状，**不含 kustomization**）；未设时 whitelist = `{image-lock, kustomization}`（cloud/launcher 形状，不变）。两形状均要求 image-lock 必被改。

- [ ] **Step 1: 写 runner-shape 失败测试（先写，红）**

新建 `/Users/rpang/IdeaProjects/k3s/scripts/image-pin/check-pr-shape-runner.test.sh`：

```bash
#!/usr/bin/env bash
# 验 check-pr-shape.sh 的 runner env-shape（DEPLOYMENT_PATH 设定时）：
#   (1) 改 runner/image-lock + runner/deployment → 放行。
#   (2) 改 runner/image-lock + runner/kustomization（runner 形状不含 kust）→ 拒。
#   (3) 改 runner/deployment 但不改 image-lock → 拒（image-lock 必被改）。
#   (4) 夹带 .github/** → 拒。
# ★cloud 形状（不设 DEPLOYMENT_PATH）不受影响——由 check-pr-shape.sh 既有测试守（本 harness 不重测）。
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHAPE="${SCRIPT_DIR}/check-pr-shape.sh"
FAILED=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILED=1; }

# 合法 image-pin bot PR 事件 payload（非 fork、Bot author、head 分支 image-pin/*）。
EVENT="$(mktemp)"
cat > "$EVENT" <<'EOF'
{
  "pull_request": {
    "head": { "repo": { "full_name": "wontlost-ltd/k3s" }, "ref": "image-pin/aster-replay-runner" },
    "base": { "repo": { "full_name": "wontlost-ltd/k3s" } },
    "user": { "login": "aster-image-pin[bot]", "id": 301590099, "type": "Bot" }
  }
}
EOF

run_shape() {  # $1=changed-files 内容（多行）→ echo exit code
  local changed; changed="$(mktemp)"; printf '%s\n' "$1" > "$changed"
  IMAGE_LOCK_PATH=apps/aster-lang/runner/image-lock.yaml \
  DEPLOYMENT_PATH=apps/aster-lang/runner/deployment.yaml \
    bash "$SHAPE" "$EVENT" "$changed" >/dev/null 2>&1
  echo $?
  rm -f "$changed"
}

echo "=== Test 1: runner/image-lock + runner/deployment → 放行（exit 0）==="
rc="$(run_shape $'apps/aster-lang/runner/image-lock.yaml\napps/aster-lang/runner/deployment.yaml')"
[[ "$rc" == "0" ]] && pass "runner env-shape 放行" || fail "runner env-shape 未放行（rc=$rc）"

echo "=== Test 2: runner/image-lock + runner/kustomization → 拒（runner 形状不含 kust）==="
rc="$(run_shape $'apps/aster-lang/runner/image-lock.yaml\napps/aster-lang/runner/kustomization.yaml')"
[[ "$rc" != "0" ]] && pass "runner 形状拒 kustomization" || fail "runner 形状误放行 kustomization（rc=$rc）"

echo "=== Test 3: 只改 runner/deployment 不改 image-lock → 拒 ==="
rc="$(run_shape 'apps/aster-lang/runner/deployment.yaml')"
[[ "$rc" != "0" ]] && pass "缺 image-lock → 拒" || fail "缺 image-lock 误放行（rc=$rc）"

echo "=== Test 4: 夹带 .github/** → 拒 ==="
rc="$(run_shape $'apps/aster-lang/runner/image-lock.yaml\napps/aster-lang/runner/deployment.yaml\n.github/workflows/evil.yml')"
[[ "$rc" != "0" ]] && pass "夹带 .github/** → 拒" || fail "夹带 .github/** 误放行（rc=$rc）"

rm -f "$EVENT"
echo ""
if [[ "$FAILED" == "0" ]]; then echo "全部通过（runner env-shape whitelist）。"; exit 0
else echo "存在失败用例，见上方 ✗。"; exit 1; fi
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd /Users/rpang/IdeaProjects/k3s && bash scripts/image-pin/check-pr-shape-runner.test.sh; echo "exit=$?"`
Expected: FAIL——`exit=1`。当前 `check-pr-shape.sh` 无 `DEPLOYMENT_PATH` 概念，whitelist 恒为 `{image-lock, kustomization}`——Test 1（deployment）会被 `*)` catch-all 拒（应放行却拒），Test 2（kustomization）会被放行（应拒却放行）。

- [ ] **Step 3: 在 check-pr-shape.sh 加 DEPLOYMENT_PATH 分流（实现）**

改 `/Users/rpang/IdeaProjects/k3s/scripts/image-pin/check-pr-shape.sh`。

(a) `:25-26` 的 env 读取后加 `DEPLOYMENT_PATH`：

原（`:25-26`）：
```bash
LOCK_PATH="${IMAGE_LOCK_PATH:-apps/aster-lang/cloud/image-lock.yaml}"
KUSTOMIZATION_PATH="${KUSTOMIZATION_PATH:-apps/aster-lang/cloud/kustomization.yaml}"
```
改为：
```bash
LOCK_PATH="${IMAGE_LOCK_PATH:-apps/aster-lang/cloud/image-lock.yaml}"
KUSTOMIZATION_PATH="${KUSTOMIZATION_PATH:-apps/aster-lang/cloud/kustomization.yaml}"
# ★env-binding（runner）PR 形状：部署真相是 Deployment 的 RUNNER_IMAGE_DIGEST env（非 kustomization）。
#   设 DEPLOYMENT_PATH（workflow 对 runner PR 传）→ whitelist = {image-lock, deployment}（不含 kustomization）。
#   未设 → cloud/launcher 形状 = {image-lock, kustomization}（不变，零改动铁律）。
DEPLOYMENT_PATH="${DEPLOYMENT_PATH:-}"
```

(b) `:57-70` 的 whitelist 循环改为 binding-mode 分流：

原（`:57-70`）：
```bash
# ── 改动文件必须只在 {image-lock, kustomization} 白名单内；且 image-lock 必须被改 ──
mapfile -t files < <(grep -v '^[[:space:]]*$' "$CHANGED" || true)
[[ "${#files[@]}" -gt 0 ]] || die "PR 无改动文件"
touched_lock=false
for f in "${files[@]}"; do
  case "$f" in
    "$LOCK_PATH")          touched_lock=true ;;
    "$KUSTOMIZATION_PATH") : ;;   # 允许（部署真相），一致性由 verify-image-pin.sh 校验
    *) die "image-pin PR 只能改 ${LOCK_PATH} 和 ${KUSTOMIZATION_PATH}, 却改了 ${f} (触碰 .github/**, CODEOWNERS, allowed-images.yaml 等一律拒)" ;;
  esac
done
# image-lock 是验签真相，必须被改（只改 kustomization 而不改 image-lock ＝ 绕过验签，拒）。
[[ "$touched_lock" == "true" ]] \
  || die "image-pin PR 必须改 ${LOCK_PATH}（验签真相）；只改 kustomization 会绕过验签"
```
改为：
```bash
# ── 改动文件必须只在部署真相 whitelist 内；且 image-lock 必须被改 ──
# binding-mode 分流：设了 DEPLOYMENT_PATH → env 形状 {image-lock, deployment}；否则 cloud/launcher
#   形状 {image-lock, kustomization}。两形状都要求 image-lock 被改（验签真相），只改部署载体=绕验签，拒。
if [[ -n "$DEPLOYMENT_PATH" ]]; then
  DEPLOY_TRUTH_PATH="$DEPLOYMENT_PATH"
  DEPLOY_TRUTH_DESC="deployment（RUNNER_IMAGE_DIGEST env）"
else
  DEPLOY_TRUTH_PATH="$KUSTOMIZATION_PATH"
  DEPLOY_TRUTH_DESC="kustomization"
fi
mapfile -t files < <(grep -v '^[[:space:]]*$' "$CHANGED" || true)
[[ "${#files[@]}" -gt 0 ]] || die "PR 无改动文件"
touched_lock=false
for f in "${files[@]}"; do
  case "$f" in
    "$LOCK_PATH")         touched_lock=true ;;
    "$DEPLOY_TRUTH_PATH") : ;;   # 允许（部署真相），一致性由 verify-image-pin.sh 校验
    *) die "image-pin PR 只能改 ${LOCK_PATH} 和 ${DEPLOY_TRUTH_PATH}(${DEPLOY_TRUTH_DESC}), 却改了 ${f} (触碰 .github/**, CODEOWNERS, allowed-images.yaml, kustomization 等一律拒)" ;;
  esac
done
# image-lock 是验签真相，必须被改（只改部署载体而不改 image-lock ＝ 绕过验签，拒）。
[[ "$touched_lock" == "true" ]] \
  || die "image-pin PR 必须改 ${LOCK_PATH}（验签真相）；只改 ${DEPLOY_TRUTH_DESC} 会绕过验签"
```

(c) 末行 `:72` 的成功日志把 `$LOCK_PATH` 描述补上部署载体（可选微调，保持一致）：

原（`:72`）：
```bash
echo ">> PR 形状/来源合法：author=$author_login(id=$author_id,Bot) head=$head_ref 仅改 $LOCK_PATH"
```
改为：
```bash
echo ">> PR 形状/来源合法：author=$author_login(id=$author_id,Bot) head=$head_ref 仅改 $LOCK_PATH + $DEPLOY_TRUTH_PATH($DEPLOY_TRUTH_DESC)"
```

- [ ] **Step 4: 跑 runner 测试确认绿**

Run: `cd /Users/rpang/IdeaProjects/k3s && bash scripts/image-pin/check-pr-shape-runner.test.sh; echo "exit=$?"`
Expected: `全部通过（runner env-shape whitelist）。` + `exit=0`。

- [ ] **Step 5: 回归——cloud 形状不变（不设 DEPLOYMENT_PATH）**

Run（构造 cloud-shape smoke：不设 DEPLOYMENT_PATH，验 {image-lock, kustomization} 仍工作、deployment 被拒）:
```bash
cd /Users/rpang/IdeaProjects/k3s
EVENT="$(mktemp)"; cat > "$EVENT" <<'EOF'
{"pull_request":{"head":{"repo":{"full_name":"wontlost-ltd/k3s"},"ref":"image-pin/aster-api"},"base":{"repo":{"full_name":"wontlost-ltd/k3s"}},"user":{"login":"aster-image-pin[bot]","id":301590099,"type":"Bot"}}}
EOF
CH="$(mktemp)"; printf '%s\n' "apps/aster-lang/cloud/image-lock.yaml" "apps/aster-lang/cloud/kustomization.yaml" > "$CH"
bash scripts/image-pin/check-pr-shape.sh "$EVENT" "$CH"; echo "cloud-shape exit=$?"
printf '%s\n' "apps/aster-lang/cloud/image-lock.yaml" "apps/aster-lang/runner/deployment.yaml" > "$CH"
bash scripts/image-pin/check-pr-shape.sh "$EVENT" "$CH" >/dev/null 2>&1; echo "cloud-shape 拒 deployment exit=$?"
rm -f "$EVENT" "$CH"
```
Expected: 第一次 `cloud-shape exit=0`（cloud 双写形状放行）；第二次 `cloud-shape 拒 deployment exit=1`（不设 DEPLOYMENT_PATH 时 deployment 非白名单，拒）。证明零改动铁律：cloud 形状未变。

- [ ] **Step 6: Commit**

```bash
cd /Users/rpang/IdeaProjects/k3s
git add scripts/image-pin/check-pr-shape.sh scripts/image-pin/check-pr-shape-runner.test.sh
git commit -m "feat(image-pin): check-pr-shape.sh runner env-shape whitelist（DEPLOYMENT_PATH 分流，cloud 形状不变）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task A4: verify-image-pin.yml detection 泛化（★信任洞闭合，最安全关键）

**Files:**
- Modify: `/Users/rpang/IdeaProjects/k3s/.github/workflows/verify-image-pin.yml`（detection + fetch + check-pr-shape 调用 + verify 调用 + render 均 runner-path aware）

**★这是信任洞的直接闭合：** 当前 `touches_pin` 只 grep cloud 路径 → runner PR 漏检 no-op success → UNVERIFIED merge。本 Task 让 workflow 识别 runner 路径并派生对应 deployment/kustomization 路径，走 strict path。

**Interfaces:**
- Consumes: Task A2 的 `verify-image-pin.sh`（新 6/7 参数 head/base-deployment）、Task A3 的 `check-pr-shape.sh`（`DEPLOYMENT_PATH` env）。
- Produces: workflow 对 cloud PR 走 kustomization strict path（不变），对 runner PR 走 env strict path（新增）。cloud 与 runner 互不影响。

★**验证方式说明：** GitHub Actions workflow 无法在本地无成本地端到端跑（需真 PR 事件 + cosign + gh api）。本 Task 的验证是**结构自检**：(a) YAML 语法合法（`yq` 解析过）；(b) 逐条比对下方 diff 已含 runner 路径识别 + 派生 + 参数传递；(c) 归纳法——A2/A3 脚本已本地测绿，workflow 只负责把正确的路径/参数喂给它们。真端到端在 PR-A 合入后由 Task C1 的 launcher back-verify + 首个真 runner CI PR 覆盖。

- [ ] **Step 1: detection 泛化 + 派生路径（`:28-72`）**

在 `env:` 段（`:28-29`）保留 `LOCK_PATH`（cloud），并在 `Compute changed files` step（`:42-72`）里加 runner 路径识别与「本 PR 是 cloud 还是 runner」的判定，输出派生路径供后续 step 用。

原 `env:`（`:28-29`）：
```yaml
env:
  LOCK_PATH: apps/aster-lang/cloud/image-lock.yaml
```
改为：
```yaml
env:
  # cloud（静态部署镜像）路径：aster-api/aster-cloud-migrate 的 kustomization-bound pin。
  CLOUD_LOCK_PATH: apps/aster-lang/cloud/image-lock.yaml
  CLOUD_KUST_PATH: apps/aster-lang/cloud/kustomization.yaml
  # runner（env-bound + launcher kustomization-bound 共用同一 image-lock 文件）路径。
  #   runner image-lock 含两 entry（aster-replay-runner=env / aster-runner-launcher=kustomization）；
  #   env-bound 的部署真相载体是 runner/deployment.yaml 的 RUNNER_IMAGE_DIGEST env。
  RUNNER_LOCK_PATH: apps/aster-lang/runner/image-lock.yaml
  RUNNER_DEPLOY_PATH: apps/aster-lang/runner/deployment.yaml
  RUNNER_KUST_PATH: apps/aster-lang/runner/kustomization.yaml
```

原 `Compute changed files` step 的脚本体（`:45-72`）：
```yaml
        run: |
          set -euo pipefail
          mkdir -p /tmp/pr
          gh api "repos/${{ github.repository }}/pulls/${{ github.event.pull_request.number }}/files" \
            --paginate --jq '.[].filename' > /tmp/pr/changed-files.txt
          echo "改动文件："; cat /tmp/pr/changed-files.txt
          # 验签脚本只从**可信 base 侧**运行（不信 PR 改动的验签器代码）。若 base 尚无这些
          # 脚本（引入本机制的 bootstrap PR 自身），则无法在此 PR 上验签 → no-op（安全：
          # 此时 ruleset 仍 evaluate，且脚本一旦入 main，后续 image-pin PR 即走严格路径）。
          if [[ -f scripts/image-pin/verify-image-pin.sh && -f scripts/image-pin/check-pr-shape.sh ]]; then
            scripts_present=true
          else
            scripts_present=false
            echo "::notice::base 侧无 image-pin 验签脚本（bootstrap PR）→ 本 PR no-op"
          fi
          # ★ Codex 审查 Critical#1：严格路径触发 = image-lock **或** kustomization 任一被改。
          # 否则"只改 kustomization 不改 image-lock"的 PR 会走 no-op success 绕过 check-pr-shape。
          touches_pin=false
          if grep -qxF "$LOCK_PATH" /tmp/pr/changed-files.txt \
             || grep -qxF "apps/aster-lang/cloud/kustomization.yaml" /tmp/pr/changed-files.txt; then
            touches_pin=true
          fi
          if [[ "$touches_pin" == "true" && "$scripts_present" == "true" ]]; then
            echo "touches_lock=true"  >> "$GITHUB_OUTPUT"
          else
            echo "touches_lock=false" >> "$GITHUB_OUTPUT"
          fi
        id: changed
```
改为：
```yaml
        run: |
          set -euo pipefail
          mkdir -p /tmp/pr
          gh api "repos/${{ github.repository }}/pulls/${{ github.event.pull_request.number }}/files" \
            --paginate --jq '.[].filename' > /tmp/pr/changed-files.txt
          echo "改动文件："; cat /tmp/pr/changed-files.txt
          # 验签脚本只从**可信 base 侧**运行（不信 PR 改动的验签器代码）。若 base 尚无这些
          # 脚本（引入本机制的 bootstrap PR 自身），则无法在此 PR 上验签 → no-op（安全：
          # 此时 ruleset 仍 evaluate，且脚本一旦入 main，后续 image-pin PR 即走严格路径）。
          if [[ -f scripts/image-pin/verify-image-pin.sh && -f scripts/image-pin/check-pr-shape.sh ]]; then
            scripts_present=true
          else
            scripts_present=false
            echo "::notice::base 侧无 image-pin 验签脚本（bootstrap PR）→ 本 PR no-op"
          fi
          # ★★detection 泛化（信任洞闭合）：识别 cloud 路径**或** runner 路径。
          #   任一 image-lock 被改 → strict path。改 kustomization/deployment 而不改对应 image-lock
          #   的 PR 也进 strict（由 check-pr-shape 拒），防绕过。
          #   互斥：一个 image-pin PR 只 pin 一个镜像（per-image 分支），不会跨 cloud/runner 同时改。
          pin_flavor=none
          if grep -qxF "$CLOUD_LOCK_PATH" /tmp/pr/changed-files.txt \
             || grep -qxF "$CLOUD_KUST_PATH" /tmp/pr/changed-files.txt; then
            pin_flavor=cloud
          fi
          if grep -qxF "$RUNNER_LOCK_PATH" /tmp/pr/changed-files.txt \
             || grep -qxF "$RUNNER_DEPLOY_PATH" /tmp/pr/changed-files.txt \
             || grep -qxF "$RUNNER_KUST_PATH" /tmp/pr/changed-files.txt; then
            if [[ "$pin_flavor" == "cloud" ]]; then
              # 同一 PR 同时碰 cloud + runner → 非法形状（per-image 分支不应跨目录），fail-closed 进 strict
              #   由 check-pr-shape 拒。这里标 runner，让 strict path 跑起来拒它。
              echo "::warning::PR 同时改 cloud 与 runner 路径（非法 image-pin 形状）→ strict path 将拒"
            fi
            pin_flavor=runner
          fi
          if [[ "$pin_flavor" != "none" && "$scripts_present" == "true" ]]; then
            echo "touches_lock=true"  >> "$GITHUB_OUTPUT"
          else
            echo "touches_lock=false" >> "$GITHUB_OUTPUT"
          fi
          echo "pin_flavor=$pin_flavor" >> "$GITHUB_OUTPUT"
        id: changed
```

- [ ] **Step 2: strict fetch runner-path aware（`:79-96`）**

原 `Fetch PR-head image-lock as data` step（`:80-96`）：
```yaml
      - name: Fetch PR-head image-lock as data (不 checkout head 代码)
        if: steps.changed.outputs.touches_lock == 'true'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          # 只取 image-lock + kustomization 的 PR-head 版本作为**数据**；不 checkout head、不跑其脚本。
          gh api "repos/${{ github.repository }}/contents/${LOCK_PATH}?ref=${{ github.event.pull_request.head.sha }}" \
            --jq '.content' | base64 -d > /tmp/pr/head-image-lock.yaml
          echo "PR-head image-lock sha256: $(sha256sum /tmp/pr/head-image-lock.yaml | cut -d' ' -f1)"
          # Phase 3 keystone：取 head kustomization 做 digest 一致性校验（部署真相）。
          gh api "repos/${{ github.repository }}/contents/apps/aster-lang/cloud/kustomization.yaml?ref=${{ github.event.pull_request.head.sha }}" \
            --jq '.content' | base64 -d > /tmp/pr/head-kustomization.yaml
          echo "PR-head kustomization sha256: $(sha256sum /tmp/pr/head-kustomization.yaml | cut -d' ' -f1)"
          # base（可信 checkout 侧）作为 diff 基线；base 无该文件则空。
          cp "$LOCK_PATH" /tmp/pr/base-image-lock.yaml 2>/dev/null || echo 'images: []' > /tmp/pr/base-image-lock.yaml
          cp apps/aster-lang/cloud/kustomization.yaml /tmp/pr/base-kustomization.yaml
```
改为：
```yaml
      - name: Fetch PR-head 数据 (binding-mode aware，不 checkout head 代码)
        if: steps.changed.outputs.touches_lock == 'true'
        env:
          GH_TOKEN: ${{ github.token }}
          PIN_FLAVOR: ${{ steps.changed.outputs.pin_flavor }}
        run: |
          set -euo pipefail
          # ★按 pin_flavor 选 image-lock 与部署真相载体路径（cloud=kustomization / runner=deployment）。
          #   路径从可信 base 侧 env 常量取，非 PR 供值。
          if [[ "$PIN_FLAVOR" == "runner" ]]; then
            LOCK="$RUNNER_LOCK_PATH"; DEPLOY="$RUNNER_DEPLOY_PATH"
          else
            LOCK="$CLOUD_LOCK_PATH"; KUST="$CLOUD_KUST_PATH"
          fi
          # 取 head image-lock（数据）。
          gh api "repos/${{ github.repository }}/contents/${LOCK}?ref=${{ github.event.pull_request.head.sha }}" \
            --jq '.content' | base64 -d > /tmp/pr/head-image-lock.yaml
          echo "PR-head image-lock sha256: $(sha256sum /tmp/pr/head-image-lock.yaml | cut -d' ' -f1)"
          # base（可信 checkout 侧）作为 diff 基线；base 无该文件则空。
          cp "$LOCK" /tmp/pr/base-image-lock.yaml 2>/dev/null || echo 'images: []' > /tmp/pr/base-image-lock.yaml
          if [[ "$PIN_FLAVOR" == "runner" ]]; then
            # env-binding：取 head runner/deployment.yaml（数据）+ base（可信侧）做 semantic-diff。
            gh api "repos/${{ github.repository }}/contents/${DEPLOY}?ref=${{ github.event.pull_request.head.sha }}" \
              --jq '.content' | base64 -d > /tmp/pr/head-deployment.yaml
            echo "PR-head deployment sha256: $(sha256sum /tmp/pr/head-deployment.yaml | cut -d' ' -f1)"
            cp "$DEPLOY" /tmp/pr/base-deployment.yaml
          else
            # kustomization-binding：取 head cloud/kustomization.yaml（数据）+ base（可信侧）。
            gh api "repos/${{ github.repository }}/contents/${KUST}?ref=${{ github.event.pull_request.head.sha }}" \
              --jq '.content' | base64 -d > /tmp/pr/head-kustomization.yaml
            echo "PR-head kustomization sha256: $(sha256sum /tmp/pr/head-kustomization.yaml | cut -d' ' -f1)"
            cp "$KUST" /tmp/pr/base-kustomization.yaml
          fi
```

- [ ] **Step 3: check-pr-shape 调用 runner-path aware（`:98-105`）**

原 `Check PR shape` step（`:98-105`）：
```yaml
      - name: Check PR shape (blocker2 纵深)
        if: steps.changed.outputs.touches_lock == 'true'
        env:
          IMAGE_PIN_BOT_LOGIN: ${{ vars.IMAGE_PIN_BOT_LOGIN }}
          IMAGE_PIN_BOT_ID: ${{ vars.IMAGE_PIN_BOT_ID }}
        run: |
          bash scripts/image-pin/check-pr-shape.sh \
            "$GITHUB_EVENT_PATH" /tmp/pr/changed-files.txt
```
改为：
```yaml
      - name: Check PR shape (blocker2 纵深，binding-mode aware)
        if: steps.changed.outputs.touches_lock == 'true'
        env:
          IMAGE_PIN_BOT_LOGIN: ${{ vars.IMAGE_PIN_BOT_LOGIN }}
          IMAGE_PIN_BOT_ID: ${{ vars.IMAGE_PIN_BOT_ID }}
          PIN_FLAVOR: ${{ steps.changed.outputs.pin_flavor }}
        run: |
          set -euo pipefail
          # ★按 flavor 传 image-lock 与部署真相 env（路径全来自可信 base 侧 env 常量，非 PR 供值）。
          #   runner：设 DEPLOYMENT_PATH → whitelist {image-lock, deployment}；cloud：设 KUSTOMIZATION_PATH。
          if [[ "$PIN_FLAVOR" == "runner" ]]; then
            IMAGE_LOCK_PATH="$RUNNER_LOCK_PATH" \
            DEPLOYMENT_PATH="$RUNNER_DEPLOY_PATH" \
              bash scripts/image-pin/check-pr-shape.sh "$GITHUB_EVENT_PATH" /tmp/pr/changed-files.txt
          else
            IMAGE_LOCK_PATH="$CLOUD_LOCK_PATH" \
            KUSTOMIZATION_PATH="$CLOUD_KUST_PATH" \
              bash scripts/image-pin/check-pr-shape.sh "$GITHUB_EVENT_PATH" /tmp/pr/changed-files.txt
          fi
```

- [ ] **Step 4: verify-image-pin.sh 调用 runner-path aware（`:125-137`）**

原 `Verify image-lock` step（`:125-137`）：
```yaml
      - name: Verify image-lock (only changed entries; cosign + freshness)
        if: steps.changed.outputs.touches_lock == 'true'
        env:
          GH_TOKEN: ${{ github.token }}         # freshness 查源仓 HEAD，只读足够
          IMAGE_PIN_FRESHNESS: latest-only
        run: |
          # 参数 4/5 = head/base kustomization：verify 内做 digest 一致性 + semantic-diff allowlist。
          bash scripts/image-pin/verify-image-pin.sh \
            .github/image-pin/allowed-images.yaml \
            /tmp/pr/base-image-lock.yaml \
            /tmp/pr/head-image-lock.yaml \
            /tmp/pr/head-kustomization.yaml \
            /tmp/pr/base-kustomization.yaml
```
改为：
```yaml
      - name: Verify image-lock (only changed entries; cosign + freshness, binding-mode aware)
        if: steps.changed.outputs.touches_lock == 'true'
        env:
          GH_TOKEN: ${{ github.token }}         # freshness 查源仓 HEAD，只读足够
          IMAGE_PIN_FRESHNESS: latest-only
          PIN_FLAVOR: ${{ steps.changed.outputs.pin_flavor }}
        run: |
          set -euo pipefail
          # ★runner：传 head/base deployment（参数 6/7，kustomization 参数留空）；verify 内按 allowed-images
          #   的 deployBinding 对每个变更 entry 分流——env-bound 走 env value 一致性 + deployment semantic-diff，
          #   同 image-lock 里的 launcher(kustomization-bound) 会因缺 kustomization 参数而... 见下方注意。
          #   cloud：传 head/base kustomization（参数 4/5，deployment 参数不传），行为不变。
          if [[ "$PIN_FLAVOR" == "runner" ]]; then
            bash scripts/image-pin/verify-image-pin.sh \
              .github/image-pin/allowed-images.yaml \
              /tmp/pr/base-image-lock.yaml \
              /tmp/pr/head-image-lock.yaml \
              "" "" \
              /tmp/pr/head-deployment.yaml \
              /tmp/pr/base-deployment.yaml
          else
            bash scripts/image-pin/verify-image-pin.sh \
              .github/image-pin/allowed-images.yaml \
              /tmp/pr/base-image-lock.yaml \
              /tmp/pr/head-image-lock.yaml \
              /tmp/pr/head-kustomization.yaml \
              /tmp/pr/base-kustomization.yaml
          fi
```

★**注意（runner image-lock 双镜像的正确行为）：** runner PR 只 pin 一个镜像（per-image 分支，Task B3 的 runner workflow 只改 aster-replay-runner entry；launcher 用独立 workflow 改 aster-runner-launcher entry）。verify 只验**变更 entry**（`verify-image-pin.sh:105-119` base vs head diff）——runner PR 里只有 aster-replay-runner entry 变化（env-bound，走 deployment 校验），launcher entry 与 base 相同 → 跳过。故 runner strict path 不给 kustomization 参数是正确的：变更的那条恰是 env-bound。**launcher image-pin PR**（改 aster-runner-launcher entry）由 launcher workflow 开，改 `runner/kustomization.yaml`（kustomization-bound）——但当前 workflow 的 fetch 只在 `pin_flavor=runner` 时取 deployment 不取 kustomization。见下方 Step 5 补 launcher（kustomization-in-runner-dir）路径。

- [ ] **Step 5: 补 launcher（runner 目录下的 kustomization-bound）路径 —— render + runner-kust fetch**

launcher image-pin PR 改 `runner/image-lock.yaml`（aster-runner-launcher entry）+ `runner/kustomization.yaml`。其 `deployBinding=kustomization`，故 verify 需要 head/base **runner** kustomization（非 cloud，非 deployment）。上面 Step 2 的 fetch 在 `pin_flavor=runner` 分支只取了 deployment——须细化为「按**改了哪个部署载体文件**」取。修正 Step 2 的 runner 分支为同时按改动集派生：

把 Step 2 改后的 runner 分支（`if [[ "$PIN_FLAVOR" == "runner" ]]; then ... cp "$DEPLOY" ...`）替换为：
```bash
          if [[ "$PIN_FLAVOR" == "runner" ]]; then
            # runner 目录含两类 pin：aster-replay-runner(env-bound→deployment) 与
            #   aster-runner-launcher(kustomization-bound→runner/kustomization)。按 PR 实际改了哪个
            #   部署载体文件派生（都从可信 base 侧路径取，非 PR 供值）。一个 image-pin PR 只改其一。
            if grep -qxF "$RUNNER_DEPLOY_PATH" /tmp/pr/changed-files.txt; then
              gh api "repos/${{ github.repository }}/contents/${RUNNER_DEPLOY_PATH}?ref=${{ github.event.pull_request.head.sha }}" \
                --jq '.content' | base64 -d > /tmp/pr/head-deployment.yaml
              cp "$RUNNER_DEPLOY_PATH" /tmp/pr/base-deployment.yaml
              echo "runner env-bound：取 deployment 数据"
            fi
            if grep -qxF "$RUNNER_KUST_PATH" /tmp/pr/changed-files.txt; then
              gh api "repos/${{ github.repository }}/contents/${RUNNER_KUST_PATH}?ref=${{ github.event.pull_request.head.sha }}" \
                --jq '.content' | base64 -d > /tmp/pr/head-kustomization.yaml
              cp "$RUNNER_KUST_PATH" /tmp/pr/base-kustomization.yaml
              echo "runner kustomization-bound(launcher)：取 kustomization 数据"
            fi
          else
```

并把 Step 4 的 verify 调用 runner 分支改为「按存在的数据文件传参」（env-bound 传 deployment，launcher 传 kustomization）：
```bash
          if [[ "$PIN_FLAVOR" == "runner" ]]; then
            HEAD_KUST_ARG=""; BASE_KUST_ARG=""; HEAD_DEP_ARG=""; BASE_DEP_ARG=""
            [[ -f /tmp/pr/head-kustomization.yaml ]] && { HEAD_KUST_ARG=/tmp/pr/head-kustomization.yaml; BASE_KUST_ARG=/tmp/pr/base-kustomization.yaml; }
            [[ -f /tmp/pr/head-deployment.yaml ]]    && { HEAD_DEP_ARG=/tmp/pr/head-deployment.yaml;    BASE_DEP_ARG=/tmp/pr/base-deployment.yaml; }
            bash scripts/image-pin/verify-image-pin.sh \
              .github/image-pin/allowed-images.yaml \
              /tmp/pr/base-image-lock.yaml \
              /tmp/pr/head-image-lock.yaml \
              "$HEAD_KUST_ARG" "$BASE_KUST_ARG" \
              "$HEAD_DEP_ARG" "$BASE_DEP_ARG"
          else
```
（cloud 分支不变。）

★同理 check-pr-shape（Step 3）的 runner 分支：launcher PR 改 kustomization 而非 deployment，故须按改动集选。把 Step 3 runner 分支改为：
```bash
          if [[ "$PIN_FLAVOR" == "runner" ]]; then
            if grep -qxF "$RUNNER_KUST_PATH" /tmp/pr/changed-files.txt; then
              # launcher（kustomization-bound in runner dir）：whitelist {runner image-lock, runner kustomization}
              IMAGE_LOCK_PATH="$RUNNER_LOCK_PATH" \
              KUSTOMIZATION_PATH="$RUNNER_KUST_PATH" \
                bash scripts/image-pin/check-pr-shape.sh "$GITHUB_EVENT_PATH" /tmp/pr/changed-files.txt
            else
              # runner（env-bound）：whitelist {runner image-lock, runner deployment}
              IMAGE_LOCK_PATH="$RUNNER_LOCK_PATH" \
              DEPLOYMENT_PATH="$RUNNER_DEPLOY_PATH" \
                bash scripts/image-pin/check-pr-shape.sh "$GITHUB_EVENT_PATH" /tmp/pr/changed-files.txt
            fi
          else
```

- [ ] **Step 6: render 层（`:142-161`）—— runner 不做 cloud render**

原 `Verify kustomize renders by-digest` step（`:142-161`）硬编码 cloud 树渲染。runner 的 env-bound 镜像**不进任何静态 kustomize 渲染**（launcher 运行时构引用），故 runner env-bound PR 无 render 校验（其部署真相已由 env value + semantic-diff 保证）；launcher(kustomization-in-runner) PR 则应渲染 **runner** 树。改为按 flavor + 数据文件分流：

原（`:142-161`）：
```yaml
      - name: Verify kustomize renders by-digest
        if: steps.changed.outputs.touches_lock == 'true'
        run: |
          set -euo pipefail
          # 把 head 的 kustomization + image-lock 覆盖到 base 树的对应位置（仅这两个数据文件），
          # 其余 manifest 用可信 base 版本；不引入 head 的任何可执行/patch 变更。
          cp /tmp/pr/head-kustomization.yaml apps/aster-lang/cloud/kustomization.yaml
          cp /tmp/pr/head-image-lock.yaml    apps/aster-lang/cloud/image-lock.yaml
          rendered="$(kubectl kustomize apps/aster-lang/cloud)"
          # image-lock 转 JSON（数值标量转字符串防精度损坏），逐镜像取 image+digest。
          lock_json="$(yq -o=json '(.. | select(tag=="!!int" or tag=="!!float"))|=tostring' /tmp/pr/head-image-lock.yaml)"
          n="$(jq '.images | length' <<<"$lock_json")"
          for k in $(seq 0 $((n - 1))); do
            img="$(jq -r ".images[$k].image"  <<<"$lock_json")"
            dig="$(jq -r ".images[$k].digest" <<<"$lock_json")"
            # 每个镜像的渲染 image 必须是 name@sha256:<image-lock digest>。
            grep -qF "${img}@${dig}" <<<"$rendered" \
              || { echo "::error::kustomize 渲染未见 ${img}@${dig}（部署未 by-digest 该镜像）"; exit 1; }
            echo ">> 渲染校验 OK：${img}@${dig}"
          done
```
改为：
```yaml
      - name: Verify kustomize renders by-digest (binding-mode aware)
        if: steps.changed.outputs.touches_lock == 'true'
        env:
          PIN_FLAVOR: ${{ steps.changed.outputs.pin_flavor }}
        run: |
          set -euo pipefail
          # render 校验只对 kustomization-bound 镜像有意义（渲染出 name@sha256）。选目标树：
          #   cloud PR → 渲 cloud 树；runner 里的 launcher(kustomization-bound) PR → 渲 runner 树；
          #   runner env-bound PR（只改 deployment，无 head-kustomization）→ 跳过 render（env 无静态渲染，
          #   其部署真相已由 verify 的 env value + deployment semantic-diff 保证）。
          if [[ "$PIN_FLAVOR" == "runner" ]]; then
            if [[ ! -f /tmp/pr/head-kustomization.yaml ]]; then
              echo ">> runner env-bound PR（无 kustomization 变更）→ 跳过 render（env-bound 无静态渲染）"
              exit 0
            fi
            TREE=apps/aster-lang/runner
            cp /tmp/pr/head-kustomization.yaml apps/aster-lang/runner/kustomization.yaml
            cp /tmp/pr/head-image-lock.yaml    apps/aster-lang/runner/image-lock.yaml
          else
            TREE=apps/aster-lang/cloud
            cp /tmp/pr/head-kustomization.yaml apps/aster-lang/cloud/kustomization.yaml
            cp /tmp/pr/head-image-lock.yaml    apps/aster-lang/cloud/image-lock.yaml
          fi
          rendered="$(kubectl kustomize "$TREE")"
          # 只对**在 kustomization.images 里的镜像**做 render 校验（env-bound 的 runner 镜像不在其中，跳过）。
          #   image-lock 转 JSON（数值标量转字符串防精度损坏）。
          lock_json="$(yq -o=json '(.. | select(tag=="!!int" or tag=="!!float"))|=tostring' /tmp/pr/head-image-lock.yaml)"
          kust_json="$(yq -o=json '.' /tmp/pr/head-kustomization.yaml)"
          n="$(jq '.images | length' <<<"$lock_json")"
          for k in $(seq 0 $((n - 1))); do
            img="$(jq -r ".images[$k].image"  <<<"$lock_json")"
            dig="$(jq -r ".images[$k].digest" <<<"$lock_json")"
            # 该镜像若不在 kustomization.images（env-bound，如 aster-replay-runner）→ 不参与静态渲染，跳过。
            in_kust="$(jq -r --arg img "$img" '[.images[]? | select(.name == $img)] | length' <<<"$kust_json")"
            [[ "$in_kust" == "1" ]] || { echo ">> ${img} 非 kustomization-bound（不进静态渲染），跳过 render 校验"; continue; }
            grep -qF "${img}@${dig}" <<<"$rendered" \
              || { echo "::error::kustomize 渲染未见 ${img}@${dig}（部署未 by-digest 该镜像）"; exit 1; }
            echo ">> 渲染校验 OK：${img}@${dig}"
          done
```

- [ ] **Step 7: YAML 语法自检**

Run: `cd /Users/rpang/IdeaProjects/k3s && yq '.jobs.verify.steps | length' .github/workflows/verify-image-pin.yml && echo "yaml-ok"`
Expected: 一个数字（steps 数，>= 原值）+ `yaml-ok`（yq 能解析 = YAML 合法）。若 yq 报错 → 缩进/语法问题，回退修正。

- [ ] **Step 8: 归纳自检——确认 runner 路径已全链贯通**

Run（grep 确认 5 处 runner-path aware 改动都在）:
```bash
cd /Users/rpang/IdeaProjects/k3s
grep -c "RUNNER_LOCK_PATH\|RUNNER_DEPLOY_PATH\|RUNNER_KUST_PATH\|pin_flavor" .github/workflows/verify-image-pin.yml
grep -q "head-deployment.yaml" .github/workflows/verify-image-pin.yml && echo "deployment-fetch-ok"
grep -q "DEPLOYMENT_PATH=" .github/workflows/verify-image-pin.yml && echo "shape-deployment-ok"
```
Expected: 第一行 >= 8（detection env + fetch + shape + verify + render 多处引用）；`deployment-fetch-ok`；`shape-deployment-ok`。此为结构归纳门：runner detection→fetch→shape→verify→render 全链已 runner-aware。

- [ ] **Step 9: Commit（PR-A 最后一个 commit）**

```bash
cd /Users/rpang/IdeaProjects/k3s
git add .github/workflows/verify-image-pin.yml
git commit -m "fix(image-pin): verify-image-pin.yml detection 泛化识别 runner 路径（闭合信任洞：runner/launcher PR 不再 no-op UNVERIFIED 合入）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## ★ PR-A 交付门（合入 main 后才启动 PART B）

- [ ] PR-A（branch `image-pin/binding-mode-verifier`，含 Task A1-A4）本地全部测试绿：
  - `bash scripts/image-pin/verify-image-pin-envbind.test.sh` → exit 0
  - `bash scripts/image-pin/check-pr-shape-runner.test.sh` → exit 0
  - `./scripts/image-pin/verify-cip-sync.sh` → exit 0
  - `yq` 解析 workflow 无错
- [ ] Codex 深审 PR-A（禁止自审）通过。
- [ ] **PR-A 合入 k3s main。** 合入后 verifier 已能真验 runner/launcher image-pin PR（非 no-op）。
- [ ] 确认合入后，才创建 PR-B（PART B）。★这是交付顺序铁律的强制门。

---

# ══════════ PART B：aster-api open-image-pin-pr.sh（★PART A 合入 main 后）══════════

> PR-B branch 名建议：`feat/image-pin-binding-mode-script`。前置：PART A 已合入 k3s main。

## Task B1: open-image-pin-pr.sh PIN_DEPLOY_BINDING 枚举

**Files:**
- Modify: `/Users/rpang/IdeaProjects/aster-api/scripts/ci/open-image-pin-pr.sh`（加 binding-mode 枚举 + env 模式跳 kcount/不写 kustomization + 互斥）

**Interfaces:**
- Consumes: 现有 env `ENV_PATCH_PATH`/`ENV_PATCH_SELECTOR`（`:30-31`）、`LOCK_PATH`/`KUSTOMIZATION_PATH`（`:75-76`）、现有 `patch_targets()`（`:35-58`）、XOR guard（`:63-70`）。
- Produces: 新 env `PIN_DEPLOY_BINDING`（默认 `kustomization`；合法值 `kustomization|env`，非法 → exit 2）。`env` 模式：跳 kcount gate（`:113-115`）、不写 kustomization（`:44-46`）、要求 ENV_PATCH_* present、diff-check（`:127`）+ git add（`:143`）不含 KUSTOMIZATION_PATH。`kustomization` 模式：不变（默认→4 个既有镜像零改动），且拒 ENV_PATCH_* 被设（互斥）。

- [ ] **Step 1: 加 PIN_DEPLOY_BINDING 读取 + 校验值（`:30-31` 附近）**

在 `/Users/rpang/IdeaProjects/aster-api/scripts/ci/open-image-pin-pr.sh` 的 `:30-31`（ENV_PATCH_* 读取）之后加：

原（`:28-31`）：
```bash
# ── 顶部：新增可选第三写目标 env（Fork A：patch launcher Deployment 的 RUNNER_IMAGE_DIGEST env）──
# ★零改动铁律：不设 ENV_PATCH_PATH → 第三目标完全跳过，脚本行为等同现状（现有 aster-api/migrate pin 不受影响）。
ENV_PATCH_PATH="${ENV_PATCH_PATH:-}"                # 如 apps/aster-lang/runner/deployment.yaml
ENV_PATCH_SELECTOR="${ENV_PATCH_SELECTOR:-}"        # yq 选择器，选到 env 项（含 .value 子键）
```
改为：
```bash
# ── 顶部：新增可选第三写目标 env（Fork A：patch launcher Deployment 的 RUNNER_IMAGE_DIGEST env）──
# ★零改动铁律：不设 ENV_PATCH_PATH → 第三目标完全跳过，脚本行为等同现状（现有 aster-api/migrate pin 不受影响）。
ENV_PATCH_PATH="${ENV_PATCH_PATH:-}"                # 如 apps/aster-lang/runner/deployment.yaml
ENV_PATCH_SELECTOR="${ENV_PATCH_SELECTOR:-}"        # yq 选择器，选到 env 项（含 .value 子键）

# ── binding-mode 封闭枚举（full B）：选择 pin 的部署真相载体 ──
# ★零改动铁律：默认 kustomization → 现有 aster-api/migrate/launcher/cloud pin 行为不变（双写 image-lock+kustomization）。
#   kustomization：静态部署镜像——写 image-lock + kustomization（+ 可选第三 ENV_PATCH，但见下方互斥）。
#   env：运行时启动镜像（runner）——写 image-lock + ENV_PATCH（RUNNER_IMAGE_DIGEST env），**不写 kustomization**、
#        **跳 kcount gate**（runner 不在 kustomization.images）、**要求 ENV_PATCH_* present**。
PIN_DEPLOY_BINDING="${PIN_DEPLOY_BINDING:-kustomization}"
case "$PIN_DEPLOY_BINDING" in
  kustomization|env) : ;;
  *) echo "::error::PIN_DEPLOY_BINDING 非法值：${PIN_DEPLOY_BINDING}（须 kustomization|env）"; exit 2 ;;
esac
```

- [ ] **Step 2: patch_targets() 的 kustomization 写按 binding 条件化（`:44-46`）**

原 `patch_targets()` 里的 (2) kustomization 写（`:43-46`）：
```bash
  # (2) kustomization：改本镜像 digest（原 L76-78）。
  DIGEST="$digest" IMAGE="$IMAGE" yq -i '
    (.images[] | select(.name == strenv(IMAGE))).digest = strenv(DIGEST)
  ' "$KUSTOMIZATION_PATH"
```
改为：
```bash
  # (2) kustomization：改本镜像 digest（原 L76-78）。★仅 kustomization 模式写；env 模式跳过
  #     （runner 不在 kustomization.images，其部署真相是下方 ENV_PATCH 的 RUNNER_IMAGE_DIGEST env）。
  if [[ "$PIN_DEPLOY_BINDING" == "kustomization" ]]; then
    DIGEST="$digest" IMAGE="$IMAGE" yq -i '
      (.images[] | select(.name == strenv(IMAGE))).digest = strenv(DIGEST)
    ' "$KUSTOMIZATION_PATH"
  fi
```

- [ ] **Step 3: binding-mode 互斥 fail-closed（`:63-70` 现有 XOR guard 之后）**

在 `:63-70` 的成对 XOR guard 之后（`:70` 的 `fi` 后）加 binding-mode 互斥校验：

原（`:63-70`）末尾是：
```bash
if { [[ -n "$ENV_PATCH_PATH" ]] && [[ -z "$ENV_PATCH_SELECTOR" ]]; } || { [[ -z "$ENV_PATCH_PATH" ]] && [[ -n "$ENV_PATCH_SELECTOR" ]]; }; then
  echo "::error::ENV_PATCH_PATH 与 ENV_PATCH_SELECTOR 必须成对设置（同时空或同时非空）——只设其一=配置漂移，拒绝"
  exit 2
fi
```
在其后（`:70` 的 `fi` 之后、`:72` 的 `IMAGE=...` 之前）插入：
```bash

# ── binding-mode 互斥 fail-closed（full B，叠加在成对 XOR 之上）──
# env 模式：ENV_PATCH_* 必须 present（runner 的部署真相就是 RUNNER_IMAGE_DIGEST env；缺则 pin 不完整）。
# kustomization 模式：禁 ENV_PATCH_*（静态部署镜像的部署真相是 kustomization，混用 env-patch=配置漂移）。
if [[ "$PIN_DEPLOY_BINDING" == "env" ]]; then
  if [[ -z "$ENV_PATCH_PATH" || -z "$ENV_PATCH_SELECTOR" ]]; then
    echo "::error::PIN_DEPLOY_BINDING=env 但 ENV_PATCH_PATH/ENV_PATCH_SELECTOR 未成对设置——env 模式的部署真相是 RUNNER_IMAGE_DIGEST env，必须提供，拒绝"
    exit 2
  fi
else
  # kustomization 模式禁 ENV_PATCH_*（避免静态镜像误 patch 某 Deployment env）。
  if [[ -n "$ENV_PATCH_PATH" || -n "$ENV_PATCH_SELECTOR" ]]; then
    echo "::error::PIN_DEPLOY_BINDING=kustomization（默认）不得设 ENV_PATCH_*（env-patch 仅用于 PIN_DEPLOY_BINDING=env），拒绝"
    exit 2
  fi
fi
```

- [ ] **Step 4: kcount gate 按 binding 条件化（`:113-115`）**

原（`:113-115`）：
```bash
# Phase 3 keystone：kustomization 里本镜像也必须唯一存在（双写目标）。
kcount="$(IMAGE="$IMAGE" yq '.images | map(select(.name == strenv(IMAGE))) | length' "$KUSTOMIZATION_PATH")"
[[ "$kcount" == "1" ]] || { echo "::error::kustomization 中 ${IMAGE} 的 images entry 数=${kcount} (需恰好 1)"; exit 1; }
```
改为：
```bash
# Phase 3 keystone：kustomization 里本镜像也必须唯一存在（双写目标）。★仅 kustomization 模式校验；
#   env 模式跳过（runner 是 env-bound，不在 kustomization.images，kcount 必为 0——跳过是正确非绕过）。
if [[ "$PIN_DEPLOY_BINDING" == "kustomization" ]]; then
  kcount="$(IMAGE="$IMAGE" yq '.images | map(select(.name == strenv(IMAGE))) | length' "$KUSTOMIZATION_PATH")"
  [[ "$kcount" == "1" ]] || { echo "::error::kustomization 中 ${IMAGE} 的 images entry 数=${kcount} (需恰好 1)"; exit 1; }
fi
```

- [ ] **Step 5: diff-check 与 git add 按 binding 排除 kustomization（`:127`、`:143`）**

原 diff-check（`:127`）：
```bash
if git diff --quiet -- "$LOCK_PATH" "$KUSTOMIZATION_PATH" ${ENV_PATCH_PATH:+"$ENV_PATCH_PATH"}; then
```
改为：
```bash
# ★env 模式：diff-check 不含 KUSTOMIZATION_PATH（未写它，不该纳入变更判定）；含 image-lock + ENV_PATCH。
#   kustomization 模式：含 image-lock + kustomization（+ 可选 ENV_PATCH，但互斥已禁 → 恒不含）。
if [[ "$PIN_DEPLOY_BINDING" == "env" ]]; then
  DIFF_TARGETS=("$LOCK_PATH" "$ENV_PATCH_PATH")
else
  DIFF_TARGETS=("$LOCK_PATH" "$KUSTOMIZATION_PATH")
fi
if git diff --quiet -- "${DIFF_TARGETS[@]}"; then
```

原 git add（`:143-144`）：
```bash
git add "$LOCK_PATH" "$KUSTOMIZATION_PATH"
[[ -n "$ENV_PATCH_PATH" ]] && git add "$ENV_PATCH_PATH" || true
```
改为：
```bash
# ★env 模式：git add image-lock + deployment(ENV_PATCH)，不 add kustomization（未写）；
#   kustomization 模式：git add image-lock + kustomization（ENV_PATCH 互斥已禁 → 恒不 add）。
if [[ "$PIN_DEPLOY_BINDING" == "env" ]]; then
  git add "$LOCK_PATH" "$ENV_PATCH_PATH"
else
  git add "$LOCK_PATH" "$KUSTOMIZATION_PATH"
fi
```

★注意：`patch_targets()`（`:35-58`）在 env 模式下 (1) 写 image-lock、(2) 因 Step 2 条件化跳过 kustomization、(3) 因 ENV_PATCH_* present 写 deployment env——三步与 diff/add 目标一致。`:110-111` 的 image-lock count==1 gate 对两模式都保留（runner/launcher image-lock 都有唯一 entry，正确）。

- [ ] **Step 6: Commit（实现，测试在 Task B2）**

```bash
cd /Users/rpang/IdeaProjects/aster-api
git add scripts/ci/open-image-pin-pr.sh
git commit -m "feat(image-pin): open-image-pin-pr.sh PIN_DEPLOY_BINDING 枚举（env 模式跳 kcount/不写 kustomization/要求 ENV_PATCH，默认 kustomization 零改动）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task B2: 扩展 bats 回归测试（保 Test 1 零改动 + env 模式 + 互斥）

**Files:**
- Modify: `/Users/rpang/IdeaProjects/aster-api/scripts/ci/open-image-pin-pr-thirdtarget.bats`（保 Test 1-4，新增 Test 5-8）

**Interfaces:**
- Consumes: Task B1 的 `PIN_DEPLOY_BINDING` env、`patch_targets()`、主流程互斥。
- Produces: 新测试——env 模式（kcount 不跑 / kustomization 不写 / image-lock+deployment 都写）、非法 binding 值 exit 2、kustomization 模式 + ENV_PATCH → exit 2、env 模式缺 ENV_PATCH → exit 2。★沿用文件既有纯 bash 断言风格（非真 bats），`assert_eq`/子壳 source `--source-only`。

★**重要——Test 1 零改动铁律：** 现有 Test 1（`:60-92`）调 `patch_targets` **不设 PIN_DEPLOY_BINDING**（默认 kustomization），断言 image-lock+kustomization 写、deployment 字节不变。B1 的默认路径必须让此测试**继续绿**（零改动铁律的守门）。**不改 Test 1。**

- [ ] **Step 1: 写新测试函数（Test 5-8）追加到文件末尾（`:159` 的 `echo ""` 之前）**

在 `/Users/rpang/IdeaProjects/aster-api/scripts/ci/open-image-pin-pr-thirdtarget.bats` 的 Test 4 之后（`:159` 前）插入：

```bash

echo ""
echo "=== Test 5: PIN_DEPLOY_BINDING=env → patch_targets 写 image-lock + deployment env，不写 kustomization ==="
TMP5="$(mktemp -d)"
setup_fixture "$TMP5"
KUST5_BEFORE="$(shasum -a 256 "$TMP5/kustomization.yaml" | awk '{print $1}')"
DIGEST_5="sha256:$(printf 'd%.0s' $(seq 1 64))"
(
  source "$TARGET_SCRIPT" --source-only
  PIN_DEPLOY_BINDING=env \
  LOCK_PATH="$TMP5/image-lock.yaml" KUSTOMIZATION_PATH="$TMP5/kustomization.yaml" \
    IMAGE="docker.io/wontlost/aster-replay-runner" \
    ENV_PATCH_PATH="$TMP5/deployment.yaml" \
    ENV_PATCH_SELECTOR='.spec.template.spec.containers[0].env[] | select(.name == "RUNNER_IMAGE_DIGEST")' \
    patch_targets "$DIGEST_5" "seed-sha" "500"
)
actual_lock_5="$(yq '.images[0].digest' "$TMP5/image-lock.yaml")"
assert_eq "env 模式：image-lock digest 已写" "$DIGEST_5" "$actual_lock_5"
actual_dep_5="$(yq '.spec.template.spec.containers[0].env[] | select(.name == "RUNNER_IMAGE_DIGEST") | .value' "$TMP5/deployment.yaml")"
assert_eq "env 模式：deployment RUNNER_IMAGE_DIGEST env 已写" "$DIGEST_5" "$actual_dep_5"
KUST5_AFTER="$(shasum -a 256 "$TMP5/kustomization.yaml" | awk '{print $1}')"
assert_eq "env 模式：kustomization 字节级零改动（未写）" "$KUST5_BEFORE" "$KUST5_AFTER"
rm -rf "$TMP5"

echo ""
echo "=== Test 6: PIN_DEPLOY_BINDING 非法值 → exit 2 ==="
DUMMY_DIGEST6="sha256:$(printf '0%.0s' {1..64})"
code6=0
PIN_DEPLOY_BINDING=bogus \
  GH_TOKEN="x" DIGEST="$DUMMY_DIGEST6" SOURCE_SHA="x" RUN_ID="0" \
  bash "$TARGET_SCRIPT" docker.io/wontlost/foo image-pin/foo >/dev/null 2>&1 || code6=$?
assert_eq "非法 PIN_DEPLOY_BINDING → exit 2" "2" "$code6"

echo ""
echo "=== Test 7: PIN_DEPLOY_BINDING=kustomization（默认）+ 设 ENV_PATCH_* → 互斥 exit 2 ==="
DUMMY_DIGEST7="sha256:$(printf '0%.0s' {1..64})"
code7=0
PIN_DEPLOY_BINDING=kustomization \
  ENV_PATCH_PATH="/tmp/whatever.yaml" \
  ENV_PATCH_SELECTOR='.spec.template.spec.containers[0].env[] | select(.name == "X")' \
  GH_TOKEN="x" DIGEST="$DUMMY_DIGEST7" SOURCE_SHA="x" RUN_ID="0" \
  bash "$TARGET_SCRIPT" docker.io/wontlost/foo image-pin/foo >/dev/null 2>&1 || code7=$?
assert_eq "kustomization 模式设 ENV_PATCH → 互斥 exit 2" "2" "$code7"

echo ""
echo "=== Test 8: PIN_DEPLOY_BINDING=env 但缺 ENV_PATCH_* → exit 2（env 模式必须提供部署真相）==="
DUMMY_DIGEST8="sha256:$(printf '0%.0s' {1..64})"
code8=0
PIN_DEPLOY_BINDING=env \
  GH_TOKEN="x" DIGEST="$DUMMY_DIGEST8" SOURCE_SHA="x" RUN_ID="0" \
  bash "$TARGET_SCRIPT" docker.io/wontlost/foo image-pin/foo >/dev/null 2>&1 || code8=$?
assert_eq "env 模式缺 ENV_PATCH → exit 2" "2" "$code8"
```

★注意：Test 6/7/8 走**主流程**（`bash "$TARGET_SCRIPT" ...` 非 source），互斥/枚举校验在 clone/写入之前（Step 1/3 的位置都在 `:72` 的 `IMAGE=...` 之前、clone `:103` 之前），故不触网，纯粹校验 exit 2。Test 8 的 env 模式互斥校验也在 clone 前，安全。

- [ ] **Step 2: 更新文件末尾成功文案（`:161-162`）**

原（`:161-162`）：
```bash
if [[ "$FAILED" == "0" ]]; then
  echo "全部通过（零改动回归 + 第三目标激活 + fail-closed 校验 + XOR 成对校验）。"
```
改为：
```bash
if [[ "$FAILED" == "0" ]]; then
  echo "全部通过（零改动回归 + 第三目标激活 + fail-closed 校验 + XOR 成对校验 + binding-mode env/枚举/互斥）。"
```

- [ ] **Step 3: 跑全套回归确认绿（含旧 Test 1 零改动 + 新 Test 5-8）**

Run: `cd /Users/rpang/IdeaProjects/aster-api && bash scripts/ci/open-image-pin-pr-thirdtarget.bats; echo "exit=$?"`
Expected: 所有用例 `✓`（Test 1-8），末行 `全部通过（... binding-mode env/枚举/互斥）。` + `exit=0`。★特别确认 Test 1 的 `deployment.yaml 字节级零改动` 与新 Test 5 的 `kustomization 字节级零改动（未写）` 都 `✓`——两个方向的零改动铁律都守住。

- [ ] **Step 4: Commit**

```bash
cd /Users/rpang/IdeaProjects/aster-api
git add scripts/ci/open-image-pin-pr-thirdtarget.bats
git commit -m "test(image-pin): 扩 open-image-pin-pr 回归覆盖 binding-mode（env 写路径 + 枚举/互斥 fail-closed，保 Test1 零改动）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task B3: runner workflow 设 PIN_DEPLOY_BINDING=env

**Files:**
- Modify: `/Users/rpang/IdeaProjects/aster-api/.github/workflows/aster-replay-runner-deploy.yml:257-274`（image-pin-pr step env 加 `PIN_DEPLOY_BINDING: env`）

**Interfaces:**
- Consumes: Task B1 的 `PIN_DEPLOY_BINDING` env。
- Produces: runner deploy workflow 用 env 模式跑 image-pin（写 image-lock + RUNNER_IMAGE_DIGEST env，不写/不要求 runner kustomization 有 runner 条）。★launcher workflow（`aster-runner-launcher-deploy.yml`）**不设** PIN_DEPLOY_BINDING → 默认 kustomization（launcher 在 runner/kustomization 有条，正确）。

- [ ] **Step 1: 加 PIN_DEPLOY_BINDING: env 到 runner image-pin step 的 env 段**

在 `/Users/rpang/IdeaProjects/aster-api/.github/workflows/aster-replay-runner-deploy.yml` 的 `Open/update image-pin PR to k3s` step env 段（`:259-271`）加一行。

原（`:259-271`）：
```yaml
        env:
          GH_TOKEN: ${{ steps.apptoken.outputs.token }}
          DIGEST: ${{ needs.build.outputs.digest }}
          SOURCE_SHA: ${{ github.sha }}
          RUN_ID: ${{ github.run_id }}
          # ★LOCK_PATH/KUSTOMIZATION_PATH 指 runner 目录（runner 镜像的 pin 落 runner-ns，Fork A）。
          #   目录名是短名 runner（ApplicationSet 加 aster- 前缀派生 ns=aster-runner）。
          LOCK_PATH: apps/aster-lang/runner/image-lock.yaml
          KUSTOMIZATION_PATH: apps/aster-lang/runner/kustomization.yaml
          # ★Fork A 第三写目标：把 runner digest 同步 patch 进 launcher Deployment 的 RUNNER_IMAGE_DIGEST env。
          #   launcher 读此 env 构 runner 镜像引用——故 runner pin 一次同时更新 image-lock/kustomization/launcher-env。
          ENV_PATCH_PATH: apps/aster-lang/runner/deployment.yaml
          ENV_PATCH_SELECTOR: '.spec.template.spec.containers[0].env[] | select(.name == "RUNNER_IMAGE_DIGEST")'
```
改为：
```yaml
        env:
          GH_TOKEN: ${{ steps.apptoken.outputs.token }}
          DIGEST: ${{ needs.build.outputs.digest }}
          SOURCE_SHA: ${{ github.sha }}
          RUN_ID: ${{ github.run_id }}
          # ★full B：runner 是 env-bound 部署镜像（launcher 运行时经 RUNNER_IMAGE_DIGEST env 注入，
          #   不在 kustomization.images）。故 binding=env：脚本跳 kcount gate + 不写 kustomization +
          #   写 image-lock + patch RUNNER_IMAGE_DIGEST env（ENV_PATCH_* 必需）。
          PIN_DEPLOY_BINDING: env
          # ★LOCK_PATH 指 runner 目录（runner 镜像的 pin 落 runner-ns，Fork A）。
          #   目录名是短名 runner（ApplicationSet 加 aster- 前缀派生 ns=aster-runner）。
          LOCK_PATH: apps/aster-lang/runner/image-lock.yaml
          # ★env 模式不写 kustomization（runner 不在 runner/kustomization.images）；KUSTOMIZATION_PATH
          #   保留仅为脚本默认值兜底（env 模式脚本不读它做写入/kcount），实际写入靠下方 ENV_PATCH。
          KUSTOMIZATION_PATH: apps/aster-lang/runner/kustomization.yaml
          # ★Fork A 部署真相：把 runner digest patch 进 launcher Deployment 的 RUNNER_IMAGE_DIGEST env。
          #   launcher 读此 env 构 runner 镜像引用——env 模式下这是 runner 的唯一部署真相载体。
          ENV_PATCH_PATH: apps/aster-lang/runner/deployment.yaml
          ENV_PATCH_SELECTOR: '.spec.template.spec.containers[0].env[] | select(.name == "RUNNER_IMAGE_DIGEST")'
```

- [ ] **Step 2: YAML 语法自检**

Run: `cd /Users/rpang/IdeaProjects/aster-api && yq '.jobs.image-pin-pr.steps[] | select(.name == "Open/update image-pin PR to k3s") | .env.PIN_DEPLOY_BINDING' .github/workflows/aster-replay-runner-deploy.yml`
Expected: `env`（PIN_DEPLOY_BINDING 已加且值为 env，YAML 合法）。

- [ ] **Step 3: 确认 launcher workflow 未设（默认 kustomization）**

Run: `cd /Users/rpang/IdeaProjects/aster-api && yq '.jobs.image-pin-pr.steps[] | select(.name == "Open/update image-pin PR to k3s") | .env.PIN_DEPLOY_BINDING // "UNSET"' .github/workflows/aster-runner-launcher-deploy.yml 2>/dev/null || echo "step-name-differs"`
Expected: `UNSET`（launcher workflow 不设 PIN_DEPLOY_BINDING → 脚本默认 kustomization → launcher 走 kustomization 写路径，行为不变）。★若输出 `step-name-differs` 或 null，去 `aster-runner-launcher-deploy.yml:149-162` 人工确认该 workflow 的 image-pin step **未设** PIN_DEPLOY_BINDING。

- [ ] **Step 4: Commit（PR-B 最后一个 commit）**

```bash
cd /Users/rpang/IdeaProjects/aster-api
git add .github/workflows/aster-replay-runner-deploy.yml
git commit -m "feat(image-pin): runner deploy workflow 设 PIN_DEPLOY_BINDING=env（runner 是 env-bound，pin 落 RUNNER_IMAGE_DIGEST env）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## ★ PR-B 交付门

- [ ] PR-B（branch `feat/image-pin-binding-mode-script`，含 Task B1-B3）本地测试绿：
  - `bash scripts/ci/open-image-pin-pr-thirdtarget.bats` → exit 0（Test 1-8 全 ✓）
  - `yq` 解析两 workflow 无错
- [ ] Codex 深审 PR-B（禁止自审）通过。
- [ ] **PR-B 合入 aster-api main。** 合入后 runner deploy workflow 下次 main push 会用 env 模式开真 runner image-pin PR，被已泛化的 k3s verifier 真验（非 no-op）。

---

# ══════════ PART C：#102 back-verify（运维步骤，无代码）══════════

## Task C1: #102 launcher back-verify（补验信任洞的 acceptance 闭合）

**Files:** 无代码改动。本 Task 是文档化的带外运维步骤（subagent 不执行，写入交付说明）。

**★背景：** launcher image-pin #102 曾走 verifier 的 no-op 路径合入——launcher digest 是 pinned 但**未经可信 verifier 验证**（无 cosign/freshness/shape/digest 一致性）。★澄清：launcher 是 **kustomization-bound**（它在 `runner/kustomization.yaml:images` 有条），当时被 verifier 漏检**不是**因为它是 env-bound，而是因为 detection 的 `touches_pin` grep 只认 cloud 路径、漏了整个 `runner/` 目录（Task A4 已修）。故本 Task 不回滚 #102，只**重新触发** launcher deploy 让泛化后的 verifier 做它当时跳过的真验证。

**Interfaces:**
- Consumes: PART A（verifier 已识别 runner 路径 + launcher 走 runner-dir kustomization strict path）+ PART B（已合入，但 launcher workflow 用默认 kustomization 模式，无需 B 的 env 改动——launcher back-verify 只依赖 A）。
- Produces: launcher image-pin PR 走 strict path（cosign + freshness + shape + kustomization digest 一致性），把 #102 跳过的验证补上。

- [ ] **Step 1（运维）：确认 PART A 已合入 k3s main**

前置门：verify-image-pin.yml 已含 Task A4 的 runner 路径 detection（`grep -q "RUNNER_LOCK_PATH" .github/workflows/verify-image-pin.yml` 在 main 有命中）。

- [ ] **Step 2（运维）：重新触发 aster-runner-launcher-deploy.yml**

两种等价方式（任一）：
- (a) 对 `aster-cloud/aster-api` main 打一个空提交（`git commit --allow-empty -m "chore(ops): 重触 launcher deploy 让泛化 verifier 补验 #102"` → push main），触发 `aster-runner-launcher-deploy.yml` 全链（build→sign→parity→image-pin-pr）；或
- (b) 在 GitHub Actions UI re-run 最近一次 `aster-runner-launcher-deploy.yml` 的 `image-pin-pr` job（若该 workflow 支持 re-run；注意 workflow 无 `workflow_dispatch`，故 re-run 已有 run 更稳妥）。

★launcher digest 若未变（同 `sha256:36aa07f1...`），image-pin 脚本幂等（同 digest 重开/复用 PR 无害，`open-image-pin-pr.sh:127-139` 的无变更分支）。关键是**这次开的 launcher image-pin PR 会被泛化后的 verifier 走 strict path**（detection 认 `runner/image-lock.yaml` → `pin_flavor=runner` → 改的是 aster-runner-launcher entry + `runner/kustomization.yaml` → Task A4 Step 5 的 kustomization 分支 → cosign + freshness + kustomization digest 一致性 + render 校验）。

- [ ] **Step 3（运维）：确认 launcher image-pin PR 上 verify-image-pin check = 真 success（非 no-op）**

在 launcher image-pin PR 的 checks 里，`verify-image-pin` check-run 的 summary 应含 `touches_lock=true`（非 no-op）+ job 日志有 `cosign verify OK` + `freshness OK` + `kustomization 一致性 OK` + `渲染校验 OK`。★这是信任洞 acceptance 闭合的证据：#102 当时跳过的 4 项验证现在真跑了。

- [ ] **Step 4（运维）：若 back-verify 失败（freshness/cosign 不过）的处置**

若 launcher digest 的 sourceSha 已非源仓 main HEAD（freshness fail）→ 说明 #102 pin 的是过时 digest。处置：让 launcher deploy 全链重跑产**新** digest（build 出新 arm64 digest + 新 sourceSha=当前 HEAD）→ image-pin PR 写新 digest → strict path 全过。这不是回滚 #102，是用一个**经真验证的新 pin** 覆盖它（承设计「补验非回滚」）。

---

## 交付与验证总览

- **两个 PR，严格顺序：** PR-A（k3s，Task A1-A4）**先合入 main** → PR-B（aster-api，Task B1-B3）**后合入 main**。反序有未验证窗口（脚本能开 runner PR 但 verifier no-op），铁律不可协商。
- **可本地自动验证（subagent 跑）：**
  - A1: `verify-cip-sync.sh` exit 0（deployBinding 不破 2N 契约）+ yq deployBinding 齐全。
  - A2: `verify-image-pin-envbind.test.sh` exit 0（env value 一致性 + semantic-diff + fail-closed）+ kustomization smoke。
  - A3: `check-pr-shape-runner.test.sh` exit 0（runner env-shape）+ cloud 形状回归。
  - A4: `yq` 解析 workflow + grep 归纳门（runner 路径全链贯通）。
  - B1/B2: `open-image-pin-pr-thirdtarget.bats` exit 0（Test 1-8，两方向零改动铁律 + env/枚举/互斥）。
  - B3: `yq` 断言 runner workflow 有 `PIN_DEPLOY_BINDING: env`、launcher workflow UNSET。
- **无法本地端到端（诚实边界）：** workflow 的真 PR 事件 + cosign + gh api 只能在合入后由真 CI 跑（Task A4 用结构自检 + 归纳法覆盖）；Task C1 是带外运维（需真 CI/集群 + 人工）。
- **合入后闭环：** PR-A 合 → PR-B 合 → runner deploy 下次 push 用 env 模式开真 runner image-pin PR（env value + deployment semantic-diff 验）→ Task C1 back-verify launcher（补 #102 跳过的验证）。信任洞闭合。

## 交叉审查（禁止自审）

Claude 生成 → Codex 深审。每 Task 独立审。重点：
1. **binding-mode 互斥是否 fail-closed 无绕过**（B1 Step 3：env 缺 ENV_PATCH → exit 2 / kustomization 设 ENV_PATCH → exit 2 / 非法值 → exit 2）。
2. **env 模式零改动铁律**（B2 Test 1 deployment 字节不变 + Test 5 kustomization 字节不变——两方向）。
3. **verifier selector 硬编码 base 侧防篡改**（A2：`ENV_BIND_SELECTOR` 常量在脚本内，不从参数/PR 取；workflow 只传文件路径不传 selector）。
4. **deployment semantic-diff allowlist 只许 env value 变防夹带**（A2 Test 3：replicas 0→9 被拦）。
5. **detection 泛化不漏 runner 也不误判 cloud**（A4：cloud PR 仍 `pin_flavor=cloud` 走原路径；runner PR `pin_flavor=runner`；同碰两目录 → strict 拒）。
6. **runner image-lock 双镜像的正确分流**（A4 Step 4-5：runner env-bound PR 只改 aster-replay-runner entry 走 deployment 校验；launcher PR 改 aster-runner-launcher entry 走 runner-dir kustomization 校验；verify 只验变更 entry，不会误卡未变的另一条）。
7. **PR-A/PR-B 顺序保证无未验证窗口**（Global Constraints + 两交付门）。
8. **`deployBinding` 缺省默认 kustomization 的 fail-safe**（A2：`.deployBinding // "kustomization"`——即便某 entry 漏字段也不误走 env 分支跳 kustomization 校验；A1 已显式给全 4 条，缺省只是双保险）。
