-- 005 (SQLite): mirror migrations/020_routing_rules_sample_rate.sql.
--
-- Postgres added an optional `sample_rate` REAL on routing_rules to gate
-- shadow / both-mode firings probabilistically. The SQLite-trial schema
-- forgot the parallel migration, so `getRoutingRules()` (which selects
-- this column unconditionally) raises SQLITE_ERROR ("no such column:
-- sample_rate") on every routed request — every chat request 500s.
--
-- The migration runner records this file in `schema_migrations` after
-- success, so even though SQLite's bare `ALTER TABLE ADD COLUMN` is not
-- itself idempotent, re-application is prevented at the orchestration
-- layer. Same pattern used for migrations-sqlite/004 above.
--
-- We deliberately do NOT add the CHECK constraint that the Postgres
-- side carries (sample_rate IN [0,1]). SQLite supports table-level
-- CHECKs but not naming/conditionally adding them; the constraint is
-- already enforced at the application layer (router.ts clamps the
-- value before use). NULL = legacy "fire on every match" behavior.

ALTER TABLE routing_rules ADD COLUMN sample_rate REAL;
