
-- Create shelf locations
CREATE TABLE "shelf_locations" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shelf_locations_pkey" PRIMARY KEY ("id")
);

-- Each business can have only one shelf with a given name
CREATE UNIQUE INDEX "shelf_locations_businessId_name_key"
ON "shelf_locations"("businessId", "name");

CREATE INDEX "shelf_locations_businessId_isActive_idx"
ON "shelf_locations"("businessId", "isActive");

-- Create per-shelf item stock
CREATE TABLE "shelf_stocks" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "shelfId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shelf_stocks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shelf_stocks_shelfId_itemId_key"
ON "shelf_stocks"("shelfId", "itemId");

CREATE INDEX "shelf_stocks_businessId_itemId_idx"
ON "shelf_stocks"("businessId", "itemId");

CREATE INDEX "shelf_stocks_businessId_shelfId_idx"
ON "shelf_stocks"("businessId", "shelfId");

-- Create shelf movement history
CREATE TABLE "shelf_movements" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "fromShelfId" TEXT,
    "toShelfId" TEXT,
    "quantity" DECIMAL(18,3) NOT NULL,
    "movementType" TEXT NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "reason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shelf_movements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "shelf_movements_businessId_itemId_createdAt_idx"
ON "shelf_movements"("businessId", "itemId", "createdAt");

CREATE INDEX "shelf_movements_businessId_fromShelfId_idx"
ON "shelf_movements"("businessId", "fromShelfId");

CREATE INDEX "shelf_movements_businessId_toShelfId_idx"
ON "shelf_movements"("businessId", "toShelfId");

CREATE INDEX "shelf_movements_referenceType_referenceId_idx"
ON "shelf_movements"("referenceType", "referenceId");

-- Foreign keys
ALTER TABLE "shelf_locations"
ADD CONSTRAINT "shelf_locations_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "businesses"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shelf_stocks"
ADD CONSTRAINT "shelf_stocks_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "businesses"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shelf_stocks"
ADD CONSTRAINT "shelf_stocks_shelfId_fkey"
FOREIGN KEY ("shelfId") REFERENCES "shelf_locations"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "shelf_stocks"
ADD CONSTRAINT "shelf_stocks_itemId_fkey"
FOREIGN KEY ("itemId") REFERENCES "items"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "shelf_movements"
ADD CONSTRAINT "shelf_movements_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "businesses"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shelf_movements"
ADD CONSTRAINT "shelf_movements_itemId_fkey"
FOREIGN KEY ("itemId") REFERENCES "items"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "shelf_movements"
ADD CONSTRAINT "shelf_movements_fromShelfId_fkey"
FOREIGN KEY ("fromShelfId") REFERENCES "shelf_locations"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "shelf_movements"
ADD CONSTRAINT "shelf_movements_toShelfId_fkey"
FOREIGN KEY ("toShelfId") REFERENCES "shelf_locations"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
