-- Normalize existing emails before enforcing uniqueness.
UPDATE "users"
SET "email" = NULL
WHERE "email" IS NOT NULL
  AND BTRIM("email") = '';

UPDATE "users"
SET "email" = LOWER(BTRIM("email"))
WHERE "email" IS NOT NULL;

-- Stop safely if existing accounts share an email.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "users"
    WHERE "email" IS NOT NULL
    GROUP BY "email"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Duplicate user emails exist. Resolve duplicate accounts before applying this migration.';
  END IF;
END $$;

CREATE UNIQUE INDEX "users_email_key"
ON "users" ("email");