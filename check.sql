SELECT
  "businessId",
  "sku",
  COUNT(*) AS count
FROM "items"
WHERE "sku" IS NOT NULL
GROUP BY "businessId", "sku"
HAVING COUNT(*) > 1;

SELECT
  "businessId",
  "barcode",
  COUNT(*) AS count
FROM "items"
WHERE "barcode" IS NOT NULL
GROUP BY "businessId", "barcode"
HAVING COUNT(*) > 1;

SELECT
  "businessId",
  "imei",
  COUNT(*) AS count
FROM "items"
WHERE "imei" IS NOT NULL
GROUP BY "businessId", "imei"
HAVING COUNT(*) > 1;
