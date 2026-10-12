SELECT
    current_database() AS database_name,
    current_schema() AS schema_name,
    current_user AS database_user,
    COUNT(*) AS migration_count,
    STRING_AGG(migration_name, ', ' ORDER BY started_at) AS migration_names
FROM public._prisma_migrations;
