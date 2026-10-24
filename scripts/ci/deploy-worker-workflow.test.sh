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
echo "deploy-worker workflow structure: PASS"
