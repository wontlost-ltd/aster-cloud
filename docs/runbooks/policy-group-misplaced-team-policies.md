# 团队策略的历史违规分组放置：核查与清理（#712）

放置规则（ADR 0016，`canPlaceInGroup`）：团队策略只能放进同一团队的分组。#710 之前的放入入口、以及 #712 之前删除私有分组时的级联迁移，都可能把团队策略放进私有分组或别的团队分组。现在所有入口都已走放置规则，这里只处理遗留数据。

1. 只读核查：执行 [`sql/policy-group-misplaced-check.sql`](sql/policy-group-misplaced-check.sql)，列出违规行（策略、所属团队、所在分组及其团队）。
2. 可选清理：确认清单后执行 [`sql/policy-group-misplaced-cleanup.sql`](sql/policy-group-misplaced-cleanup.sql)，把这些策略移到「未分组」。只改 `groupId`，幂等，可重复执行；再跑一次核查应为空。

两份 SQL 都由 `team-policy-authz.integration.test.ts` 直接执行验证。回滚：清理前保存核查结果（`policyId`、`groupId`），需要时按清单把 `groupId` 写回。
