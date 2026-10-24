# Worker 发布

## 发布路径

生产 Worker 只由 GitHub Actions 的 `Deploy Worker` workflow 自动发布。它由 main 分支的 `CI` 完成事件触发，只有 CI 成功且仓库变量
`ENABLE_CI_WORKER_DEPLOY=true` 时才继续；部署检出 CI 对应的 `head_sha`，运行 `pnpm run deploy`。CI 的 `image-pin-pr` 门禁已负责等待迁移 image-pin PR 合并、ArgoCD 同步以及迁移 digest 与本次构建一致并 Healthy；无迁移变更会由现有 stalegate/skip 路径快速通过。

Cloudflare Workers Builds 对 main 的自动构建必须由运维关闭，避免产生第二条生产发布路径。关闭日期与控制台证据记录在 k3s 仓 `docs/runbooks/release-evidence.md`。

## 门禁

- CI 未成功时不会部署。
- `ENABLE_CI_WORKER_DEPLOY` 未设置为 `true` 时不会部署。
- workflow 在部署前打印 CI run id、head SHA 和结论；部署后将 run id 与 head SHA 写入步骤摘要。
- 部署后核对 `wrangler deployments list --name aster-cloud` 最新一条时间晚于本 job 开始时间。

## Break-glass

仅管理员在 `Deploy Worker` 连续失败且迁移 Job 已成功后，才可从本地执行 `pnpm deploy`。执行前后应在 k3s 仓 `docs/runbooks/release-evidence.md` 发布记录登记执行者、UTC 时间、对应 main SHA、迁移 Job 状态及原因。完成后核实 Worker 部署记录，并将结果补入登记。

## 核对部署

运行 `npx wrangler deployments list --name aster-cloud` 查看部署记录及时间。最新记录应晚于对应 workflow job 的开始时间；部署 message 包含 `github-actions-run-<run_id>`，可在 GitHub Actions 中定位对应 run。也可在 workflow 的 `Worker 部署结果` 步骤摘要核对 run id、head SHA 和 CLI 输出。
