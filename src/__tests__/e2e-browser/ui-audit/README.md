# UI 审计套件（#774）

对 `src/app/[locale]/**` 下每个页面做链接、按钮、无障碍、布局与视觉检查，桌面（1440×900）与移动（390×844）各跑一遍，语言 en + zh，浅色 + 深色主题。只针对本地栈：`BASE_CLOUD`（及设置了的 `BASE_API`）必须是回环地址，否则全部跳过。

## 检查项

| 类别 | 内容 | 严重度 |
| --- | --- | --- |
| 页面 | HTTP 5xx / 4xx、登录态被拒（跳登录页）、渲染了错误边界或 404、页面内 5xx 请求、未捕获 JS 错误 | critical / serious / moderate |
| 链接 | 无 href 的 `<a>`、`#` / `javascript:` 假链接、页内锚点无目标、`target=_blank` 缺 `rel`；`links.spec.ts` 以对应角色会话 GET 每个站内链接（含 Next 软 404 识别），HEAD 站外链接 | serious（站内失效）/ moderate / minor |
| 按钮 | 逐个点击（每页 ≤30 个，按名称去重），无任何可观察效果即「死按钮」；唯一效果是被拦截的 API 请求时记为「无法确认」（`click-verdict.ts`，不算有效）；点不到；禁用但不说明原因；破坏性按钮直接发写请求而无确认步骤 | serious / moderate / minor |
| 键盘 | 菜单 / 对话框可用 Enter 打开、模态层困住焦点、Esc 关闭、焦点回到触发按钮；Tab 遍历前 25 个焦点检查可见焦点指示 | serious / moderate |
| 弹出层 | 用 Enter 打开每个菜单 / 下拉后，新露出的项须完整可见：不被同时包含触发按钮的 overflow 容器截掉（含 auto / scroll——`overflow-x:auto` 的表格外壳会让纵轴也变成 auto，菜单只能在表格里滚动才看得到，#786）、不横向出视口、中心点不被别的元素盖住；弹出层自己的滚动列表不算。页面加载时菜单收起，结构检查看不到这些项 | serious（`popup-item-clipped`） |
| 无障碍 | axe-core（WCAG 2.0/2.1/2.2 A + AA），深色主题复查对比度 | 按 axe impact |
| 布局 | 横向溢出（逐个隐藏定位根因）、网格 / 弹性容器的子项越出容器内容盒（`container-overflow`，与视口宽度无关；只豁免可横向滚动的祖先，被 hidden / clip 祖先裁掉的照报，#774）、移动端点击目标 < 44×44 CSS px（项目规范，serious；句中行内链接豁免）、卡片网格同行等高 / 内边距一致 / 不重叠 / 内容不越界、深色主题是否生效 | serious（移动端溢出 / 容器越界）/ moderate / minor |
| 结构 | 一页多个 `<h1>`；h2–h6 与 h1 同文、或面包屑（aria-label 含 breadcrumb 的 nav）里没有任何链接（只剩当前页名）——同一标题渲染两次；可操作项被 `overflow:hidden` 祖先截掉（够不着），或在横向滚动容器里初始露出不足一个点击目标宽（移动端 serious） | serious / moderate |
| 视觉 | 每个路由 × 视口 × 语言 × 主题一张全页截图，写入输出目录（不入库、不做基线比对） | — |

按钮探测期间拦截所有写请求、所有 API 请求（任何源的 `/api/**`，GET 也拦）以及会改状态的页面（登出、邮件验证、重置密码、接受邀请、续期），伪造 503（带 `x-ui-audit-blocked` 头，不计入 5xx）；规则在 `request-guard.ts`，有单测。种子数据不会被改动；被拦的请求（读或写）不算按钮「有效果」，只有被拦请求之前发生的 DOM 变化、导航、弹窗、下载等才算，否则记为「无法确认」（minor，`button-effect-unverified`）。链接校验手动跟随重定向，跳出本地站点即停止并记为失败。点击目标检查只看尺寸（移动端 44×44 CSS px，`page-checks.ts` 的 `MOBILE_MIN_TARGET`），不评估间距例外；绝对定位的 `::before` / `::after` 撑出的点击区（`.tap-target`）在元素自身不裁剪、不压到相邻点击目标、且对点击区中心 44×44 方块的 5×5 网格采样命中测试都落在该元素上时计入；禁用的控件不算点击目标。规则自身的夹具用例在 `page-checks.spec.ts`（不依赖本地栈，随 ui-audit-desktop 项目运行）。critical / serious 发现会让对应用例 soft 失败；其余只进报告。

