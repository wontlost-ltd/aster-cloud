#!/usr/bin/env bash
set -euo pipefail

workflow=".github/workflows/deploy-worker.yml"
yq -e '."on".workflow_run.workflows | contains(["CI"])' "$workflow" >/dev/null
yq -e '."on".workflow_run.types | contains(["completed"])' "$workflow" >/dev/null
yq -e '."on".workflow_run.branches | contains(["main"])' "$workflow" >/dev/null
yq -e '."on" | has("push") | not' "$workflow" >/dev/null
yq -e '.jobs.deploy."if" | test("workflow_run.conclusion.*success")' "$workflow" >/dev/null
yq -e '.jobs.deploy."if" | contains("ENABLE_CI_WORKER_DEPLOY")' "$workflow" >/dev/null
yq -e '.jobs.deploy.steps[] | select(.uses == "actions/checkout@v7") | .with.ref | contains("workflow_run.head_sha")' "$workflow" >/dev/null
# #836：部署核对按身份（run message + version id）走可测脚本，不再比较 job 开始时间。
yq -e '.jobs.deploy.steps[] | select(.name == "Build + deploy") | .run | contains("pipefail") and contains("deploy-worker.log")' "$workflow" >/dev/null
yq -e '.jobs.deploy.steps[] | select(.name == "Verify deployment landed") | .run | contains("scripts/ci/verify-worker-deployment.sh")' "$workflow" >/dev/null
yq -e '.jobs.deploy.steps[] | select(.name == "Verify deployment landed") | .env.DEPLOY_LOG | contains("deploy-worker.log")' "$workflow" >/dev/null
if grep -q "deploy-worker-started-at" "$workflow"; then echo "deploy-worker.yml 仍依赖 job 开始时间比较（#836）"; exit 1; fi
echo "deploy-worker workflow structure: PASS"
