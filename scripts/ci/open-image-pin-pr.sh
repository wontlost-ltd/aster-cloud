#!/usr/bin/env bash
# open-image-pin-pr —— 源仓 CI 用：开/更新 image-pin PR 到 k3s（统一 digest pin A′ Phase 2）
#
# 见 wontlost-ltd/k3s#4。Codex 对抗式审查修正（81→）：token 用 extraheader 不进 .git/config；
# force-with-lease 用远端实际 SHA 作 lease 基线；gh pr list --state open 判存在；无 diff+无 open
# PR 时干净退出；校验目标 entry 唯一存在。
#
# 用法：open-image-pin-pr.sh <IMAGE> <BRANCH>
#   IMAGE  = 如 docker.io/wontlost/aster-api（必须在 k3s image-lock 里唯一存在）
#   BRANCH = 固定分支名，如 image-pin/aster-api
# 环境变量（必需）：
#   GH_TOKEN     k3s-scoped installation token（contents+PR write，checks read）
#   DIGEST       本次已验签 manifest-list digest（sha256:...）
#   SOURCE_SHA   github.sha
#   RUN_ID       github.run_id
# 环境变量（可选）：
#   K3S_REPO     默认 wontlost-ltd/k3s
#   LOCK_PATH    默认 apps/aster-lang/cloud/image-lock.yaml
#   YQ_VERSION   默认 v4.44.3
#   YQ_SHA256    yq_linux_amd64 的 sha256（提供则校验；强烈建议在 workflow 传入）
#   VERIFY_TIMEOUT_SECONDS / VERIFY_POLL_SECONDS  等待 verify-image-pin 的超时与轮询间隔
# GH_TOKEN 需额外具备 checks:read（读取 verify-image-pin 结果）。
set -euo pipefail

# ── 合并门控：等 k3s 的 verify-image-pin 在本 head 上通过，再直接合并 ──
# ★为什么不用 `gh pr merge --auto`：k3s 是私有仓，规则集需要 GitHub Pro 才生效，传统分支
#   保护也未开启，所以 main 上**没有任何必需检查**。没有保护规则时 GitHub 拒绝开启自动合并
#   （GraphQL: Protected branch rules not configured for this branch）；gh 读到 PR 恰好已是
#   CLEAN 时又会直接合并——于是 pin PR 要么报错挂起（issue #506），要么在 verify-image-pin
#   跑完之前就被合并（cosign 验签沦为事后检查）。这里由脚本自己等验签通过再合并。
# 只认 image-pin App 发出的同名检查（防止其它来源的同名 check 冒充通过）。
VERIFY_CHECK_NAME="${VERIFY_CHECK_NAME:-verify-image-pin}"
VERIFY_APP_ID="${VERIFY_APP_ID:-4253193}"
VERIFY_TIMEOUT_SECONDS="${VERIFY_TIMEOUT_SECONDS:-600}"
VERIFY_POLL_SECONDS="${VERIFY_POLL_SECONDS:-15}"

# 输出 "<status> <conclusion>"；该 head 上尚无此检查时输出 "missing -"。
verify_check_state() {
  local sha="$1"
  gh api "repos/${K3S_REPO}/commits/${sha}/check-runs?check_name=${VERIFY_CHECK_NAME}&per_page=100" \
    --jq "[.check_runs[] | select(.app.id == ${VERIFY_APP_ID})] | sort_by(.started_at) | last
          | if . == null then \"missing -\" else \"\(.status) \(.conclusion // \"-\")\" end"
}

# 轮询至通过（返回 0）、失败或超时（返回 1，fail-loud）。
wait_for_verification() {
  local sha="$1" state deadline
  deadline=$(( $(date +%s) + VERIFY_TIMEOUT_SECONDS ))
  while :; do
    state="$(verify_check_state "$sha" 2>/dev/null)" || state="error -"
    case "$state" in
      "completed success") echo "${VERIFY_CHECK_NAME} 在 ${sha} 上通过"; return 0 ;;
      completed\ *) echo "::error::${VERIFY_CHECK_NAME} 在 ${sha} 上未通过（${state}）→ 不合并"; return 1 ;;
    esac
    if (( $(date +%s) >= deadline )); then
      echo "::error::等待 ${VERIFY_CHECK_NAME} 超时（${VERIFY_TIMEOUT_SECONDS}s，最后状态：${state}）→ 不合并"
      return 1
    fi
    sleep "$VERIFY_POLL_SECONDS"
  done
}

