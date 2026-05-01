-- 017: Remove the well-known dev seed API key from production installs.
--
-- Background. `001_init.sql` seeds a hardcoded `tokensmart-dev-key` API key
-- attached to a hardcoded seed project (`00000000-0000-0000-0000-000000000001`)
-- so `bun run dev` works out of the box. The README, QUICKSTART, install.sh,
-- and several integration guides all reference this key as the local
-- dev convenience. That's fine for development.
--
-- The problem is the same seed runs on a brand-new production install. If
-- an operator deploys via `docker-compose.prod.yml` without flipping
-- `TOKENSMART_AUTH_ENABLED=1` (the default is off — single-tenant mode),
-- anyone who has read the public README knows a working API key for that
-- gateway and can drive the operator's upstream provider keys until a
-- budget cap kicks in (the seed project ships with no budget, so the cap
-- is whatever the operator wired at the env / plan layer — likely none on
-- a self-hosted single-tenant box).
--
-- Fix at the seam between dev and prod, not at the seed insert site:
--   * `apps/gateway/src/migrate.ts` sets `tokensmart.allow_dev_seed = 'true'`
--     on every migration transaction iff `NODE_ENV !== 'production'`.
--   * This DO block runs on every boot. If the GUC is anything other
--     than 'true' (production, or NODE_ENV unset) it deletes the seed
--     row by both `key` (legacy plaintext) and `key_hash` (post-002
--     hashed form) so it works regardless of which migrations the
--     install has previously seen.
--   * The seed PROJECT row is NOT deleted — it might have been claimed
--     by the first-ever real user via the "claim unowned projects"
--     codepath (`db.ts` first-login claim). Deleting the credential
--     closes the security hole; deleting the project row could orphan
--     real data.
--
-- Idempotent: production runs delete + then nothing on subsequent boots.
-- Dev runs are no-ops every boot.

DO $$
DECLARE
    deleted_count INTEGER;
BEGIN
    IF current_setting('tokensmart.allow_dev_seed', true) IS DISTINCT FROM 'true' THEN
        DELETE FROM api_keys
         WHERE key = 'tokensmart-dev-key'
            OR key_hash = ENCODE(DIGEST('tokensmart-dev-key', 'sha256'), 'hex');
        GET DIAGNOSTICS deleted_count = ROW_COUNT;
        IF deleted_count > 0 THEN
            RAISE NOTICE '[017] Removed % dev seed API key row(s) (production mode).', deleted_count;
        END IF;
    END IF;
END $$;
