# 本地栈浏览器 E2E（local-stack）

针对本地 aster-cloud 开发栈（容器 `aster-cloud` / `aster-api` / `aster-pg`）的登录态浏览器用例，覆盖 ADR 0041 证据包 v2、ADR 0042 业务角色与审批收件箱、ADR 0043 What-If 转移矩阵。所有用例在 `BASE_CLOUD` 不含 `localhost` 时自动跳过，不会打到生产。

## 会话夹具

栈内种子用户没有密码，登录态通过伪造 Auth.js v5 JWT 会话 cookie 获得：`scripts/e2e-local-session.ts` 用 `next-auth/jwt` 的 `encode`（salt 为 cookie 名 `authjs.session-token`，有效期 1 天）为 `m-free`、`m-dpo`、`owner1`、`t1` 生成 Playwright storageState，写到 `.superpowers/e2e-local/state-<user>.json`（已被 git 忽略，切勿提交）。脚本必须在容器内运行，以读取 `NEXTAUTH_SECRET`：

```bash
export PATH=/opt/homebrew/opt/node@24/bin:/opt/podman/bin:$PATH
podman exec -w /app aster-cloud sh -c 'npx tsx scripts/e2e-local-session.ts'
```

cookie 过期（1 天）后重新执行即可。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `BASE_CLOUD` | 必填，例如 `http://localhost:3100`；不含 `localhost` 时全部跳过 |
| `E2E_STATE_DIR` | 可选，storageState 目录，默认 `.superpowers/e2e-local` |
| `E2E_LOCAL_STACK` | 设在 **aster-cloud 容器**上（`-e E2E_LOCAL_STACK=1`），不是 Playwright 进程；开启 dev 入口长缓冲，保证预热在整轮用例内有效 |
| `PODMAN_BIN` | 可选，podman 路径，默认 `/opt/podman/bin/podman`（用例用 psql 校验落库结果） |

## 运行

必须带 `--workers=1`：本地 dev 服务器是单实例，并行跑会互相拖慢导致超时，并可能让中断的用例残留数据（各文件也已声明 `mode: 'serial'`）。

```bash
BASE_CLOUD=http://localhost:3100 pnpm exec playwright test src/__tests__/e2e-browser/local-stack --project=chromium-desktop --workers=1
```

## 冷启动预热

`playwright.config.ts` 的 `globalSetup`（`local-stack/global-setup.ts`）在 `BASE_CLOUD` 含 `localhost` 时，于任何用例之前按各用例实际使用的登录态（m-free / m-dpo / owner1）依次访问 `/en/dashboard`、`/en/approvals`、`/en/policies/pol-adr0041-team/logs`、`/en/policies/pol-adr0041-team`、`/en/reports`、`/en/teams/team1/members`，每页等到网络空闲（让懒加载 chunk 与客户端 API 调用也在预热阶段编译完），再对用例与页面会调用的 API 路由（套餐查询、日志、版本、What-If 批次、证据导出与下载、团队成员等，清单见 `WARM_APIS`）各发一次 GET 触发编译（每项超时 180s）。因此 `podman restart aster-cloud` 后看到 `Ready in` 即可直接运行，首个用例不会再撞 15s 导航超时。预热耗时会以 `[warmup]` 日志输出；生产目标下预热不执行。

webpack dev 默认只保留最近 5 个按需编译入口、闲置 60s 即释放，预热会被后续编译挤掉；为此 `next.config.ts` 在 `E2E_LOCAL_STACK=1` 时放宽 `onDemandEntries`（缓冲 100 个、闲置 30 分钟，仅 dev 生效）。该变量由 dev 服务器启动时读取，**栈容器必须以 `-e E2E_LOCAL_STACK=1` 启动**（对已有容器 `podman restart` 不会改变环境变量，需按栈配方重建）；未设置时预热仍执行，但长套件中途可能出现重编译超时。

## 数据前提与副作用

- 依赖栈内种子：团队 `team1`、策略 `pol-adr0041-team`（v1 require_approval / v2 escalate）及其执行记录与 guard 待审批。
- `approvals-inbox` 会以 m-dpo 批准一条 `principal_id like 'e2e-%'` 的待审批；没有时该用例跳过，可用 aster-guard 的 `scripts/e2e-local.mjs`（不带审批人 key）补一条。
- `team-business-roles` 会为 m-free 增加再删除 `CISO`，结束时还原。
- `whatif-matrix` 与 `evidence-export` 各新建一个批次 / 导出记录。
- What-If 依赖 aster-api 向 cloud 查询套餐（超时 1.5s，失败即拒绝）；dev 服务器冷编译时可能偶发 “requires a Pro plan”，重跑即可。
