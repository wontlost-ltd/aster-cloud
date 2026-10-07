# Architecture Decision Records (ADRs)

每个 ADR 记录一个**已决策**的架构选择 —— 不是计划、不是 RFC、不是探索文档。
目的：6 个月后新同事 onboard 时，5 分钟读懂"我们为什么这么做"而不必重读
当时的 plan / spike / review thread。

## 与其他文档的关系

| 类型 | 位置 | 内容 | 寿命 |
|------|------|------|------|
| **Plan**（任务计划） | `.claude/plan/<feature>.md` | 一个待办工作的完整规划 + 验收 | 工作完成后归档参考 |
| **Spike report** | `.claude/plan/<feature>-spike-report.md` | 探索性实验的发现 | 决策后即冻结，仅作历史 |
| **ADR**（本目录） | `docs/architecture/decisions/NNNN-title.md` | 一个具体决策 + why + 取舍 + 后果 | **常青**，决策变更时写新 ADR + 标记旧的 superseded |
| **Workstream** | `docs/workstreams/<name>/README.md` | 一个长期议题的跟踪 + 状态 | 议题关闭时归档 |

## ADR 写作规则

1. **一个 ADR = 一个决策**。多决策拆成多个 ADR；引用别人的决策号即可。
2. **可执行的取舍**。不是描述"做了什么"（代码已经在那），而是"为什么这么做，
   而不是另两个选项"。
3. **不超过 2 屏**。如果觉得说不清，本来就该拆。
4. **不重复 plan 内容**。plan 已经写过的细节，链接过去；ADR 只留决策与
   决策依据。
5. **decisions 写完即冻结**。新发现 → 写新 ADR（status: Supersedes ADR-XXXX）。
   不要在旧 ADR 里加"更新"段落 —— 那破坏可审计性。

## 模板

```markdown
# ADR-NNNN: <短标题>

- Status: Accepted | Superseded by ADR-XXXX | Deprecated
- Date: YYYY-MM-DD
- Deciders: <谁拍板>

## Context
（背景：当时遇到什么问题、约束是什么）

## Decision
（明确陈述选了什么；一句话能讲清最好）

## Alternatives considered
（列出认真评估过的其他选项，每个一句话说为什么没选）

## Consequences
（这个决策带来什么 — 包括好和坏；将来怎么知道该重新评估）

## References
- 链接相关 plan / spike report / PR
```

## 当前 ADR

| # | 标题 | Status |
|---|------|--------|
| [0001](./0001-single-source-two-distributions.md) | Single source, two distributions via build-time DEPLOYMENT_MODE | Accepted |
| [0002](./0002-deployment-mode-two-tier-capability-surface.md) | Two-tier capability surface — compile-time constants + runtime CAPABILITIES | Accepted |
| [0003](./0003-deployment-mode-dce-backstop.md) | DCE backstop: DefinePlugin + webpack alias=false + ESLint guard | Accepted |
| [0015](./0015-team-scoped-api-keys.md) | 团队作用域 API key 与 owner 共享配额池 | Proposed |