## 种子里的长内容（#774）

平台管理页把邮箱、用户 ID、主机名、工具链标识原样渲染，种子只有短值时窄屏溢出看不出来（/admin「平台控制」卡片曾因此漏检）。`seed.ts` 因此额外写入一个无空格长邮箱 / 长 ID 的用户，经 aster-api 给 BYOK 白名单加一个长主机名，并发起一次 report 模式（只报告不拦截）的全量复核，把 runId 写进 `fixtures.json`；审计访问 `/admin/revalidation` 前把它写入 localStorage，页面才会展示运行状态与工具链标识。aster-api 不可用时这两步只告警。

## 运行

```bash
export PATH=/opt/homebrew/opt/node@24/bin:/opt/podman/bin:$PATH
# 1. 本地栈：Postgres / Redis（非默认端口）、可选 aster-api、cloud 生产构建（推荐，dev 服务器太慢）
# 2. 播种角色用户（anon 之外：ui-free / ui-pro / ui-owner / ui-teamadmin / ui-member / ui-platform）、团队、策略、执行与 API key，
#    并写出 storageState 到 .superpowers/ui-audit/（伪造 Auth.js 会话 cookie，需与 cloud 进程相同的 NEXTAUTH_SECRET）
DATABASE_URL=postgresql://…@localhost:55774/aster_cloud NEXTAUTH_SECRET=… BASE_CLOUD=http://localhost:3774 pnpm ui-audit:seed
# 3. 全量审计：页面（桌面 + 移动）→ 链接校验 → 报告
BASE_CLOUD=http://localhost:3774 pnpm test:ui-audit --workers=5
```

报告在 `test-results/ui-audit/report.md`（`UI_AUDIT_OUT` / `UI_AUDIT_REPORT` 可改），截图在同目录 `screens/<viewport>/<locale>/<theme>/`。

| 变量 | 作用 |
| --- | --- |
| `UI_AUDIT_ONLY` | 只跑路径或路由模式匹配该正则的页面，如 `'^docs/'` |
| `UI_AUDIT_LOCALES` | 默认 `en,zh` |
| `UI_AUDIT_BUTTONS=0` | 跳过按钮 / 弹出层探测（最耗时的一步） |
| `UI_AUDIT_SCREENSHOTS=0` | 不截图 |
| `UI_AUDIT_EXTERNAL=0` | 不探测站外链接（离线时） |
| `UI_AUDIT_EXTERNAL_SKIP` | 追加不探测的站外主机（逗号分隔） |
| `UI_AUDIT_CHROMIUM` | 指定本机 Chromium 可执行文件 |
| `UI_AUDIT_STATE_DIR` | storageState / fixtures.json 目录，默认 `.superpowers/ui-audit` |

新增页面须登记到 `routes.ts`；`src/__tests__/ui-audit-route-inventory.test.ts`（vitest，进 CI）会比对 page.tsx 清单，漏登记即失败。

## 是否适合 CI

目前不适合直接进 CI，原因与前提：

- **会话夹具**：靠伪造 Auth.js JWT cookie（`scripts/lib/session-cookie.ts`），需要与被测 cloud 进程共享 `NEXTAUTH_SECRET`，CI 里可以生成临时密钥，但必须保证被测进程不连任何真实库。
- **运行时**：需要 Postgres（cloud 迁移）、cloud 生产构建（约 10 分钟、5 GB 内存）；策略 / 审批类页面还要 aster-api。全量 488 个页面用例 + 链接校验在 5 worker 下约 90 分钟。
- **噪音**：现有 serious 级发现（见 #774 报告）未清零前，任何 CI 闸门都会常红。

建议路径：发现清零后，CI 只跑 `UI_AUDIT_BUTTONS=0 UI_AUDIT_SCREENSHOTS=0 UI_AUDIT_LOCALES=en` 的子集（约 15 分钟），按钮探测与截图留给发版前本地全量运行。
