#!/usr/bin/env bash
# verify-worker-deployment —— Deploy Worker workflow 用：核实本次 `wrangler deploy` 确实成为线上生效的部署（issue #836）。
#
# ★按身份判定，不比时间戳：
#   旧实现比较「最新部署的 Created」与「job 开始时间」，并解析 `wrangler deployments list` 的文本输出。
#   两次误报都源于 Cloudflare 部署 API 的读后写延迟（verify 紧跟 deploy，相隔不到 1 秒）：
#     - 6561896（run 44516573898）：列表已含新部署，但文本模式还要逐个拉 version 详情，
#       新 version ca8e7cf1 尚未可读 → API 100146 → 无 Created 可解析；
#     - c7f510e4（run 44647104899）：列表尚未出现新部署（最新仍是上一次 run 的 23:15）→ 判为「未晚于 job 开始」。
#   现改为：`--json` 只调一次 deployments 接口（不拉 version 详情），按 created_on 排序取最新一条，
#   要求它同时满足 message == github-actions-run-${DEPLOY_RUN_ID}（精确匹配）且
#   100% 流量指向 `wrangler deploy` 打印的 Current Version ID。暂不可见 / API 出错时指数退避重试。
#
# fail-closed：
#   - 重试耗尽仍看不到本次部署 → 失败；
#   - 本次部署在列表里但已不是最新（被其它来源的部署覆盖，如 Cloudflare Git 集成双路）→ 立即失败；
#   - 最新部署是本次 run 但流量不是 100% 指向本次 version → 立即失败；
#   - deploy 日志里找不到 Current Version ID → 立即失败。
#
# 用法：verify-worker-deployment.sh
# 环境变量（必需）：
#   DEPLOY_RUN_ID   github.run_id（package.json 的 deploy 脚本以 --message github-actions-run-${DEPLOY_RUN_ID} 部署）
#   DEPLOY_LOG      `pnpm run deploy` 的完整输出文件（从中取 Current Version ID）
# 环境变量（可选）：
#   WORKER_NAME             默认 aster-cloud
#   WRANGLER                wrangler 命令，默认 "npx wrangler"（测试注入假实现）
#   VERIFY_ATTEMPTS         最多查询次数，默认 6
#   VERIFY_BACKOFF_SECONDS  首次退避秒数，此后翻倍，默认 5
#   VERIFY_BACKOFF_MAX      单次退避上限秒数，默认 30
#   VERIFY_SLEEP            sleep 命令，默认 sleep（测试注入）
#   GITHUB_STEP_SUMMARY     存在则写入核对结果
set -euo pipefail

WORKER_NAME="${WORKER_NAME:-aster-cloud}"
WRANGLER="${WRANGLER:-npx wrangler}"
VERIFY_ATTEMPTS="${VERIFY_ATTEMPTS:-6}"
VERIFY_BACKOFF_SECONDS="${VERIFY_BACKOFF_SECONDS:-5}"
VERIFY_BACKOFF_MAX="${VERIFY_BACKOFF_MAX:-30}"
VERIFY_SLEEP="${VERIFY_SLEEP:-sleep}"

err() { echo "::error::$*"; }

# 从 deploy 输出取 `Current Version ID: <uuid>`；多条时取最后一条（即最终生效的那次上传）。
extract_version_id() {
  sed -nE 's/.*Current Version ID:[[:space:]]*([0-9a-fA-F-]{36}).*/\1/p' "$1" | tail -n1
}

