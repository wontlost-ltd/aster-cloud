-- 版本行记录保存时编译得到的治理档案 id（ADR 0046 §6），详情页直接读库。可空、纯附加：旧版本与未声明档案的版本保持 NULL，不回填。
ALTER TABLE "PolicyVersion" ADD COLUMN IF NOT EXISTS "profile" text;
