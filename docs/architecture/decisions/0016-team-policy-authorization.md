# 0016 — 团队策略按当前团队角色授权（资源 × 动作 × 角色矩阵）

Status: Accepted
Date: 2026-10-31
Issues: #669 #670 #671 #673 #674
Companions: 0015（团队作用域 API key）、`aster-api/docs/adr/0034-whatif-replay-batch.md` §4 护栏 3（What-If 属主限定）、
`aster-api/docs/adr/0040-action-guard.md` §4.2 与 `0042-approval-closure.md`（四眼）

## 背景

团队模型早有角色矩阵（`src/lib/team-permission-matrix.ts`：owner / admin / member / viewer），但策略相关的入口
大多按 `eq(policies.userId, session.user.id)` 判归属，只有详情 GET 与会话执行在「不是创建者」时才去查团队角色。
2026-10-30 生产深测（团队策略报告）由此得到两类相反的缺陷：

- 非创建者（包括团队 owner / admin）打开详情页、执行页 404，不能编辑、删除、看日志、导出 Cedar（#669）；
- 创建者被降为 viewer 后仍可编辑 / 删除 / 提交审批，离队或被移除后仍能修改团队策略、执行、提交审批（#670）。

同一根因的旁支：团队 key 能执行并列出创建者的个人策略（#671），日志与证据只含本人执行（#673），
团队策略列表含回收站里的策略（#674）。

## 决策

### 1. 单一授权入口

- `src/lib/policy-access-matrix.ts`：纯函数 `decidePolicyAccess({ action, actorId, policy, teamRole, keyTeamId })`，
  客户端与服务端共用。
- `src/lib/policy-access.ts`：服务端入口。`loadPolicyForAction(policyId, actor, action, { deleted? })` 取策略并授权，
  `authorizePolicyAction` 对已取到的策略授权，`loadPolicyCapabilities` 给页面算按钮，`teamsAllowing` /
  `policiesVisibleTo` / `ownPoliciesVisibleTo` 给列表类查询收窄范围，`executionExecutorScope` 决定日志与证据的执行人范围。
- 所有按 policyId 操作策略的入口（页面、会话路由、API v1、团队 key、版本服务层、回收站服务层）都经由它，
  不再各自写 `eq(policies.userId, …)`。

### 2. 规则

1. **团队策略（`teamId` 非空）**只看调用者**当前**在该团队的成员角色。创建者身份不放行任何动作。
   非成员（含已离队 / 被移除的创建者）→ 404，不泄露策略存在；成员但角色不够 → 403 `insufficient_team_role`。
2. **个人策略**只认所有者，其余 404。公开策略与 PolicyShare 的只读 / 执行授予由详情、执行、版本列表入口在 404 之后另行叠加，
   不进矩阵。
3. **团队作用域 API key** 只能访问 key 所属团队的策略：个人策略、其他团队策略一律 404，也不借公开策略越出团队
   （否则调用计入团队 owner 的配额池）。个人 key 与会话同口径。
4. **What-If**：批次以策略所有者 userId 为租户、窗口与执行都按所有者本人收窄（ADR 0034 §4 护栏 3，ADR 0044 记为
   「§4.3 单用户隔离」）。保持属主限定：只有策略创建者能发起 / 查看批次，团队策略另要求创建者当前仍有执行权限。
   其他成员得到 403 `whatif_owner_only`，界面显示「只有创建者能运行」的说明而不是升级引导。改为团队租户口径需另立 ADR。
5. **四眼**：批准 / 驳回要求 `policy.approve`（owner / admin），再叠加 `decideVersionApproval` 的作者不能自审。
6. **成员关系必须新鲜**：`getTeamMemberRole` 与 API key 身份解析的成员查询都并入 `bypassQueryCache()`，
   不吃 Hyperdrive 约 60 s 的查询缓存，移除 / 降级在下一次请求即生效。会话 JWT 不携带团队信息，无需失效会话。

### 3. 矩阵

动作与团队权限的对应（`POLICY_ACTION_PERMISSION`）；✓ 允许，403 角色不够，404 不可见。

