#!/usr/bin/env bash
# verify-worker-deployment.sh 的离线测试（issue #836）。
#
# 用假的 wrangler 依次回放 fixtures（JSON 或 ERR:<fixture> 表示 API 失败），假的 sleep 只记录退避秒数。
# 不访问 Cloudflare。用法：bash scripts/ci/verify-worker-deployment.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_SCRIPT="${SCRIPT_DIR}/verify-worker-deployment.sh"
FIXTURES="${SCRIPT_DIR}/fixtures/verify-worker-deployment"
command -v jq >/dev/null || { echo "需要 jq"; exit 1; }

FAILED=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILED=1; }

FAKE_DIRS=()
trap 'rm -rf "${FAKE_DIRS[@]}"' EXIT

# 建假的 wrangler/sleep：每次 deployments list 弹出 responses 的首行（末行保持不变，模拟此后状态不再变化）。
setup_fake() {
  FAKE_DIR="$(mktemp -d)"
  FAKE_DIRS+=("$FAKE_DIR")
  : > "$FAKE_DIR/calls"
  : > "$FAKE_DIR/sleeps"
  printf '%s\n' "$@" > "$FAKE_DIR/responses"
  cat > "$FAKE_DIR/wrangler" <<WR
#!/usr/bin/env bash
set -euo pipefail
dir="$FAKE_DIR"
fixtures="$FIXTURES"
WR
  cat >> "$FAKE_DIR/wrangler" <<'WR'
echo "$*" >> "$dir/calls"
[[ "$1 $2" == "deployments list" ]] || { echo "unexpected wrangler call: $*" >&2; exit 2; }
line="$(head -n1 "$dir/responses")"
[[ "$(wc -l < "$dir/responses")" -gt 1 ]] && sed -i.bak '1d' "$dir/responses"
if [[ "$line" == ERR:* ]]; then cat "$fixtures/${line#ERR:}" >&2; exit 1; fi
if [[ "$line" == RAW:* ]]; then printf '%s' "${line#RAW:}"; exit 0; fi
cat "$fixtures/$line"
WR
  printf '#!/usr/bin/env bash\necho "$1" >> "%s/sleeps"\n' "$FAKE_DIR" > "$FAKE_DIR/sleep"
  chmod +x "$FAKE_DIR/wrangler" "$FAKE_DIR/sleep"
}

# run_case <deploy-log> <response...>：执行脚本，结果写入 RC / OUT。
run_case() {
  local log="$1"; shift
  setup_fake "$@"
  set +e
  OUT="$(DEPLOY_RUN_ID=44647104899 DEPLOY_LOG="$FIXTURES/$log" WRANGLER="$FAKE_DIR/wrangler" \
    VERIFY_SLEEP="$FAKE_DIR/sleep" VERIFY_ATTEMPTS=4 VERIFY_BACKOFF_SECONDS=5 VERIFY_BACKOFF_MAX=15 \
    GITHUB_STEP_SUMMARY="$FAKE_DIR/summary" bash "$TARGET_SCRIPT" 2>&1)"
  RC=$?
  set -e
  CALLS="$(wc -l < "$FAKE_DIR/calls" | tr -d ' ')"
  SLEEPS="$(paste -sd, "$FAKE_DIR/sleeps")"
}

expect() { # expect <名称> <期望rc> <期望调用次数> <期望退避序列> <输出须含>
  local name="$1" rc="$2" calls="$3" sleeps="$4" needle="$5"
  if [[ "$RC" == "$rc" && "$CALLS" == "$calls" && "$SLEEPS" == "$sleeps" && "$OUT" == *"$needle"* && "$OUT" != *"unbound variable"* ]]; then
    pass "$name"
  else
    fail "${name}（rc=$RC calls=$CALLS sleeps=[$SLEEPS]）"
    printf '%s\n' "$OUT" | sed 's/^/      /'
  fi
}

echo "verify-worker-deployment.sh"

run_case deploy.log landed.json
expect "已生效：首次查询即通过" 0 1 "" "landed"
grep -q -- "--json" "$FAKE_DIR/calls" && grep -q -- "--name aster-cloud" "$FAKE_DIR/calls" \
  && pass "使用 --json 且指定 Worker 名" || fail "wrangler 调用参数不对：$(cat "$FAKE_DIR/calls")"
grep -q "✅" "$FAKE_DIR/summary" && pass "写入 step summary" || fail "未写 step summary"

run_case deploy.log landed-out-of-order.json
expect "列表乱序（API 最新在前且无序）仍按 created_on 判定" 0 1 "" "landed"

run_case deploy.log not-landed.json
expect "始终未出现本次部署：重试耗尽后 fail-closed" 1 4 "5,10,15" "重试 4 次仍未确认"

run_case deploy.log not-landed.json not-landed.json landed.json
expect "读后写延迟（#836 c7f510e4 形态）：重试后通过" 0 3 "5,10" "landed"

run_case deploy.log ERR:api-error.txt landed.json
expect "API 错误（#836 6561896 形态）后重试成功" 0 2 "5" "landed"

run_case deploy.log ERR:api-error.txt
expect "API 持续失败：fail-closed" 1 4 "5,10,15" "code: 100146"

run_case deploy.log "RAW:<html>502 Bad Gateway</html>" landed.json
expect "非 JSON 输出按 API 错误重试" 0 2 "5" "landed"

run_case deploy.log "RAW:" landed.json
expect "空输出按 API 错误重试" 0 2 "5" "landed"

run_case deploy.log superseded.json
expect "本次部署被更新的部署覆盖：立即失败不重试" 1 1 "" "superseded"

run_case deploy.log mismatch.json
expect "最新部署流量未 100% 指向本次 version：立即失败" 1 1 "" "mismatch"

run_case deploy.log prefix-collision.json
expect "message 前缀碰撞不算命中" 1 4 "5,10,15" "pending"

run_case deploy-no-version.log landed.json
expect "deploy 输出无 Current Version ID：不查询直接失败" 1 0 "" "找不到 Current Version ID"

(( FAILED == 0 )) || { echo "verify-worker-deployment: FAIL"; exit 1; }
echo "verify-worker-deployment: PASS"
