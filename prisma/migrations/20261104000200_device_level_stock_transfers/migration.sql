ALTER TYPE "InventoryUnitStatus"
ADD VALUE IF NOT EXISTS 'IN_TRANSIT';

ALTER TYPE "StockTransferStatus"
ADD VALUE IF NOT EXISTS 'DISPATCHED';

ALTER TYPE "StockTransferStatus"
ADD VALUE IF NOT EXISTS 'PARTIALLY_RECEIVED';

ALTER TYPE "StockTransferStatus"
ADD VALUE IF NOT EXISTS 'RECEIVED';

CREATE TYPE "TransferUnitStatus" AS ENUM (
  'PENDING',
  'RECEIVED'
);

ALTER TABLE "inventory_units"
ADD COLUMN "barcode" TEXT,
ADD COLUMN "sourceCode" TEXT;

CREATE UNIQUE INDEX "inventory_units_businessId_barcode_key"
ON "inventory_units" ("businessId", "barcode");

ALTER TABLE "stock_transfers"
ALTER COLUMN "receivedAt" DROP NOT NULL,
ALTER COLUMN "receivedAt" DROP DEFAULT;

ALTER TABLE "stock_transfers"
ALTER COLUMN "status" SET DEFAULT 'DISPATCHED';

CREATE TABLE "stock_transfer_units" (
  "id" TEXT NOT NULL,
  "transferItemId" TEXT NOT NULL,
  "inventoryUnitId" TEXT NOT NULL,
  "status" "TransferUnitStatus" NOT NULL DEFAULT 'PENDING',
  "barcode" TEXT,
  "receivedAt" TIMESTAMP(3),
  "receivedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "stock_transfer_units_pkey"
    PRIMARY KEY ("id"),

  CONSTRAINT "stock_transfer_units_transferItemId_fkey"
    FOREIGN KEY ("transferItemId")
    REFERENCES "stock_transfer_items"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "stock_transfer_units_inventoryUnitId_fkey"
    FOREIGN KEY ("inventoryUnitId")
    REFERENCES "inventory_units"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "stock_transfer_units_transferItemId_inventoryUnitId_key"
ON "stock_transfer_units" ("transferItemId", "inventoryUnitId");

CREATE INDEX "stock_transfer_units_inventoryUnitId_idx"
ON "stock_transfer_units" ("inventoryUnitId");

CREATE INDEX "stock_transfer_units_status_idx"
ON "stock_transfer_units" ("status");