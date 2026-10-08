-- ADR 0042 §2.1：业务角色挂在团队成员上（个人租户挂在用户上），默认空。
ALTER TABLE "TeamMember" ADD COLUMN IF NOT EXISTS "businessRoles" text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "businessRoles" text[] NOT NULL DEFAULT '{}';
