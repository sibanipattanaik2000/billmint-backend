
-- Add the missing optional fields to existing items.
ALTER TABLE "items"
ADD COLUMN "modelName" TEXT;

ALTER TABLE "items"
ADD COLUMN "deviceCode" TEXT;
