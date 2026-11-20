# 本地栈浏览器 E2E（local-stack）

针对本地 aster-cloud 开发栈（容器 `aster-cloud` / `aster-api` / `aster-pg`）的登录态浏览器用例，覆盖 ADR 0041 证据包 v2、ADR 0042 业务角色与审批收件箱、ADR 0043 What-If 转移矩阵。所有用例在 `BASE_CLOUD` 不含 `localhost` 时自动跳过，不会打到生产。

## 会话夹具

栈内种子用户没有密码，登录态通过伪造 Auth.js v5 JWT 会话 cookie 获得：`scripts/e2e-local-session.ts` 用 `next-auth/jwt` 的 `encode`（salt 为 cookie 名 `authjs.session-token`，有效期 1 天）为 `m-free`、`m-dpo`、`owner1`、`t1`、`cp-owner`、`cp-officer`、`cp-analyst` 生成 Playwright storageState，写到 `.superpowers/e2e-local/state-<user>.json`（已被 git 忽略，切勿提交）。脚本必须在容器内运行，以读取 `NEXTAUTH_SECRET`：

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
| `CP_API_KEY` | 可选，信贷试点租户的 API key；`credit-pilot` 用它经 `/api/v1/policies/pol-credit-pilot/execute` 执行一笔 REQUIRE_APPROVAL 申请，缺失时该用例跳过 |
| `ASTER_FACT_SIGNING_KEY` | 设在 **aster-cloud 容器**上，同时供容器内 `pnpm seed:credit-pilot` 读取；取值为 `pnpm --silent fact-key:gen --kid <kid>` 的输出（一行 JSON，含私钥，勿落盘）。seed 把其公钥登记为 `credit-pilot` 租户的签发方，执行时 cloud 为 `principal.id` 与 `context.applicant`（`fixture.creditPilot`，仅非生产）附签名事实；缺失时 seed 非零退出 |
| `E2E_GUARD_API_KEY` | `approvals-inbox` 必填：team1 成员的 API key（如 m-free 的 key），用于经 aster-api 自补待审批；缺失时该文件跳过。预热阶段也用它预热 aster-api → cloud 的 API key 校验回调 |
| `BASE_API` | 可选，aster-api 根地址，默认 `http://localhost:8080` |
| `PODMAN_BIN` | 可选，podman 路径，默认 `/opt/podman/bin/podman`（用例用 psql 校验落库结果） |
| `E2E_PG_CONTAINER` | 可选，栈的 Postgres 容器名，默认 `aster-pg`；另起一套隔离栈（不同容器前缀）时指定 |
| `ASTER_PLAN_GATE_HMAC_KEY` | `approval-input-reveal` 必填：与栈内 cloud / api 相同的内部签名密钥，用例以 cloud-bff 身份自补带 `@pii` 输入的待审批；缺失时该文件跳过 |

## 运行

必须带 `--workers=1`：本地 dev 服务器是单实例，并行跑会互相拖慢导致超时，并可能让中断的用例残留数据（各文件也已声明 `mode: 'serial'`）。

```bash
BASE_CLOUD=http://localhost:3100 pnpm exec playwright test src/__tests__/e2e-browser/local-stack --project=chromium-desktop --workers=1
```

## 冷启动预热

`playwright.config.ts` 的 `globalSetup`（`local-stack/global-setup.ts`）在 `BASE_CLOUD` 含 `localhost` 时，于任何用例之前按各用例实际使用的登录态（m-free / m-dpo / owner1）依次访问 `/en/dashboard`、`/en/approvals`、`/en/policies/pol-adr0041-team/logs`、`/en/policies/pol-adr0041-team`、`/en/reports`、`/en/teams/team1/members`，每页等到网络空闲（让懒加载 chunk 与客户端 API 调用也在预热阶段编译完），再对用例与页面会调用的 API 路由（套餐查询、日志、版本、What-If 批次、证据导出、下载与法规映射、团队成员等，清单见 `WARM_APIS`）各发一次 GET 触发编译（每项超时 180s）。因此 `podman restart aster-cloud` 后看到 `Ready in` 即可直接运行，首个用例不会再撞 15s 导航超时。预热耗时会以 `[warmup]` 日志输出；生产目标下预热不执行。

