-- ADR 0060 §6.2：版本内嵌词汇，确定性序列化，建版本时写入、之后不改（与 aliasSet 同生命周期）。
-- text 而非 jsonb：jsonb 会重排键，序列化不可复现。NULL=无内嵌词条；上限 8192 字节（octet_length 按 UTF-8 字节计）。
-- 纯新增可空列，旧代码不读，无迁移窗口问题。
ALTER TABLE "PolicyVersion" ADD COLUMN "embeddedVocabulary" text;--> statement-breakpoint
ALTER TABLE "PolicyVersion" ADD CONSTRAINT "PolicyVersion_embeddedVocabulary_size_check" CHECK ("PolicyVersion"."embeddedVocabulary" IS NULL OR octet_length("PolicyVersion"."embeddedVocabulary") <= 8192);