| 动作 | 覆盖的入口 | owner | admin | member | viewer | 非成员 / 已离队 | 个人策略所有者 | 他人个人策略 |
|---|---|---|---|---|---|---|---|---|
| view（`policy.view`） | 详情 API 与页面、版本列表 / 详情 / 源码与版本页、执行日志 / 统计 / 最近执行与日志页、条件漏斗、What-If 估算占位、Cedar 导出、证据预览与导出 | ✓ | ✓ | ✓ | ✓ | 404 | ✓ | 404（公开 / 分享可读） |
| execute（`policy.execute`） | 会话执行与执行页、API v1 执行、guard 重新登记、runner-parity 校验 | ✓ | ✓ | ✓ | 403 | 404 | ✓ | 404（公开 / 分享可执行） |
| update（`policy.update`） | 编辑 PUT 与编辑页、新建版本、提交审批、设默认版本、个人策略导入团队 | ✓ | ✓ | ✓ | 403 | 404 | ✓ | 404 |
| share（`policy.update`） | 团队分享管理、复核人管理、复核队列查看（复核人另有只读通道） | ✓ | ✓ | ✓ | 403 | 404 | ✓ | 404 |
| delete（`policy.delete`） | 移入回收站、恢复、永久删除、清空回收站、回收站列表、废弃 / 归档版本 | ✓ | ✓ | 403 | 403 | 404 | ✓ | 404 |
| approve（`policy.approve`） | 批准 / 驳回待审批版本（再叠加四眼：版本作者不能审批）、审批收件箱 | ✓ | ✓ | 403 | 403 | 404 | ✓（可自审，审计标记） | 404 |
| whatif（`policy.execute` + 创建者） | 发起 / 查看 What-If 批次 | 仅创建者 | 仅创建者 | 仅创建者 | 403 | 404 | ✓ | 404 |
| create（`policy.create`，按团队） | `POST /api/policies?teamId=`、`POST /api/teams/:id/policies` | ✓ | ✓ | ✓ | 403 | 403 | — | — |

列表与范围：

- 团队策略列表、团队页计数：只含未删除的策略（#674）。
- 「我的策略」（`GET /api/policies`、策略页、分组计数）：本人创建的策略中，个人策略全部保留，团队策略只保留本人当前仍可查看的。
- API v1 列表：个人 key = 本人个人策略 + 当前可见团队的全部策略；团队 key = 该团队的策略。调用配额按 key 的配额 owner 计
  （ADR 0015 §10），Free 成员的团队 key 不再被自己的 0 额度拦下（#671）。
- 日志、统计、漏斗、证据：团队策略含全部成员的执行；个人策略只含所有者本人的执行（公开 / 分享给他人执行的记录属于执行人）（#673）。
- 回收站：本人的个人策略，加上本人当前有删除权限的团队的策略（团队 owner / admin 共享同一视图，离队即不可见）。

不在本矩阵内：规则回归工具（`/api/admin/rule-regression`）只对平台管理员开放，不属于团队授权。

### 4. 离队后的策略归属

成员离队或被移除时，其创建的团队策略留在团队（`teamId` 不变，`userId` 作为作者字段保留），由团队按角色继续管理；
离队者对它不再有任何访问。冻结（套餐超限）仍按策略所有者（创建者）的套餐判定。

## 后果

- 团队协作按角色矩阵工作：owner / admin / member 能打开、执行、编辑彼此的团队策略，admin 能删除，owner / admin 能审批。
- 行为变化（有意）：member 不能再删除自己创建的团队策略；降为 viewer 后只剩查看；离队后对团队策略 404；
  团队 key 不能再访问个人策略；团队策略的日志 / 证据对全部成员可见并覆盖全部执行。
- What-If 维持属主限定，非创建者看到说明而非升级引导。
- 成本：团队策略的每次授权多一次成员行查询（不走查询缓存）；列表类查询多一个 TeamMember 子查询。

## 被否决的替代方案

- **在各路由补「或团队成员」分支**：此前就是这么做的，结果各入口口径漂移（GET 放行、PUT 404、执行按创建者短路）。
- **创建者保留特权**：与「离队即失去团队资源访问」冲突，也让降级失效。
- **What-If 直接放开给团队成员**：批次在 aster-api 以所有者 userId 为租户、只拉所有者本人的执行，放开只会得到
  「看起来成功、其实只含创建者执行」的结果；需要先按 ADR 0034 改租户口径。
