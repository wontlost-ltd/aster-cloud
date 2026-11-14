CREATE TABLE "GuardPolicyDeployment" (
	"policyId" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"generation" bigint NOT NULL,
	"desiredVersionId" text,
	"appliedGeneration" bigint,
	"lastError" text,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL
);