# 验签通过后按本 run 锁定的 head 直接合并；head 被他人改动时 --match-head-commit 拒绝合并。
merge_when_verified() {
  local pr="$1" sha="$2"
  wait_for_verification "$sha" || return 1
  gh pr merge "$pr" -R "$K3S_REPO" --squash --delete-branch --match-head-commit "$sha"
}

# 测试入口：只加载上面的函数，不执行 clone/push。
if [[ "${1:-}" == "--source-only" ]]; then return 0 2>/dev/null || exit 0; fi


IMAGE="${1:?usage: open-image-pin-pr.sh <IMAGE> <BRANCH>}"
BRANCH="${2:?usage: open-image-pin-pr.sh <IMAGE> <BRANCH>}"
K3S_REPO="${K3S_REPO:-wontlost-ltd/k3s}"
LOCK_PATH="${LOCK_PATH:-apps/aster-lang/cloud/image-lock.yaml}"
KUSTOMIZATION_PATH="${KUSTOMIZATION_PATH:-apps/aster-lang/cloud/kustomization.yaml}"
YQ_VERSION="${YQ_VERSION:-v4.44.3}"

: "${GH_TOKEN:?需要 GH_TOKEN（k3s-scoped token）}"
: "${DIGEST:?需要 DIGEST}"
: "${SOURCE_SHA:?需要 SOURCE_SHA}"
: "${RUN_ID:?需要 RUN_ID}"
[[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "::error::DIGEST 形状非法：$DIGEST"; exit 1; }

# 向 CI 输出「本次是否需要等待迁移应用 + 具体 PR number」（Codex 审查必修:下游 Wait step
# 按本次明确的 pr_number 等待,不从历史 --state all 反推）。本地无 GITHUB_OUTPUT 时 no-op。
emit() { [[ -n "${GITHUB_OUTPUT:-}" ]] && printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT" || true; }

# ── 安装 yq（可选 checksum 校验）──
if ! command -v yq >/dev/null; then
  curl -fsSL -o /tmp/yq "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_amd64"
  if [[ -n "${YQ_SHA256:-}" ]]; then
    echo "${YQ_SHA256}  /tmp/yq" | sha256sum -c - || { echo "::error::yq checksum 校验失败"; exit 1; }
  fi
  sudo install -m 0755 /tmp/yq /usr/local/bin/yq
fi

# ── clone k3s：token 走 extraheader，不写进 remote URL（不落 .git/config）──
# ★ GitHub App installation token（ghs_*）over git HTTPS 用 **basic** auth（base64
#   x-access-token:TOKEN），非 bearer——bearer 不被 github.com git 端点接受，会退化成
#   提示 Username 而在 CI 失败（实测 fatal: could not read Username）。对齐 actions/checkout。
AUTH="AUTHORIZATION: basic $(printf 'x-access-token:%s' "${GH_TOKEN}" | base64 | tr -d '\n')"
git -c "http.https://github.com/.extraheader=${AUTH}" \
  clone --depth=1 "https://github.com/${K3S_REPO}.git" k3s
cd k3s
# 后续所有 remote 操作都带 extraheader，保持 token 不落盘。
git_c() { git -c "http.https://github.com/.extraheader=${AUTH}" "$@"; }

# ── 校验目标 entry 在 image-lock 中唯一存在 ──
count="$(IMAGE="$IMAGE" yq '.images | map(select(.image == strenv(IMAGE))) | length' "$LOCK_PATH")"
[[ "$count" == "1" ]] || { echo "::error::image-lock 中 ${IMAGE} 的 entry 数=${count} (需恰好 1)"; exit 1; }

# Phase 3 keystone：kustomization 里本镜像也必须唯一存在（双写目标）。
kcount="$(IMAGE="$IMAGE" yq '.images | map(select(.name == strenv(IMAGE))) | length' "$KUSTOMIZATION_PATH")"
[[ "$kcount" == "1" ]] || { echo "::error::kustomization 中 ${IMAGE} 的 images entry 数=${kcount} (需恰好 1)"; exit 1; }

# ── 从最新 origin/main 重建固定分支，双写本 entry（image-lock 验签真相 + kustomization 部署真相）──
git checkout -B "$BRANCH" origin/main
DIGEST="$DIGEST" SOURCE_SHA="$SOURCE_SHA" RUN_ID="$RUN_ID" IMAGE="$IMAGE" yq -i '
  (.images[] | select(.image == strenv(IMAGE))).digest    = strenv(DIGEST)  |
  (.images[] | select(.image == strenv(IMAGE))).sourceSha = strenv(SOURCE_SHA) |
  (.images[] | select(.image == strenv(IMAGE))).runId     = strenv(RUN_ID)
' "$LOCK_PATH"
# kustomization：只改本镜像的 digest（部署真相），k3s verify 校验 == image-lock digest。
DIGEST="$DIGEST" IMAGE="$IMAGE" yq -i '
  (.images[] | select(.name == strenv(IMAGE))).digest = strenv(DIGEST)
' "$KUSTOMIZATION_PATH"

open_pr_number() {
  gh pr list -R "$K3S_REPO" --head "$BRANCH" --base main --state open \
    --json number --jq '.[0].number // empty'
}

if git diff --quiet -- "$LOCK_PATH" "$KUSTOMIZATION_PATH"; then
  # 无变更：main 已是本 digest。若恰有 open PR 则确保 auto-merge,否则干净退出（不 create）。
  pr="$(open_pr_number)"
  if [[ -n "$pr" ]]; then
    echo "image-lock 已最新,复用 open PR #$pr，等验签通过后合并"
    open_head="$(gh pr view "$pr" -R "$K3S_REPO" --json headRefOid --jq .headRefOid)"
    merge_when_verified "$pr" "$open_head"
    emit wait_required true; emit pr_number "$pr"
  else
    echo "image-lock 已最新且无 open PR → 无需开 PR,退出"
    emit wait_required false; emit pr_number ""
  fi
  exit 0
fi

git config user.name  "aster-image-pin[bot]"
git config user.email "301590099+aster-image-pin[bot]@users.noreply.github.com"
git add "$LOCK_PATH" "$KUSTOMIZATION_PATH"
git commit -m "chore(image-pin): ${IMAGE##*/} → ${DIGEST} (sha ${SOURCE_SHA})"

# ── force-with-lease 用远端实际 SHA 作基线（防同 App 并发 run 互相覆盖）──
remote_sha="$(git_c ls-remote --heads origin "$BRANCH" | cut -f1 || true)"
if [[ -n "$remote_sha" ]]; then
  git_c push --force-with-lease="${BRANCH}:${remote_sha}" origin "$BRANCH"
else
  git_c push origin "$BRANCH"
fi

# ── 只查 open PR 决定复用/创建；create/merge 用 --match-head-commit 锁定本 run 的 head ──
head_sha="$(git rev-parse HEAD)"
pr_body=$'自动开启（源仓 CI）。\n\nimage: '"${IMAGE}"$'\ndigest: '"${DIGEST}"$'\nsourceSha: '"${SOURCE_SHA}"$'\nrunId: '"${RUN_ID}"$'\n\n本 PR 由源仓 CI 在 verify-image-pin 通过后合并。stale/红：等待最新源仓 CI 重开，或对 latest main 手动 rerun（不允许旧 SHA 绕过 freshness）。'
pr="$(open_pr_number)"
if [[ -z "$pr" ]]; then
  # ★ 不在 create 时带 --label（label 缺失会让 create 整体失败，实测 could not add label）。
  #   先建 PR，再单独加 label（非致命：label 是 ruleset auto-merge 门控之一，缺则由人工/后续补）。
  gh pr create -R "$K3S_REPO" --base main --head "$BRANCH" \
    --title "chore(image-pin): ${IMAGE##*/} digest bump" \
    --body "$pr_body"
  pr="$(open_pr_number)"
  gh pr edit "$pr" -R "$K3S_REPO" --add-label image-pin \
    || echo "::warning::加 image-pin label 失败（label 是否存在？）——PR 已建，label 需人工补"
else
  echo "复用 open PR #$pr"
  # 复用时同步描述：否则 digest/sourceSha 停在第一次创建时的值，与分支内容不符。
  gh pr edit "$pr" -R "$K3S_REPO" --body "$pr_body" \
    || echo "::warning::更新 PR #$pr 描述失败（不影响合并门控）"
fi
# 验签未通过或超时必须 fail-loud（PR 开着不合＝发布链断）。
merge_when_verified "$pr" "$head_sha"
echo "image-pin PR #${pr} 已在 ${VERIFY_CHECK_NAME} 通过后合并 (head=${head_sha})"
# 本次确有 digest 变更 + 开/复用了 PR → 下游必须等待迁移应用。
emit wait_required true; emit pr_number "$pr"
