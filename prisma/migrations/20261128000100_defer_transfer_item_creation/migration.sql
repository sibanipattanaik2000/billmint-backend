-- Ensure dispatchedAt exists on databases where it was
-- previously added manually.
ALTER TABLE "stock_transfers"
ADD COLUMN IF NOT EXISTS "dispatchedAt"
TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Do not create destination products during dispatch.
-- The destination item is assigned when receipt is confirmed.
ALTER TABLE "stock_transfer_items"
ALTER COLUMN "destinationItemId" DROP NOT NULL;