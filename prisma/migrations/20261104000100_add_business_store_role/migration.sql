ALTER TABLE "businesses"
ADD COLUMN "store_role" TEXT NOT NULL DEFAULT 'BRANCH';

ALTER TABLE "businesses"
ADD CONSTRAINT "businesses_store_role_check"
CHECK ("store_role" IN ('CENTRAL', 'BRANCH'));

CREATE UNIQUE INDEX "businesses_single_central_store"
ON "businesses" ("store_role")
WHERE "store_role" = 'CENTRAL';