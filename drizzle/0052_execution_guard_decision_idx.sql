-- guard 决策反查发起执行（ADR 0042 §5.3）：审批已决通知按 metadata->>'guardDecisionId' 查执行行。
-- 表达式部分索引：只收录已登记决策的行，未登记/旧行（metadata 为 null）不占索引。
CREATE INDEX IF NOT EXISTS "Execution_guardDecisionId_idx" ON "Execution" ((metadata->>'guardDecisionId')) WHERE metadata->>'guardDecisionId' IS NOT NULL;
