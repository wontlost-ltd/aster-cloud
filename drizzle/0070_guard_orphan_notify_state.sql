CREATE TABLE "GuardOrphanEmailState" (
	"tenantId" text NOT NULL,
	"userId" text NOT NULL,
	"lastEmailAt" timestamp (3) NOT NULL,
	CONSTRAINT "GuardOrphanEmailState_tenantId_userId_pk" PRIMARY KEY("tenantId","userId")
);
--> statement-breakpoint
CREATE TABLE "GuardOrphanNotifyState" (
	"tenantId" text PRIMARY KEY NOT NULL,
	"notifiedThroughId" bigint DEFAULT 0 NOT NULL,
	"lastNoticeAt" timestamp (3),
	"pendingSince" timestamp (3),
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL
);
