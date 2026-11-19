CREATE TABLE "PolicyVersionLayout" (
	"policyVersionId" text PRIMARY KEY NOT NULL,
	"formatVersion" integer NOT NULL,
	"layout" text NOT NULL,
	"layoutSha256" text NOT NULL,
	"sourceSha256" text NOT NULL,
	"createdBy" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "PolicyVersionLayout_format_ck" CHECK ("PolicyVersionLayout"."formatVersion" = 1),
	CONSTRAINT "PolicyVersionLayout_layout_sha_ck" CHECK ("PolicyVersionLayout"."layoutSha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "PolicyVersionLayout_source_sha_ck" CHECK ("PolicyVersionLayout"."sourceSha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "PolicyVersionLayout_size_ck" CHECK (octet_length("PolicyVersionLayout"."layout") <= 49152)
);
--> statement-breakpoint
ALTER TABLE "PolicyVersionLayout" ADD CONSTRAINT "PolicyVersionLayout_policyVersionId_PolicyVersion_id_fk" FOREIGN KEY ("policyVersionId") REFERENCES "public"."PolicyVersion"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ============ ADR 0058 §7.2 / 裁决 R8：只插入 ============
-- UPDATE 一律拒绝；DELETE 只在父 PolicyVersion 行已不存在时放行。
-- 外键级联删除由父表的 RI 触发器在父行删除之后执行，此时父行已不可见，因而放行；
-- 对本表的直接 DELETE 时父行仍在，因而拒绝。不依赖 pg_trigger_depth() 这类隐式语义。
CREATE OR REPLACE FUNCTION "policy_version_layout_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'append-only: UPDATE on PolicyVersionLayout is forbidden';
  END IF;
  IF EXISTS (SELECT 1 FROM "PolicyVersion" WHERE "id" = OLD."policyVersionId") THEN
    RAISE EXCEPTION 'append-only: direct DELETE on PolicyVersionLayout is forbidden';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "PolicyVersionLayout_guard" ON "PolicyVersionLayout";--> statement-breakpoint
CREATE TRIGGER "PolicyVersionLayout_guard"
  BEFORE UPDATE OR DELETE ON "PolicyVersionLayout"
  FOR EACH ROW EXECUTE FUNCTION "policy_version_layout_guard"();
