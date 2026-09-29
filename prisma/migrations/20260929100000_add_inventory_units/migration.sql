-- CreateEnum
CREATE TYPE "InventoryUnitStatus" AS ENUM (
    'AVAILABLE',
    'RESERVED',
    'SOLD',
    'RETURNED',
    'DAMAGED',
    'LOST'
);

-- CreateTable
CREATE TABLE "inventory_units" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "serialNumber" TEXT,
    "imei" TEXT,
    "status" "InventoryUnitStatus" NOT NULL DEFAULT 'AVAILABLE',
    "purchaseId" TEXT,
    "purchaseItemId" TEXT,
    "saleId" TEXT,
    "saleItemId" TEXT,
    "purchasePrice" DECIMAL(18,2),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "soldAt" TIMESTAMP(3),

    CONSTRAINT "inventory_units_pkey" PRIMARY KEY ("id")
);

-- Unique constraints
CREATE UNIQUE INDEX "inventory_units_businessId_imei_key"
ON "inventory_units"("businessId", "imei");

CREATE UNIQUE INDEX "inventory_units_businessId_serialNumber_key"
ON "inventory_units"("businessId", "serialNumber");

-- Indexes
CREATE INDEX "inventory_units_businessId_itemId_idx"
ON "inventory_units"("businessId", "itemId");

CREATE INDEX "inventory_units_businessId_status_idx"
ON "inventory_units"("businessId", "status");

CREATE INDEX "inventory_units_itemId_status_idx"
ON "inventory_units"("itemId", "status");

CREATE INDEX "inventory_units_saleId_idx"
ON "inventory_units"("saleId");

CREATE INDEX "inventory_units_purchaseId_idx"
ON "inventory_units"("purchaseId");

-- Foreign keys
ALTER TABLE "inventory_units"
ADD CONSTRAINT "inventory_units_businessId_fkey"
FOREIGN KEY ("businessId")
REFERENCES "businesses"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "inventory_units"
ADD CONSTRAINT "inventory_units_itemId_fkey"
FOREIGN KEY ("itemId")
REFERENCES "items"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;