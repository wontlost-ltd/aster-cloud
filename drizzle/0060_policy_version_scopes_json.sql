-- 版本行记录封印 source envelope 时所用的词汇段（ADR 0051 §7 第 5 段，canonicalScopesJson；"" = 无词汇），
-- 使 envelope 可按落库输入原样重算，不受之后词条编辑或审批冻结影响。可空、纯附加：
-- 旧行保持 NULL，由 resolver 迁移（ADR 0051 §9）重算 envelope 时一并回填。
ALTER TABLE "PolicyVersion" ADD COLUMN IF NOT EXISTS "sourceScopesJson" text;