webpack dev 默认只保留最近 5 个按需编译入口、闲置 60s 即释放，预热会被后续编译挤掉；为此 `next.config.ts` 在 `E2E_LOCAL_STACK=1` 时放宽 `onDemandEntries`（缓冲 100 个、闲置 30 分钟，仅 dev 生效）。该变量由 dev 服务器启动时读取，**栈容器必须以 `-e E2E_LOCAL_STACK=1` 启动**（对已有容器 `podman restart` 不会改变环境变量，需按栈配方重建）；未设置时预热仍执行，但长套件中途可能出现重编译超时。

## 数据前提与副作用

- 依赖栈内种子：团队 `team1`、策略 `pol-adr0041-team`（v1 require_approval / v2 escalate）及其执行记录。
- `approvals-inbox` 在 `beforeAll` 经 aster-api `POST /api/v1/guard/decisions`（与 aster-guard `scripts/e2e-local.mjs` 第 2 步相同）为 team1 新建两条 `e2e-` 待审批：一条由 m-dpo 批准，另一条留在 Pending 供只读视角；不再依赖 24 小时内手工补的数据。
- `policy-logs-guard-link` 同样在 `beforeAll` 以 `E2E_GUARD_API_KEY` 为 team1 自补一条 `e2e-` 待审批执行（未设置该变量时跳过并注明原因），日志页的「Pending approval · View」行不再依赖 24 小时内的种子数据。
- `team-business-roles` 会为 m-free 增加再删除 `CISO`，结束时还原。
- `whatif-matrix` 与 `evidence-export` 各新建一个批次 / 导出记录。`whatif-matrix` 不写死执行数，以批次给出的可回放总数（扣除不可比条数）为期望值。
- `policy-actions-786`（#786）：以 UI 审计种子（`pnpm ui-audit:seed`，`UI_AUDIT_STATE_DIR`）的 ui-owner 身份新建三条个人策略（可导出 / Text.length 不可导出 / 仅草稿，前两条经 psql 置 v1 为 APPROVED，结束时软删除），桌面与 390px 移动视口各跑一遍：「Export to Cedar」在页头操作组里、同高、移动端点击区 ≥ 44px；导出结果出现在操作组下方的 aria-live 状态区且操作组不移位；不可导出的策略首帧起就没有导出按钮；版本页唯一一行草稿的「⋮ → Submit for approval」完整可见。需要 aster-api 提供 `POST /api/v1/policies/export/cedar/check`；用 `E2E_PG_CONTAINER` 指定栈的 Postgres 容器。
- `admin-mobile-overflow`（#774）：用例现建一个平台管理员与一个无空格长邮箱用户（psql 写 User 行，伪造会话 cookie，需 `NEXTAUTH_SECRET` 与被测进程一致、`E2E_PG_CONTAINER` 指向栈的 Postgres），经应用接口给 BYOK 白名单加一个长主机名、发起一次 report 模式全量复核（需要 aster-api；已有运行中的复核时等它结束）。在 390 / 360px × en / zh × 浅色 / 深色下断言 `/admin` 无横向溢出、「平台控制」每张卡片右缘不越出父容器且卡内无越界内容、长邮箱与长主机名完整折行；`/admin/revalidation` 的工具链标识完整可复制、在所在区块内折成多行。结束时删除两名用户与 BYOK 主机，复核记录保留。
- `cedar-export`（ADR 0047）以 t1 身份经 `POST /api/policies` 新建三条策略（结束时软删除）；导出的是可执行版本，故前两条经 psql 把 v1 置为 APPROVED（四眼原则下单用户无法自批），第三条保持草稿以断言「先批准」提示。可导出那条会在 aster-api 审计表追加一条 `POLICY_EXPORTED`，用例经 psql 核对其 `claimedRef` 与下载文件哈希；设 `CEDAR_EXPORT_OUT=<目录>` 时另存两个下载文件供 Cedar CLI 交叉核对。
- What-If 依赖 aster-api 向 cloud 查询套餐（超时 1.5s，失败即拒绝）；dev 服务器冷编译时可能偶发 “requires a Pro plan”，重跑即可。
- `credit-pilot`（ADR 0044 §5）前置：先运行 `pnpm seed:credit-pilot` 生成 `pol-credit-pilot`（v1/v2）与 cp-owner / cp-officer / cp-analyst，并重新生成会话夹具；再提供 `CP_API_KEY`（须为 cp-owner 的 key：团队成员执行的记录目前无法被 What-If 回放，ADR 0034 §4.3 属主限定，见 ADR 0044 §10 后续事项；spec 自行以 API 执行一笔需审批申请，等价于 run 脚本第 1 步）。What-If 与日志页均按策略属主限定，须由 cp-owner 运行（分析员会得到 `TARGET_VERSION_MISSING` / 404）。该用例会新增一次执行、批准一条 `credit-pilot` 待审批、新建一个 What-If 批次与一次导出。
- `guard-bypass`（aster-api#466 阶段 A，Guard 绕过红队的 cloud 场景，**只在本地栈手动运行、不进任何 CI**）：前置同 `credit-pilot`（`pnpm seed:credit-pilot`、容器设 `ASTER_FACT_SIGNING_KEY`、`CP_API_KEY` 为 cp-owner 的 key、会话夹具含 cp-officer）。C7a 执行一笔篡改过 applicant 的需审批申请，断言来源门 DENY `unverified_input`；C2 对该决策 consume 得 409 `not_allowed`；C3/C4/C5 执行一笔真实需审批申请、由 cp-officer 在页面批准，再经 `BASE_API` 验签收据、改哈希 consume（409 `action_mismatch`）、正确哈希 consume（200，**消耗该收据**）、重放（409 `receipt_consumed`）与结果回写；C7b 为 `test.fixme`（aster-api#510：ALLOW 也须过来源门）。会新增 2 次执行（C7b 启用后 3 次）、批准一条 `credit-pilot` 待审批。运行：`BASE_CLOUD=http://localhost:3100 CP_API_KEY=… pnpm exec playwright test src/__tests__/e2e-browser/local-stack/guard-bypass.spec.ts --project=chromium-desktop --workers=1`。
- `guard-reconciliation`（ADR 0061 计划 Task 8，cloud#769 Guard 对账治理页）：前置同 `credit-pilot`（`pnpm seed:credit-pilot`、`CP_API_KEY` 为 cp-owner 的 key、会话夹具含 cp-owner 与 cp-analyst）。**aster-api 须为含 ADR 0061 A1 的镜像**（`severity` 过滤与 `ackComment`，aster-api `e8977da` 起），且容器设 `ASTER_GUARD_RECONCILIATION_CRON='*/10 * * * * ?'` 与 `ASTER_GUARD_RECONCILIATION_MIN_INTERVAL=PT5S`，否则缺省 5 分钟一轮、用例 90 s 内等不到孤儿。用例以 `CP_API_KEY` 经 `BASE_API` 上报一条无 `decisionId` 的副作用，轮询 psql 至检出 `side_effect_without_decision`；成员 cp-analyst 在 `/governance` 摘要卡与明细页看到该行但没有「确认」、直接调 BFF 确认得 403；cp-owner 带说明确认后该行离开 OPEN 视图、ACKNOWLEDGED 视图显示说明与确认人，psql 核对 `guard_orphan_actions.ack_comment` 与链事件 `GUARD_ORPHAN_ACKNOWLEDGED`（`performed_by` = cp-owner、`metadata.comment`）；再次确认得 409 `not_open`。会新增一条副作用上报、一条孤儿与一条确认链事件。
- `approval-input-reveal`（aster-api#460 生产缺陷回归）：`beforeAll` 经 psql 播种团队 `pii-team`（`pii-req` 属主、`pii-officer` 持 `Risk Officer`），再以 cloud-bff 身份经 evaluate-source → from-evidence 自补一条 `email` 为 `@pii(L2, email)` 的待审批；pii-officer 在页面上显示原值、收起再展开（面板重新挂载）后批准，断言批准提交的是解除视图哈希、`guard_approvals` 为 `input_snapshot_matched = true / input_revealed = true`、本人有一条解除记录，且收据接口 `approvals[]` / `reveals[]`（证据包 v6 复核者字段的来源）一致。会话夹具须含 pii-officer（重新运行 `scripts/e2e-local-session.ts`）。
- `structured-authoring`（ADR 0058 阶段 1，计划 Task 15）：用例自建平台管理员、Pro 用户 A、团队 owner 与成员 B / C 和团队（psql 写 `User` / `Team` / `TeamMember`，伪造会话 cookie，需 `NEXTAUTH_SECRET` 与被测进程一致、`E2E_PG_CONTAINER` 指向栈的 Postgres），经平台管理接口打开 `capability.structured_authoring.enabled` 并授予 A，A 在德语界面用模型 / 词汇标签页写一条 de-DE 策略、打开词汇规范预览并保存；owner 在团队设置页按 `seatCap=1` 委派；最后关闭开关并经 `/api/policies/<id>/execute` 执行已存策略。预览需要 LSP：cloud 构建时 `NEXT_PUBLIC_LSP_HOST` 指向本地网关（`PORT=<端口> ALLOWED_ORIGINS=<BASE_CLOUD> node lsp-server.mjs`，非生产不带 ticket 放行）；忠实性比对由子进程 `structured-authoring-core-ir.ts` 完成（`NODE_OPTIONS=--conditions=import tsx`）。结束时关闭开关，尽力删除授权、额度、团队、成员与用户行，策略软删除（外键挡住删除时保留，不影响结论）。截图写到 `E2E_SCREENSHOT_DIR`。
- `policy-layout`（ADR 0058 阶段 2，计划 Task 12）：用例自建平台管理员、Pro 用户 A、团队 owner B、成员 C、viewer D 与团队（psql 写 `User` / `Team` / `TeamMember`，伪造会话 cookie，需 `NEXTAUTH_SECRET` 与被测进程一致、`E2E_PG_CONTAINER` 指向栈的 Postgres），经平台管理接口打开 `capability.structured_authoring.enabled` 并直接授予 A。A 在团队下新建 zh-CN 小策略，用「排版」标签页把空格标为结构、display 置空并在并排视图核对插入标记与光标高亮；导入藏值 / 往返不符的排版被保存接口拒绝；只改排版建新版本；B 在策略详情的版本面板先看到 canonical、批准、对比提示「显示排版已变更」；D 只读看到 display 标签；C（无授权）改源码时确认丢弃排版并看到警告，未附排版的策略行为不变。浏览器里任何 `*.aster-lang.dev` 请求都会被拦下并使用例失败（#824），因此 cloud 的 `NEXT_PUBLIC_*` 与 aster-api 地址须指向本地或死端口。结束时关闭开关并软删除策略。截图写到 `E2E_SCREENSHOT_DIR`。
- `policy-showcase-template`（ADR 0060 §8、cloud#830「静夜思」特色模板：原诗即策略）：用例自建平台管理员、Pro 用户 A / N、团队 owner B 与团队（psql 写 `User` / `Team` / `TeamMember`，伪造会话 cookie，需 `NEXTAUTH_SECRET` 与被测进程一致、`E2E_PG_CONTAINER` 指向栈的 Postgres），打开 `capability.structured_authoring.enabled` 并授予 A、N，经 `/api/admin/structural-alias-grants` 只给 A 结构词别名授权。N 看到模板锁定（缺结构词别名权限）；A 在团队下应用模板（确认框说明别名、本策略词汇与排版也会替换），并排视图的 display 与原诗一字不差，「词汇」标签「本策略」分组列出两条内嵌词条，保存后核对源码（逐字节）、aliasSet、embeddedVocabulary 与排版行；B 在版本面板看到四条别名与两条内嵌词条并批准；A 批准后新增同形个人词条 `望明月 → Moon`，经 `/api/policies/<id>/execute` 与执行页执行，输出 `静夜思`；最后以 v1 为目标发起批量 What-If，批次 COMPLETED。需要 aster-api 1.0.52（别名规则 v2）。浏览器里任何 `*.aster-lang.dev` 请求都会使用例失败（#824）。结束时撤销授权、关闭开关并软删除策略。截图写到 `E2E_SCREENSHOT_DIR`。
- `embedded-vocabulary`（ADR 0060 计划 Task 11，策略内嵌词汇）：用例自建平台管理员与 Pro 用户 A（psql 写 `User`，伪造会话 cookie，需 `NEXTAUTH_SECRET` 与被测进程一致、`E2E_PG_CONTAINER` 指向栈的 Postgres），打开 `capability.structured_authoring.enabled` 并授予 A。A 新建 zh-CN《静夜思》式小策略，在「词汇」标签的「本策略」分组加字面量 `思故乡 → 静夜思` 与类型 `望明月 → Text`，打开词汇规范预览核对 `「静夜思」` 与 `Text` 的替换，保存；psql 核对 v1 的 `embeddedVocabulary` 为 ADR §8 的规范序列化，经 `/api/policies/<id>/execute` 让 aster-api 真编译执行得 `静夜思`；版本面板列出内嵌词汇映射表（字面量行带「Expands to text」）；编辑页预填词条，只改源码保存后 v2 沿用同一文本。预览需要 LSP（cloud 构建时 `NEXT_PUBLIC_LSP_HOST` 指向本地网关）。浏览器里任何 `*.aster-lang.dev` 请求都会使用例失败（#824）。结束时关闭开关并软删除策略。截图写到 `E2E_SCREENSHOT_DIR`。
