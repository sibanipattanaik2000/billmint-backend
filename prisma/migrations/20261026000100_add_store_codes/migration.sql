
CREATE SEQUENCE IF NOT EXISTS business_store_code_seq START WITH 1;

ALTER TABLE "businesses"
ADD COLUMN IF NOT EXISTS "storeCode" TEXT;

UPDATE "businesses"
SET "storeCode" = 'STR' || LPAD(
  NEXTVAL('business_store_code_seq')::TEXT,
  6,
  '0'
)
WHERE "storeCode" IS NULL;

ALTER TABLE "businesses"
ALTER COLUMN "storeCode"
SET DEFAULT (
  'STR' || LPAD(
    NEXTVAL('business_store_code_seq')::TEXT,
    6,
    '0'
  )
);

ALTER TABLE "businesses"
ALTER COLUMN "storeCode" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "businesses_storeCode_key"
ON "businesses" ("storeCode");

ALTER TABLE "items"
ADD COLUMN IF NOT EXISTS "sourceStoreCode" TEXT;
