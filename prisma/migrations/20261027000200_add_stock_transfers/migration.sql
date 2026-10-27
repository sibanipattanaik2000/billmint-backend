CREATE TYPE "StockTransferStatus" AS ENUM (
  'DRAFT',
  'COMPLETED',
  'CANCELLED'
);

CREATE TABLE "stock_transfers" (
  "id" TEXT NOT NULL,
  "fromBusinessId" TEXT NOT NULL,
  "toBusinessId" TEXT NOT NULL,
  "transferNumber" TEXT NOT NULL,
  "status" "StockTransferStatus" NOT NULL DEFAULT 'COMPLETED',
  "notes" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stock_transfers_fromBusinessId_fkey"
    FOREIGN KEY ("fromBusinessId")
    REFERENCES "businesses"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stock_transfers_toBusinessId_fkey"
    FOREIGN KEY ("toBusinessId")
    REFERENCES "businesses"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "stock_transfer_items" (
  "id" TEXT NOT NULL,
  "transferId" TEXT NOT NULL,
  "sourceItemId" TEXT NOT NULL,
  "destinationItemId" TEXT NOT NULL,
  "quantity" DECIMAL(18,3) NOT NULL,
  "inventoryUnitIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "stock_transfer_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stock_transfer_items_transferId_fkey"
    FOREIGN KEY ("transferId")
    REFERENCES "stock_transfers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "stock_transfer_items_sourceItemId_fkey"
    FOREIGN KEY ("sourceItemId")
    REFERENCES "items"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stock_transfer_items_destinationItemId_fkey"
    FOREIGN KEY ("destinationItemId")
    REFERENCES "items"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "stock_transfers_fromBusinessId_transferNumber_key"
  ON "stock_transfers"("fromBusinessId", "transferNumber");

CREATE INDEX "stock_transfers_fromBusinessId_createdAt_idx"
  ON "stock_transfers"("fromBusinessId", "createdAt");

CREATE INDEX "stock_transfers_toBusinessId_createdAt_idx"
  ON "stock_transfers"("toBusinessId", "createdAt");

CREATE INDEX "stock_transfers_status_idx"
  ON "stock_transfers"("status");

CREATE INDEX "stock_transfer_items_transferId_idx"
  ON "stock_transfer_items"("transferId");

CREATE INDEX "stock_transfer_items_sourceItemId_idx"
  ON "stock_transfer_items"("sourceItemId");

CREATE INDEX "stock_transfer_items_destinationItemId_idx"
  ON "stock_transfer_items"("destinationItemId");