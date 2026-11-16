CREATE TABLE "CapabilityGrant" (
	"id" text PRIMARY KEY NOT NULL,
	"capability" text NOT NULL,
	"userId" text,
	"teamId" text,
	"delegatingTeamId" text,
	"source" text NOT NULL,
	"grantedBy" text,
	"grantedAt" timestamp DEFAULT now() NOT NULL,
	"revokedAt" timestamp,
	"revokedBy" text,
	"revokeReason" text,
	"note" text,
	CONSTRAINT "CapabilityGrant_subject_ck" CHECK (num_nonnulls("CapabilityGrant"."userId", "CapabilityGrant"."teamId") = 1),
	CONSTRAINT "CapabilityGrant_delegation_ck" CHECK (("CapabilityGrant"."source" = 'team_owner') = ("CapabilityGrant"."delegatingTeamId" IS NOT NULL) AND ("CapabilityGrant"."delegatingTeamId" IS NULL OR "CapabilityGrant"."userId" IS NOT NULL)),
	CONSTRAINT "CapabilityGrant_source_ck" CHECK ("CapabilityGrant"."source" IN ('platform_admin', 'team_owner', 'migration')),
	CONSTRAINT "CapabilityGrant_note_len_ck" CHECK ("CapabilityGrant"."note" IS NULL OR char_length("CapabilityGrant"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "CapabilityTeamAllotment" (
	"capability" text NOT NULL,
	"teamId" text NOT NULL,
	"seatCap" integer NOT NULL,
	"ownerGrantingEnabled" boolean DEFAULT true NOT NULL,
	"updatedBy" text,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "CapabilityTeamAllotment_capability_teamId_pk" PRIMARY KEY("capability","teamId"),
	CONSTRAINT "CapabilityTeamAllotment_seatCap_ck" CHECK ("CapabilityTeamAllotment"."seatCap" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
ALTER TABLE "CapabilityGrant" ADD CONSTRAINT "CapabilityGrant_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "CapabilityGrant" ADD CONSTRAINT "CapabilityGrant_grantedBy_User_id_fk" FOREIGN KEY ("grantedBy") REFERENCES "public"."User"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "CapabilityGrant_active_user_unique" ON "CapabilityGrant" USING btree ("capability","userId",COALESCE("delegatingTeamId", '')) WHERE "CapabilityGrant"."revokedAt" IS NULL AND "CapabilityGrant"."userId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "CapabilityGrant_active_team_unique" ON "CapabilityGrant" USING btree ("capability","teamId") WHERE "CapabilityGrant"."revokedAt" IS NULL AND "CapabilityGrant"."teamId" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "CapabilityGrant_user_active_idx" ON "CapabilityGrant" USING btree ("capability","userId") WHERE "CapabilityGrant"."revokedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "CapabilityGrant_team_active_idx" ON "CapabilityGrant" USING btree ("capability","teamId") WHERE "CapabilityGrant"."revokedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "CapabilityGrant_delegating_active_idx" ON "CapabilityGrant" USING btree ("delegatingTeamId") WHERE "CapabilityGrant"."revokedAt" IS NULL;