# 读入 deployments JSON（stdin），输出 "<状态> <说明>"：
#   landed      最新部署 = 本次 run，且 100% 流量指向本次 version
#   pending     列表中尚无本次 run 的部署（读后写延迟）
#   superseded  本次部署在列表中，但已有更新的部署覆盖它
#   mismatch    最新部署是本次 run，但流量没有 100% 指向本次 version
# 按 created_on 排序（与 wrangler 文本输出一致，API 返回的 ISO-8601 UTC 字符串可直接比较），不依赖列表原始顺序。
classify_deployments() {
  local message="$1" version_id="$2"
  jq -r --arg msg "$message" --arg ver "$version_id" '
    if type != "array" then error("deployments JSON 不是数组") else . end
    | sort_by(.created_on)
    | (map(select(.annotations["workers/message"] == $msg)) | length) as $ours
    | (last // {}) as $latest
    | if $ours == 0 then "pending 列表中尚无 message=\($msg) 的部署"
      elif ($latest.annotations["workers/message"] // "") != $msg then
        "superseded 本次部署已被更新的部署覆盖：最新 created_on=\($latest.created_on) message=\($latest.annotations["workers/message"] // "-")"
      elif ($latest.versions // []) == [] then
        "mismatch 最新部署没有任何 version 流量，期望 \($ver)@100%"
      elif all(($latest.versions // [])[]; .version_id == $ver)
        and ((($latest.versions // []) | map(.percentage) | add) == 100) then
        "landed 最新部署 created_on=\($latest.created_on) 100% → \($ver)"
      else
        "mismatch 最新部署流量为 \(($latest.versions // []) | map("\(.version_id)@\(.percentage)%") | join(","))，期望 \($ver)@100%"
      end
  '
}

summary() {
  [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] || return 0
  printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"
}

main() {
  [[ -n "${DEPLOY_RUN_ID:-}" ]] || { err "缺 DEPLOY_RUN_ID"; return 1; }
  [[ -n "${DEPLOY_LOG:-}" && -r "$DEPLOY_LOG" ]] || { err "缺可读的 DEPLOY_LOG（pnpm run deploy 输出）"; return 1; }
  command -v jq >/dev/null || { err "需要 jq"; return 1; }

  local message="github-actions-run-${DEPLOY_RUN_ID}" version_id
  version_id="$(extract_version_id "$DEPLOY_LOG")"
  [[ -n "$version_id" ]] || { err "deploy 输出中找不到 Current Version ID，无法核实部署身份"; return 1; }
  echo "期望：message=${message} version=${version_id}"

  local attempt=1 delay="$VERIFY_BACKOFF_SECONDS" out parsed result state detail
  # 全局变量：EXIT trap 在 main 返回后才执行，local 变量届时已失效。
  STDERR_FILE="$(mktemp)"
  trap 'rm -f "$STDERR_FILE"' EXIT
  while :; do
    result=""
    # shellcheck disable=SC2086  # WRANGLER 可含参数（npx wrangler）
    if out="$($WRANGLER deployments list --name "$WORKER_NAME" --json 2>"$STDERR_FILE")"; then
      if parsed="$(printf '%s' "$out" | classify_deployments "$message" "$version_id" 2>&1)" && [[ -n "$parsed" ]]; then
        result="$parsed"
      else
        result="api-error 无法解析 deployments JSON：$(printf '%s' "$parsed" | tail -n1)"
      fi
    else
      result="api-error wrangler deployments list 失败：$(tail -n5 "$STDERR_FILE" | tr '\n' ' ')"
    fi
    state="${result%% *}"
    detail="${result#* }"
    echo "第 ${attempt}/${VERIFY_ATTEMPTS} 次查询：${state} —— ${detail}"

    case "$state" in
      landed)
        summary "### Worker 部署核对" "✅ ${detail}" "message: ${message}"
        return 0 ;;
      superseded|mismatch)
        err "$detail"
        summary "### Worker 部署核对" "❌ ${state}: ${detail}"
        return 1 ;;
      pending|api-error) ;;
      *)
        err "未知核对结果：${result}"
        return 1 ;;
    esac

    if (( attempt >= VERIFY_ATTEMPTS )); then
      err "重试 ${VERIFY_ATTEMPTS} 次仍未确认本次部署生效（${state}）：${detail}"
      summary "### Worker 部署核对" "❌ ${state}: ${detail}"
      return 1
    fi
    "$VERIFY_SLEEP" "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
    (( delay <= VERIFY_BACKOFF_MAX )) || delay="$VERIFY_BACKOFF_MAX"
  done
}

[[ "${1:-}" == "--source-only" ]] || main "$@"
